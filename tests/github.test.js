import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, encodeBase64, decodeBase64 } from '../src/github.js';
import {
  parseFragment, formatFragment, parseGitHubUrl, splitRefPath, resolveRef, joinPath, githubUrl,
  addRecent, removeRecent, ago,
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
  assert.equal(ago(0, 30e3), 'just now');
  assert.equal(ago(0, 5 * 60e3), '5 min ago');
  assert.equal(ago(0, 30 * 3600e3), 'yesterday');
});
