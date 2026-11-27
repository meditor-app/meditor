// A location, link or image must never name a path that leaves its repository (#24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/github.js';
import { parseFragment, parseGitHubUrl, splitRefPath, joinPath, resolveRef } from '../src/links.js';
import { referencedPaths } from '../src/images.js';

/** A fetch that answers everything and records the URL as fetch would resolve it. */
function recorder() {
  const urls = [];
  const f = async (url, init) => {
    urls.push({ method: init.method, href: new URL(url).href });
    const body = { type: 'file', sha: 's', content: { sha: 's' }, commit: { sha: 'c', html_url: 'h' } };
    return { ok: true, status: 200, headers: new Map(), json: async () => body, blob: async () => null };
  };
  f.urls = urls;
  return f;
}

/** Opens and commits `loc` the way the editor does; every request must stay in its repository. */
async function assertConfined(loc) {
  const f = recorder();
  const gh = new GitHub('T', f);
  const tries = [
    () => gh.getFile(loc.owner, loc.name, loc.path, loc.ref),
    () => gh.getRaw(loc.owner, loc.name, loc.path, loc.ref),
    () => gh.putFile(loc.owner, loc.name, loc.path, { text: 'x', message: 'm', branch: loc.ref, sha: 's' }),
    () => gh.deleteFile(loc.owner, loc.name, loc.path, { message: 'm', branch: loc.ref, sha: 's' }),
    () => gh.blobSha(loc.owner, loc.name, loc.path, loc.ref),
  ];
  for (const t of tries) {
    try { await t(); } catch { /* refused, or the fake's answer did not fit: only where requests went matters */ }
  }
  const root = `https://api.github.com/repos/${loc.owner}/${loc.name}/contents/`;
  for (const u of f.urls) assert.ok(u.href.startsWith(root), `${u.method} ${u.href} left ${root}`);
}

test("the issue's link is refused, and its requests could not leave the repository anyway", async () => {
  const hash = '#repo=attacker/notes&ref=main&path=../../../victim/private/contents/README.md';
  assert.equal(parseFragment(hash), null);
  // github.js on its own, as if the location had got through
  await assertConfined({ owner: 'attacker', name: 'notes', ref: 'main', path: '../../../victim/private/contents/README.md' });
});

test('a path climbing out of the repository in any spelling voids the location', async () => {
  for (const path of [
    '../x.md', 'a/../../x.md', '%2e%2e/x.md', '%2E%2E/x.md', '%252e%252e/x.md', '.%2e/x.md',
    '..%5cvictim%5cx.md', 'a\\..\\..\\x.md', 'a/%2e%2e%2f..%2fx.md',
  ]) {
    assert.equal(parseFragment(`#repo=o/r&ref=main&path=${path}`), null, path);
    await assertConfined({ owner: 'o', name: 'r', ref: 'main', path: decodeURIComponent(path) });
  }
});

test('a path that stays inside is normalised', () => {
  assert.deepEqual(parseFragment('#repo=o/r&path=docs/../README.md'), { owner: 'o', name: 'r', path: 'README.md' });
  assert.deepEqual(parseFragment('#repo=o/r&path=/./docs//a.md'), { owner: 'o', name: 'r', path: 'docs/a.md' });
  assert.deepEqual(parseFragment('#repo=o/r&path=/'), { owner: 'o', name: 'r' });
});

test('owners, names and branches that could leave /repos/<owner>/<name>/ are refused', async () => {
  for (const repo of ['../..', 'o/..', 'o/.', '../r', 'o.x/r', 'o/r%3Fx', 'o/r%2F..'])
    assert.equal(parseFragment(`#repo=${repo}&path=a.md`), null, repo);
  for (const ref of ['..', '.', '../../victim/private', 'a/../../b', '%2e%2e', 'a\\..'])
    assert.equal(parseFragment(`#repo=o/r&ref=${encodeURIComponent(ref)}&path=a.md`), null, ref);
  assert.deepEqual(parseFragment('#repo=o/r.js&ref=feat/x&path=a.md'), { owner: 'o', name: 'r.js', ref: 'feat/x', path: 'a.md' });
  await assertConfined({ owner: '..', name: '..', ref: 'main', path: 'victim/private/contents/a.md' });
});

test('GitHub URLs with dot segments are refused', () => {
  assert.equal(parseGitHubUrl('https://github.com/o/r/blob/main/../../../victim/private/contents/a.md'), null);
  assert.equal(parseGitHubUrl('https://github.com/o/r/blob/main/%2e%2e/%2e%2e/x.md'), null);
  assert.equal(parseGitHubUrl('https://raw.githubusercontent.com/o/r/main/../x.md'), null);
  assert.equal(parseGitHubUrl('https://github.com/o/r/blob/%zz'), null);
  assert.equal(parseGitHubUrl('../..'), null);
  assert.equal(parseGitHubUrl('https://github.com/../r'), null);
  assert.deepEqual(parseGitHubUrl('https://github.com/o/r/tree/main/docs/'), { owner: 'o', name: 'r', rest: 'main/docs' });
  // what is left to split is safe, so the split parts are too
  assert.deepEqual(splitRefPath('feat/x/docs/a.md', ['feat/x']), { ref: 'feat/x', path: 'docs/a.md' });
});

test('joinPath refuses climbs, backslashes and encoded dots, also in the directory', () => {
  assert.equal(joinPath('', '../a.md'), null);
  assert.equal(joinPath('../../victim/x', 'a.md'), null);
  assert.equal(joinPath('docs', 'a\\b.md'), null);
  assert.equal(joinPath('docs', '%2e%2e/%2e%2e/a.md'), null);
  assert.equal(joinPath('docs/./x', '../a.md'), 'docs/a.md');
  assert.equal(joinPath('', ' new/./doc.md'), ' new/doc.md');
});

test('links and images in a document cannot reach outside the repository', () => {
  // a document whose own path climbs (it cannot be opened now, but resolveRef must not trust it)
  assert.equal(resolveRef('img.png', { path: '../../victim/private/contents/doc.md' }).kind, 'external');
  assert.equal(resolveRef('%252e%252e/%252e%252e/x.png', { path: 'docs/a.md' }).kind, 'external');
  assert.equal(resolveRef('..%5c..%5cx.png', { path: 'docs/a.md' }).kind, 'external');
  assert.deepEqual([...referencedPaths('![a](../../../x.png) ![b](img/%252e%252e/y.png) ![c](ok.png)', 'docs/a.md')], ['docs/ok.png']);
});
