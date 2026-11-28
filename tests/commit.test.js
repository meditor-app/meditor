// Committing files as they are (#27): line endings, BOMs and encodings kept, protected
// branches explained, the file list's shas kept up to date, retries that work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// a namespace, so that a missing export fails its own test only
import * as G from '../src/github.js';
import { Drafts } from '../src/drafts.js';
import { proposeChange } from '../src/fork.js';
import { lineDiff } from '../src/diff.js';

const { GitHub, bytesToBase64 } = G;

function fake(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
    const key = `${init.method} ${url.replace('https://api.github.com', '')}`;
    const r = routes[key];
    if (!r) return { ok: false, status: 404, headers: new Map(), json: async () => ({ message: 'Not Found' }) };
    const { status = 200, body } = typeof r === 'function' ? r(init) : r;
    return { ok: status < 300, status, headers: new Map(), json: async () => body, text: async () => body };
  };
  f.calls = calls;
  f.by = (k) => calls.filter((c) => `${c.method} ${c.url.replace('https://api.github.com', '')}` === k);
  return f;
}

const b64 = (bytes) => bytesToBase64(Uint8Array.from(bytes));
const bytesOf = (s) => [...new TextEncoder().encode(s)];
const decoded = (base64) => [...Buffer.from(base64, 'base64')];
const file = (bytes, sha = 's1') => ({ body: { type: 'file', sha, encoding: 'base64', content: b64(bytes) } });
const PUT = { body: { content: { sha: 'new' }, commit: { sha: 'c1', html_url: 'u' } } };

// The Git Data API for a branch `main` at commit c0 with tree t0.
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

// --- 1. CRLF files

test('a CRLF file opens with LF text, is not dirty, and is committed with CRLF kept', async () => {
  const f = fake({ 'GET /repos/o/r/contents/README.md?ref=main': file(bytesOf('# A\r\n\r\nb\r\n')), 'PUT /repos/o/r/contents/README.md': PUT });
  const gh = new GitHub('T', f);
  const doc = await gh.getFile('o', 'r', 'README.md', 'main');
  assert.equal(doc.text, '# A\n\nb\n');
  assert.equal(doc.format.eol, '\r\n');
  // what a textarea hands back (CRLF and CR become LF) is the base: nothing to save as a draft
  const shown = doc.text.replace(/\r\n?/g, '\n');
  const store = new Map();
  const drafts = new Drafts({ get: (k) => store.get(k), set: (k, v) => { store.set(k, v); return true; }, del: (k) => store.delete(k) });
  drafts.openFile('k', { base: doc.text, sha: doc.sha, isNew: false });
  drafts.edit(); // even an input event that changed nothing
  drafts.save(shown);
  assert.equal(store.size, 0, 'no draft of an untouched CRLF file');
  // one letter changed: only that line differs, every line ending stays CRLF
  await gh.putFile('o', 'r', 'README.md', { text: '# A\n\nc\n', message: 'm', branch: 'main', sha: doc.sha, format: doc.format });
  assert.deepEqual(decoded(f.calls.at(-1).body.content), bytesOf('# A\r\n\r\nc\r\n'));
});

test('a CRLF file committed with images (Git Data API) keeps CRLF too', async () => {
  const f = fake(gitRoutes());
  await new GitHub('T', f).commitChanges('o', 'r', 'main', {
    message: 'm', changes: [{ path: 'a.md', text: 'x\ny\n', format: { eol: '\r\n', bom: false, utf8: true } }],
  });
  assert.deepEqual(decoded(f.by('POST /repos/o/r/git/blobs')[0].body.content), bytesOf('x\r\ny\r\n'));
});

test('line endings: an LF file stays LF, mixed ones take the most common, a lone CR is a line break', () => {
  assert.deepEqual(G.decodeFile(b64(bytesOf('a\nb\n'))), { text: 'a\nb\n', format: { eol: '\n', bom: false, utf8: true } });
  assert.equal(G.decodeFile(b64(bytesOf('a\r\nb\r\nc\n'))).format.eol, '\r\n');
  assert.equal(G.decodeFile(b64(bytesOf('a\r\nb\nc\n'))).format.eol, '\n');
  assert.equal(G.decodeFile(b64(bytesOf('a\rb'))).text, 'a\nb');
  assert.equal(G.encodeFile('a\nb', { eol: '\n', bom: false, utf8: true }), 'a\nb');
  assert.equal(G.encodeFile('a\nb', { eol: '\r\n', bom: false, utf8: true }), 'a\r\nb');
  assert.equal(G.encodeFile('a\r\nb', undefined), 'a\r\nb', 'no format: as it is');
});

// --- 2. protected branches

test('a protected branch refusing the ref update is explained, not taken for a push meanwhile', async () => {
  for (const message of ['Protected branch update failed for refs/heads/main.', 'Repository rule violations found\n\nChanges must be made through a pull request.\n\n']) {
    const gh = new GitHub('T', fake(gitRoutes({ 'PATCH /repos/o/r/git/refs/heads/main': { status: 422, body: { message } } })));
    await assert.rejects(gh.commitChanges('o', 'r', 'main', { message: 'm', changes: [{ path: 'a.md', text: 'x' }] }), (e) => {
      assert.ok(!e.body?.moved, 'not "someone pushed"');
      assert.ok(e.body.protected);
      assert.ok(e.message.includes(message.trim()), `GitHub's reason in: ${e.message}`);
      assert.match(e.message, /new branch and open a pull request/);
      assert.doesNotMatch(e.message, /Someone pushed|Try again/);
      return true;
    });
  }
});

test('a 409 from branch rules is not "the file changed"; a sha mismatch is', async () => {
  const put = (status, message) => new GitHub('T', fake({ 'PUT /repos/o/r/contents/a.md': { status, body: { message } } }))
    .putFile('o', 'r', 'a.md', { text: 'x', message: 'm', branch: 'main', sha: 's' });
  await assert.rejects(put(409, 'Changes must be made through a pull request.'),
    (e) => e.body.protected && !e.body.conflict && /through a pull request/.test(e.message) && !/changed on GitHub/.test(e.message));
  await assert.rejects(put(409, 'Required status check "ci" is expected.'),
    (e) => e.body.protected && !e.body.conflict && /Required status check/.test(e.message));
  await assert.rejects(put(409, 'a.md does not match 0123abcd'),
    (e) => e.body.conflict && !e.body.protected && /changed on GitHub/.test(e.message));
  await assert.rejects(put(409, 'Git Repository is empty.'),
    (e) => !e.body.conflict && /Git Repository is empty/.test(e.message));
});

// --- 3. the file list after a commit

test('after a commit the file list holds the new sha, so the file can be renamed or deleted', async () => {
  // README.md was B1 when the tree was read; a commit made it B2
  const entries = [{ path: 'README.md', type: 'file', sha: 'B1', mode: '100644' }];
  G.recordCommit(entries, { 'README.md': 'B2', 'docs/images/a.png': 'B3' });
  assert.equal(entries[0].sha, 'B2');
  assert.deepEqual(entries.slice(1).map((e) => [e.path, e.type, e.sha]), [['docs', 'dir', undefined], ['docs/images', 'dir', undefined], ['docs/images/a.png', 'file', 'B3']]);
  const f = fake(gitRoutes({ 'GET /repos/o/r/git/trees/t0': { body: { tree: [{ path: 'README.md', type: 'blob', sha: 'B2', mode: '100644' }] } } }));
  const entry = entries[0];
  await new GitHub('T', f).commitChanges('o', 'r', 'main', {
    message: 'Delete README.md', changes: [{ path: entry.path, delete: true, expect: entry.sha }],
  });
  assert.equal(f.by('PATCH /repos/o/r/git/refs/heads/main').length, 1, 'committed');
});

// --- 4. retrying "commit to a new branch"

test('a retry of "commit to a new branch" moves the branch it made instead of failing', async () => {
  const routes = {
    'GET /repos/o/r/git/ref/heads/main': { body: { object: { sha: 'c5' } } },
    'POST /repos/o/r/git/refs': { status: 422, body: { message: 'Reference already exists' } },
    'PATCH /repos/o/r/git/refs/heads/me/fix': { body: {} },
  };
  const f = fake(routes);
  await new GitHub('T', f).createBranch('o', 'r', 'me/fix', 'main', { resume: true });
  assert.deepEqual(f.by('PATCH /repos/o/r/git/refs/heads/me/fix')[0].body, { sha: 'c5', force: true });
  // not a retry: someone else's branch of that name is left alone
  const g = fake(routes);
  await assert.rejects(new GitHub('T', g).createBranch('o', 'r', 'me/fix', 'main'), (e) => /already exists/.test(e.message));
  assert.equal(g.by('PATCH /repos/o/r/git/refs/heads/me/fix').length, 0);
});

// --- 5. symlinks

test('a symlinked file is checked against its own tree entry, not its target', async () => {
  const f = fake(gitRoutes({
    // the contents API answers for a symlink with its target's sha
    'GET /repos/o/r/contents/docs/index.md?ref=c0': { body: { type: 'file', sha: 'readme-sha' } },
    'GET /repos/o/r/git/trees/t0': { body: { tree: [{ path: 'docs', type: 'tree', sha: 't-docs' }, { path: 'README.md', type: 'blob', sha: 'readme-sha' }] } },
    'GET /repos/o/r/git/trees/t-docs': { body: { tree: [{ path: 'index.md', type: 'blob', mode: '120000', sha: 'link-sha' }] } },
  }));
  await new GitHub('T', f).commitChanges('o', 'r', 'main', {
    message: 'Move', changes: [{ path: 'docs/index.md', delete: true, expect: 'link-sha' }, { path: 'docs/start.md', sha: 'link-sha', mode: '120000', expect: null }],
  });
  assert.deepEqual(f.by('POST /repos/o/r/git/trees')[0].body.tree[1], { path: 'docs/start.md', mode: '120000', type: 'blob', sha: 'link-sha' });
});

// --- 6. BOM and encodings

test('a BOM is kept', async () => {
  const f = fake({ 'GET /repos/o/r/contents/a.md?ref=main': file([0xef, 0xbb, 0xbf, ...bytesOf('# Hi')]), 'PUT /repos/o/r/contents/a.md': PUT });
  const gh = new GitHub('T', f);
  const doc = await gh.getFile('o', 'r', 'a.md', 'main');
  assert.equal(doc.text, '# Hi', 'not an invisible first character');
  assert.equal(doc.format.bom, true);
  await gh.putFile('o', 'r', 'a.md', { text: '# Hi!', message: 'm', branch: 'main', sha: doc.sha, format: doc.format });
  assert.deepEqual(decoded(f.calls.at(-1).body.content), [0xef, 0xbb, 0xbf, ...bytesOf('# Hi!')]);
});

test('a file that is not UTF-8 is not committed over with U+FFFD', async () => {
  const f = fake({ 'GET /repos/o/r/contents/a.md?ref=main': file([...bytesOf('# Caf'), 0xe9]), 'PUT /repos/o/r/contents/a.md': PUT, ...gitRoutes() });
  const gh = new GitHub('T', f);
  // getFile does not hand it to the editor at all (see filetypes.test.js) …
  const got = await gh.getFile('o', 'r', 'a.md', 'main');
  assert.equal(got.text, null);
  assert.equal(got.notUtf8, true);
  // … and should such a text get to a commit all the same, it is refused
  const doc = { ...G.decodeFile(b64([...bytesOf('# Caf'), 0xe9])), sha: got.sha };
  assert.equal(doc.format.utf8, false);
  assert.equal(doc.text, '# Caf�');
  const notUtf8 = (e) => e.body?.notUtf8 && /not UTF-8/.test(e.message);
  await assert.rejects(gh.putFile('o', 'r', 'a.md', { text: doc.text, message: 'm', branch: 'main', sha: doc.sha, format: doc.format }), notUtf8);
  await assert.rejects(gh.commitChanges('o', 'r', 'main', { message: 'm', changes: [{ path: 'a.md', text: doc.text, format: doc.format }] }), notUtf8);
  const up = { owner: 'me', name: 'docs', ref: 'main', path: 'a.md' };
  await assert.rejects(proposeChange(gh, { upstream: up, login: 'tester', branch: 'b', text: doc.text, message: 'm', sha: doc.sha, title: 't', body: '', format: doc.format }), notUtf8);
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0, 'nothing written, nothing forked');
  assert.equal(f.calls.length, 1, 'only the file was read');
});

// --- 7. the commit diff

test('line diff: a new file, insertions and deletions', () => {
  assert.deepEqual(lineDiff('', 'x'), [{ op: '+', line: 'x' }]);
  assert.deepEqual(lineDiff('x', ''), [{ op: '-', line: 'x' }]);
  assert.deepEqual(lineDiff('a\nb', 'a\nb\nc'), [{ op: ' ', line: 'a' }, { op: ' ', line: 'b' }, { op: '+', line: 'c' }]);
  assert.deepEqual(lineDiff('1\n2\n3\n4\n5\n6\n7', '1\n2\n3\n5\n6\n7', 1), [
    { op: '…', line: '' }, { op: ' ', line: '3' }, { op: '-', line: '4' }, { op: ' ', line: '5' }, { op: '…', line: '' },
  ]);
});
