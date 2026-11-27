import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

test('the service worker keeps every module and stylesheet the page loads', () => {
  const sw = read('sw.js');
  for (const f of readdirSync(new URL('src/', root))) {
    assert.ok(sw.includes(`'src/${f}'`), `sw.js SHELL is missing src/${f}`);
  }
});

test('the manifest is valid and its icons exist', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(existsSync(new URL(i.src, root)), i.src);
});

test('Pages publishes everything the page refers to', () => {
  const wf = read('.github/workflows/pages.yml');
  for (const f of ['index.html', 'manifest.webmanifest', 'sw.js', 'icons', 'src']) assert.match(wf, new RegExp(`cp -r .*\\b${f.replace('.', '\\.')}\\b`));
});
