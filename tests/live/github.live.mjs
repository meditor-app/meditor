#!/usr/bin/env node
// Runs meditor's GitHub code (src/github.js) against real GitHub: committing, conflicts,
// branches and pull requests, files over 1 MB, binary files, GitHub's renderer.
//
// It is NOT part of `node --test` (CI cannot and should not write to a repository). Run it
// by hand against a throwaway repository you can write to:
//
//   MEDITOR_LIVE_REPO=owner/name GITHUB_TOKEN=$(gh auth token) node tests/live/github.live.mjs
//
// Everything it creates lives under meditor-live-test/<run id>/ and on a branch
// meditor-live-test/<run id>; it removes them again (the pull request it opens is closed),
// also when a step fails. It never touches anything else in the repository.

import assert from 'node:assert/strict';
import { GitHub, GitHubError } from '../../src/github.js';

const repo = process.env.MEDITOR_LIVE_REPO;
const token = process.env.GITHUB_TOKEN;
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) {
  console.error('Set MEDITOR_LIVE_REPO=owner/name (a throwaway repository) and GITHUB_TOKEN.');
  process.exit(2);
}
const [owner, name] = repo.split('/');
const gh = new GitHub(token);
const run = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const dir = `meditor-live-test/${run}`;
const branch = `meditor-live-test/${run}`;
const created = []; // [path, ref] to delete afterwards
let pr = null;
let branchMade = false;
let failures = 0;

async function step(title, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ok    ${title}  (${Date.now() - t0} ms)`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${title}\n        ${(e.stack || String(e)).split('\n').slice(0, 3).join('\n        ')}`);
  }
}

const info = await gh.repo(owner, name);
if (!info.canPush) {
  console.error(`The token cannot push to ${repo}.`);
  process.exit(2);
}
const base = info.defaultBranch;
console.log(`${repo} @ ${base}, run ${run}`);

const text1 = '# Živé testování\n\nNon-ASCII: Příliš žluťoučký kůň 🐎 — “quotes”, tabs\tand CRLF-free.\n';
let sha = null;

await step('create a new file (no sha)', async () => {
  const r = await gh.putFile(owner, name, `${dir}/a.md`, { text: text1, message: 'meditor live test: create', branch: base });
  sha = r.sha;
  created.push([`${dir}/a.md`, base]);
  const f = await gh.getFile(owner, name, `${dir}/a.md`, base);
  assert.equal(f.text, text1);
  assert.equal(f.sha, sha);
});

let stale = null;
await step('update it with its sha', async () => {
  stale = sha;
  const r = await gh.putFile(owner, name, `${dir}/a.md`, { text: text1 + '\nmore\n', message: 'meditor live test: update', branch: base, sha });
  sha = r.sha;
  assert.equal((await gh.getFile(owner, name, `${dir}/a.md`, base)).text, text1 + '\nmore\n');
});

await step('refuse to overwrite a newer version (409 conflict)', async () => {
  await assert.rejects(
    gh.putFile(owner, name, `${dir}/a.md`, { text: 'clobber', message: 'meditor live test: stale', branch: base, sha: stale }),
    (e) => e instanceof GitHubError && e.status === 409 && /changed on GitHub/.test(e.message),
  );
  assert.equal((await gh.getFile(owner, name, `${dir}/a.md`, base)).text, text1 + '\nmore\n');
});

await step('a missing file reads as null', async () => {
  assert.equal(await gh.getFile(owner, name, `${dir}/nope.md`, base), null);
});

await step('branch, commit there, open a pull request', async () => {
  await gh.createBranch(owner, name, branch, base);
  branchMade = true;
  const f = await gh.getFile(owner, name, `${dir}/a.md`, branch);
  await gh.putFile(owner, name, `${dir}/a.md`, { text: f.text + '\non a branch\n', message: 'meditor live test: branch', branch, sha: f.sha });
  pr = await gh.createPull(owner, name, { head: branch, base, title: `meditor live test ${run}`, body: 'Opened and closed by tests/live/github.live.mjs.' });
  assert.ok(pr.number > 0 && /\/pull\/\d+$/.test(pr.html_url));
  assert.equal((await gh.getFile(owner, name, `${dir}/a.md`, base)).text, text1 + '\nmore\n', 'base branch untouched');
});

await step('a file over 1 MB round-trips (blob API fallback)', async () => {
  const big = ('Ünïcödé line ' + 'x'.repeat(100) + '\n').repeat(9000); // ≈ 1.05 MB
  assert.ok(new TextEncoder().encode(big).length > 1024 * 1024);
  await gh.putFile(owner, name, `${dir}/big.md`, { text: big, message: 'meditor live test: big', branch: base });
  created.push([`${dir}/big.md`, base]);
  assert.equal((await gh.getFile(owner, name, `${dir}/big.md`, base)).text, big);
});

await step('binary content reads back byte for byte (images in private repos)', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  await gh.request('PUT', `/repos/${owner}/${name}/contents/${dir}/p.png`, { body: { message: 'meditor live test: png', content: btoa(String.fromCharCode(...png)), branch: base } });
  created.push([`${dir}/p.png`, base]);
  const blob = await gh.getRaw(owner, name, `${dir}/p.png`, base);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), png);
});

await step("GitHub's renderer, with the repository as context", async () => {
  const html = await gh.renderMarkdown('# Hi\n\n- [ ] task\n\n```js\nlet a = 1;\n```', repo);
  assert.match(html, /<h1/);
  assert.match(html, /task-list-item/);
  assert.match(html, /pl-k/);
});

await step('lists the branch in the tree, with the new files', async () => {
  const t = await gh.tree(owner, name, base);
  for (const p of ['a.md', 'big.md', 'p.png']) assert.ok(t.entries.some((e) => e.path === `${dir}/${p}`), p);
});

// ---- clean up, whatever happened above
console.log('cleaning up');
if (pr) {
  await gh.request('PATCH', `/repos/${owner}/${name}/pulls/${pr.number}`, { body: { state: 'closed' } }).catch((e) => console.log(`  could not close PR #${pr.number}: ${e.message}`));
}
if (branchMade) {
  await gh.request('DELETE', `/repos/${owner}/${name}/git/refs/heads/${branch}`).catch((e) => console.log(`  could not delete branch ${branch}: ${e.message}`));
}
for (const [path, ref] of created) {
  try {
    const f = await gh.request('GET', `/repos/${owner}/${name}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    await gh.deleteFile(owner, name, path, { message: 'meditor live test: clean up', branch: ref, sha: f.sha });
  } catch (e) {
    console.log(`  could not delete ${path}: ${e.message}`);
  }
}
console.log(failures ? `${failures} step(s) FAILED` : 'all steps passed');
process.exit(failures ? 1 : 0);
