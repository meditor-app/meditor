// #31: opening a location reads everything before the editor takes any of it over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLocation, latest, defaultFile, sameRepo } from '../src/nav.js';

const R1 = { owner: 'o1', name: 'r1', defaultBranch: 'main', canPush: true };
const R2 = { owner: 'o2', name: 'r2', defaultBranch: 'main', canPush: false };

/** A fake GitHub: `files` maps 'owner/name@ref:path' to text, or to an Error to throw. */
function fakeGh({ repos = [R1, R2], trees = {}, files = {}, branches = {} } = {}) {
  const calls = [];
  return {
    calls,
    async repo(owner, name) {
      calls.push(`repo ${owner}/${name}`);
      const r = repos.find((x) => sameRepo(x, { owner, name }));
      if (!r) throw new Error('Not found');
      return r;
    },
    async branches(owner, name) {
      calls.push(`branches ${owner}/${name}`);
      const b = branches[`${owner}/${name}`];
      if (b instanceof Error) throw b;
      return b || [{ name: 'main', sha: 's' }];
    },
    async tree(owner, name, ref) {
      calls.push(`tree ${owner}/${name}@${ref}`);
      const t = trees[`${owner}/${name}@${ref}`];
      if (!t) throw new Error('No such branch');
      return { truncated: false, entries: t };
    },
    async getFile(owner, name, path, ref) {
      calls.push(`file ${owner}/${name}@${ref}:${path}`);
      const f = files[`${owner}/${name}@${ref}:${path}`];
      if (f instanceof Error) throw f;
      return f === undefined ? null : { text: f, sha: 'sha-' + path };
    },
  };
}

const file = (path) => ({ path, type: 'file' });

test('a file that fails to load after a repository change leaves nothing half-switched', async () => {
  // the issue's example: o1/r1 README.md is open; o2/r2's docs.md is a directory
  const gh = fakeGh({
    trees: { 'o2/r2@main': [file('README.md'), { path: 'docs.md', type: 'dir' }] },
    files: { 'o2/r2@main:docs.md': new Error('docs.md is not a file') },
  });
  const cur = {
    repo: R1,
    tree: { truncated: false, entries: [file('README.md')], ref: 'main' },
    loc: { owner: 'o1', name: 'r1', ref: 'main', path: 'README.md' },
  };
  const before = structuredClone(cur);
  await assert.rejects(loadLocation(gh, cur, { owner: 'o2', name: 'r2', ref: 'main', path: 'docs.md' }), /not a file/);
  assert.deepEqual(cur, before, 'the current repository, tree and file are untouched');
});

test('on success the repository, tree and file arrive together, all of the new location', async () => {
  const gh = fakeGh({
    trees: { 'o2/r2@main': [file('README.md'), file('docs/a.md')] },
    files: { 'o2/r2@main:docs/a.md': '# A' },
  });
  const cur = { repo: R1, tree: { entries: [], ref: 'main' }, loc: { owner: 'o1', name: 'r1', ref: 'main', path: 'README.md' } };
  const r = await loadLocation(gh, cur, { owner: 'o2', name: 'r2', ref: 'main', path: 'docs/a.md' });
  assert.equal(r.repo, R2);
  assert.equal(r.tree.ref, 'main');
  assert.deepEqual(r.loc, { owner: 'o2', name: 'r2', ref: 'main', path: 'docs/a.md' });
  assert.equal(r.file.text, '# A');
  assert.equal(r.same, false);
  assert.deepEqual(await r.branches, [{ name: 'main', sha: 's' }]);
});

test('the default branch and README are filled in, a missing file is new, a dead tree is empty', async () => {
  const gh = fakeGh({ trees: { 'o2/r2@main': [file('docs/x.md'), file('Readme.md')] }, files: { 'o2/r2@main:Readme.md': 'hi' } });
  const r = await loadLocation(gh, { repo: null, tree: null, loc: null }, { owner: 'O2', name: 'R2' });
  assert.deepEqual(r.loc, { owner: 'o2', name: 'r2', ref: 'main', path: 'Readme.md' });
  assert.equal(r.file.text, 'hi');

  const n = await loadLocation(gh, { repo: null, tree: null, loc: null }, { owner: 'o2', name: 'r2', ref: 'main', path: 'new.md' });
  assert.equal(n.file, null);

  // a branch without a file list and no path: nothing to open, but nothing fails
  const e = await loadLocation(gh, { repo: null, tree: null, loc: null }, { owner: 'o2', name: 'r2', ref: 'gone' });
  assert.deepEqual(e.tree, { truncated: false, entries: [], ref: 'gone' });
  assert.equal(e.loc.path, undefined);
  assert.equal(e.file, undefined);
});

test('within the repository the tree is reused, and the open file is not read again', async () => {
  const gh = fakeGh();
  const tree = { truncated: false, entries: [file('a.md')], ref: 'main' };
  const loc = { owner: 'o1', name: 'r1', ref: 'main', path: 'a.md' };
  const r = await loadLocation(gh, { repo: R1, tree, loc }, { ...loc });
  assert.equal(r.tree, tree);
  assert.equal(r.same, true);
  assert.equal(r.branches, null);
  assert.deepEqual(gh.calls, []);
});

test('a repository that cannot be read rejects before anything else is asked', async () => {
  const gh = fakeGh();
  await assert.rejects(loadLocation(gh, { repo: R1, tree: null, loc: null }, { owner: 'x', name: 'y', ref: 'main', path: 'a.md' }));
  assert.deepEqual(gh.calls, ['repo x/y']);
});

test('a failed branch list does not fail the location (and never rejects unhandled)', async () => {
  const gh = fakeGh({ trees: { 'o2/r2@main': [file('a.md')] }, files: { 'o2/r2@main:a.md': 'x' }, branches: { 'o2/r2': new Error('rate limit') } });
  const r = await loadLocation(gh, { repo: null, tree: null, loc: null }, { owner: 'o2', name: 'r2', ref: 'main', path: 'a.md' });
  assert.equal(await r.branches, null);
});

test('a slow branch list of a previous repository is dropped', async () => {
  // the issue's example: A's list (many pages) arrives after B's
  const branches = latest();
  let shown = null;
  const apply = (current, list) => { if (current()) shown = list; };
  const forA = branches.begin();
  const forB = branches.begin();
  apply(forB, ['b-main']);
  apply(forA, ['a-1', 'a-2']);
  assert.deepEqual(shown, ['b-main']);
});

test('defaultFile prefers the README, then a top-level file', () => {
  assert.equal(defaultFile([file('docs/a.md'), file('README.markdown')]), 'README.markdown');
  assert.equal(defaultFile([file('docs/a.md'), file('b.md')]), 'b.md');
  assert.equal(defaultFile([file('docs/a.md'), file('x.txt')]), 'docs/a.md');
  assert.equal(defaultFile([file('x.txt')]), undefined);
});
