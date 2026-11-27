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
  for (const f of ['index.html', 'manifest.webmanifest', 'sw.js', 'icons', 'src', 'meditor']) assert.match(wf, new RegExp(`cp -r .*\\b${f.replace('.', '\\.')}\\b`));
});

test('the Content Security Policy allows what the page needs and nothing inline', async () => {
  const html = read('index.html');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const dir = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(dir['script-src'], ["'self'"]);
  assert.deepEqual(dir['style-src'], ["'self'"]);
  assert.deepEqual(dir['object-src'], ["'none'"]);
  const { GITHUB_APP } = await import('../src/config.js');
  for (const origin of ['https://api.github.com', new URL(GITHUB_APP.relay).origin]) {
    assert.ok(dir['connect-src'].includes(origin), `connect-src lacks ${origin}`);
  }
  // nothing inline for the policy to block
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'inline <script>');
  assert.doesNotMatch(html, /\son[a-z]+=|\sstyle=|<style/i, 'inline handler or style');
});
