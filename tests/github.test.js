import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, encodeBase64, decodeBase64, bytesToBase64 } from '../src/github.js';
import {
  parseFragment, formatFragment, parseGitHubUrl, splitRefPath, resolveRef, joinPath, githubUrl,
  addRecent, removeRecent, renameRecent, ago,
} from '../src/links.js';

function fake(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
    const key = `${init.method} ${url.replace('https://api.github.com', '')}`;
    const r = routes[key];
    if (!r) return { ok: false, status: 404, headers: new Map(), json: async () => ({ message: 'Not Found' }) };
    const { status = 200, body, headers = {} } = typeof r === 'function' ? r(init) : r;
    return {
      ok: status < 300, status, headers: new Map(Object.entries(headers)),
      json: async () => body, text: async () => body,
    };
  };
  f.calls = calls;
  return f;
}

test('base64 round-trips UTF-8', () => {
  const s = 'Příliš žluťoučký kůň 🐎\n';
  assert.equal(decodeBase64(encodeBase64(s)), s);
  assert.equal(decodeBase64('SGVs\nbG8='), 'Hello');
});

test('reads a file, and sends the token', async () => {
  const f = fake({
    'GET /repos/o/r/contents/docs/a%20b.md?ref=main': { body: { type: 'file', sha: 's1', encoding: 'base64', content: encodeBase64('# hi') } },
  });
  const gh = new GitHub('T', f);
  assert.deepEqual(await gh.getFile('o', 'r', 'docs/a b.md', 'main'), { text: '# hi', sha: 's1' });
  assert.equal(f.calls[0].headers.Authorization, 'Bearer T');
  assert.equal(await gh.getFile('o', 'r', 'missing.md', 'main'), null);
});

test('commits a file with the sha it replaces', async () => {
  const f = fake({
    'PUT /repos/o/r/contents/README.md': { body: { content: { sha: 'new' }, commit: { sha: 'c1', html_url: 'u' } } },
  });
  const gh = new GitHub('T', f);
  const r = await gh.putFile('o', 'r', 'README.md', { text: 'é', message: 'm', branch: 'main', sha: 'old' });
  assert.deepEqual(r, { sha: 'new', commit: { sha: 'c1', html_url: 'u' } });
  assert.deepEqual(f.calls[0].body, { message: 'm', content: encodeBase64('é'), branch: 'main', sha: 'old' });
});

test('a conflict is explained', async () => {
  const gh = new GitHub('T', fake({ 'PUT /repos/o/r/contents/a.md': { status: 409, body: { message: 'sha mismatch' } } }));
  await assert.rejects(gh.putFile('o', 'r', 'a.md', { text: '', message: 'm', branch: 'b', sha: 'x' }),
    (e) => e.status === 409 && /changed on GitHub/.test(e.message));
});

// The Git Data API as commitChanges uses it, for a branch `main` at commit c0 (tree t0).
function gitRoutes(extra = {}) {
  let blob = 0;
  return {
    'GET /repos/o/r/git/ref/heads/main': { body: { object: { sha: 'c0' } } },
    'GET /repos/o/r/git/commits/c0': { body: { sha: 'c0', tree: { sha: 't0' } } },
    'POST /repos/o/r/git/blobs': () => ({ status: 201, body: { sha: `b${++blob}` } }),
    'POST /repos/o/r/git/trees': { status: 201, body: { sha: 't1' } },
    'POST /repos/o/r/git/commits': { status: 201, body: { sha: 'c1', html_url: 'https://github.com/o/r/commit/c1' } },
    'PATCH /repos/o/r/git/refs/heads/main': { body: { object: { sha: 'c1' } } },
    ...extra,
  };
}

test('commits several files in one commit', async () => {
  const f = fake(gitRoutes());
  const png = bytesToBase64(new Uint8Array([137, 80, 78, 71]));
  const r = await new GitHub('T', f).commitChanges('o', 'r', 'main', {
    message: 'Add a picture',
    changes: [{ path: 'docs/a.md', text: 'é' }, { path: 'docs/images/a-1.png', blobBase64: png }, { path: 'old.md', delete: true }],
  });
  assert.deepEqual(r, { sha: 'c1', html_url: 'https://github.com/o/r/commit/c1', blobs: { 'docs/a.md': 'b1', 'docs/images/a-1.png': 'b2' } });
  const by = (k) => f.calls.filter((c) => `${c.method} ${c.url.replace('https://api.github.com', '')}` === k);
  assert.deepEqual(by('POST /repos/o/r/git/blobs').map((c) => c.body), [
    { content: encodeBase64('é'), encoding: 'base64' }, { content: 'iVBORw==', encoding: 'base64' },
  ]);
  assert.deepEqual(by('POST /repos/o/r/git/trees')[0].body, {
    base_tree: 't0',
    tree: [
      { path: 'docs/a.md', mode: '100644', type: 'blob', sha: 'b1' },
      { path: 'docs/images/a-1.png', mode: '100644', type: 'blob', sha: 'b2' },
      { path: 'old.md', mode: '100644', type: 'blob', sha: null },
    ],
  });
  assert.deepEqual(by('POST /repos/o/r/git/commits')[0].body, { message: 'Add a picture', tree: 't1', parents: ['c0'] });
  assert.deepEqual(by('PATCH /repos/o/r/git/refs/heads/main')[0].body, { sha: 'c1', force: false });
});

test('a move reuses the blob and keeps the mode, and checks both paths first', async () => {
  const f = fake(gitRoutes({
    'GET /repos/o/r/contents/a.md?ref=c0': { body: { type: 'file', sha: 's1' } },
  }));
  await new GitHub('T', f).commitChanges('o', 'r', 'main', {
    message: 'Rename a.md to b/c.md',
    changes: [{ path: 'a.md', delete: true, expect: 's1' }, { path: 'b/c.md', sha: 's1', mode: '100755', expect: null }],
  });
  assert.ok(!f.calls.some((c) => c.url.endsWith('/git/blobs')), 'no new blob');
  assert.ok(f.calls.some((c) => c.url.endsWith('/contents/b/c.md?ref=c0')), 'looked for the new path');
  const tree = f.calls.find((c) => c.url.endsWith('/git/trees')).body.tree;
  assert.deepEqual(tree, [
    { path: 'a.md', mode: '100644', type: 'blob', sha: null },
    { path: 'b/c.md', mode: '100755', type: 'blob', sha: 's1' },
  ]);
});

test('a file changed meanwhile, or taken, is refused before anything is written', async () => {
  const f = fake(gitRoutes({
    'GET /repos/o/r/contents/a.md?ref=c0': { body: { type: 'file', sha: 'theirs' } },
    'GET /repos/o/r/contents/b.md?ref=c0': { body: { type: 'file', sha: 'x' } },
  }));
  const gh = new GitHub('T', f);
  await assert.rejects(gh.commitChanges('o', 'r', 'main', { message: 'm', changes: [{ path: 'a.md', text: 'mine', expect: 'ours' }] }),
    (e) => e.status === 409 && e.body.path === 'a.md' && /changed on GitHub/.test(e.message));
  await assert.rejects(gh.commitChanges('o', 'r', 'main', { message: 'm', changes: [{ path: 'b.md', sha: 's', expect: null }] }),
    (e) => e.status === 409 && /already exists/.test(e.message));
  assert.ok(!f.calls.some((c) => c.method !== 'GET'), 'nothing written');
});

test('a branch that moves is refused cleanly, not forced', async () => {
  const gh = new GitHub('T', fake(gitRoutes({
    'PATCH /repos/o/r/git/refs/heads/main': { status: 422, body: { message: 'Update is not a fast forward' } },
  })));
  await assert.rejects(gh.commitChanges('o', 'r', 'main', { message: 'm', changes: [{ path: 'a.md', text: 'x' }] }),
    (e) => e.status === 409 && e.body.moved && /nothing was committed/.test(e.message));
  const f = fake(gitRoutes());
  await assert.rejects(new GitHub('T', f).commitChanges('o', 'r', 'main', { message: 'm', changes: [{ path: 'a.md', text: 'x' }], expectedHead: 'c9' }),
    (e) => e.status === 409 && e.body.moved);
  assert.equal(f.calls.length, 1);
});

test('pages through repositories', async () => {
  const repo = (n) => ({ owner: { login: 'o' }, name: n, full_name: `o/${n}`, private: false, default_branch: 'main', permissions: { push: true } });
  const f = fake({
    'GET /user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member': {
      body: [repo('a')], headers: { link: '<https://api.github.com/page2>; rel="next"' },
    },
    'GET /page2': { body: [repo('b')] },
  });
  const list = await new GitHub('T', f).repos();
  assert.deepEqual(list.map((r) => r.full), ['o/a', 'o/b']);
  assert.equal(list[0].canPush, true);
});

test('fragments round-trip', () => {
  const loc = { owner: 'o', name: 'r.js', ref: 'feat/x', path: 'docs/a b.md' };
  assert.deepEqual(parseFragment(formatFragment(loc)), loc);
  assert.equal(formatFragment(loc), '#repo=o/r.js&ref=feat/x&path=docs/a%20b.md');
  assert.equal(parseFragment('#nothing'), null);
});

test('GitHub URLs', () => {
  assert.deepEqual(parseGitHubUrl('meditor-app/meditor'), { owner: 'meditor-app', name: 'meditor' });
  assert.deepEqual(parseGitHubUrl('https://github.com/o/r.git'), { owner: 'o', name: 'r' });
  assert.deepEqual(parseGitHubUrl('https://github.com/o/r/blob/feat/x/docs/a.md#L3'), { owner: 'o', name: 'r', rest: 'feat/x/docs/a.md' });
  assert.equal(parseGitHubUrl('not a url'), null);
  assert.deepEqual(splitRefPath('feat/x/docs/a.md', ['main', 'feat/x']), { ref: 'feat/x', path: 'docs/a.md' });
  assert.deepEqual(splitRefPath('main/a.md', []), { ref: 'main', path: 'a.md' });
});

test('relative references resolve against the document', () => {
  const loc = { owner: 'o', name: 'r', ref: 'main', path: 'docs/guide/intro.md' };
  assert.deepEqual(resolveRef('../img/a.png', loc), { kind: 'repo', url: '../img/a.png', path: 'docs/img/a.png', hash: '', query: '' });
  assert.equal(resolveRef('/README.md#x', loc).path, 'README.md');
  assert.equal(resolveRef('/README.md#x', loc).hash, 'x');
  assert.equal(resolveRef('#top', loc).kind, 'anchor');
  assert.equal(resolveRef('https://x.org', loc).kind, 'external');
  assert.equal(resolveRef('../../../x.md', loc).kind, 'external');
  assert.equal(joinPath('a/b', './c/../d.md'), 'a/b/d.md');
  assert.equal(joinPath('a/b', '../d.md'), 'a/d.md');
  assert.equal(githubUrl(loc, 'docs/a b.md'), 'https://github.com/o/r/blob/main/docs/a%20b.md');
});

test('recent files: newest first, no duplicates, capped', () => {
  const a = { owner: 'o', name: 'r', ref: 'main', path: 'a.md' };
  const b = { owner: 'o', name: 'r', ref: 'main', path: 'b.md' };
  let l = addRecent([], a, 1);
  l = addRecent(l, b, 2);
  l = addRecent(l, { ...a, path: 'A.md' }, 3); // same file, different case
  assert.deepEqual(l.map((r) => [r.path, r.at]), [['A.md', 3], ['b.md', 2]]);
  assert.deepEqual(removeRecent(l, b).map((r) => r.path), ['A.md']);
  for (let i = 0; i < 30; i++) l = addRecent(l, { ...a, path: `${i}.md` }, i);
  assert.equal(l.length, 20);
  assert.deepEqual(addRecent('garbage', a, 1).length, 1);
  const moved = renameRecent(l, { ...a, path: '29.md' }, 'x/29.md');
  assert.deepEqual(moved.slice(0, 2).map((r) => r.path), ['x/29.md', '28.md']);
  assert.equal(moved[0].at, 29);
  assert.deepEqual(renameRecent(l, { ...a, path: '29.md' }, '28.md').slice(0, 2).map((r) => r.path), ['28.md', '27.md']);
  assert.equal(ago(0, 30e3), 'just now');
  assert.equal(ago(0, 5 * 60e3), '5 min ago');
  assert.equal(ago(0, 30 * 3600e3), 'yesterday');
});
