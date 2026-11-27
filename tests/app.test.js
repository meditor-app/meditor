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

test('whatever lays out the source text is set on its highlighted copy too', () => {
  // the coloured copy lies under the textarea and must place every character alike (ui.js,
  // "highlighting"), also where a media query changes the textarea, as on phones
  const css = read('src/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const layout = /(^|;|\{)\s*(font(-size|-family)?|line-height|padding(-\w+)?|letter-spacing|word-spacing|tab-size|white-space|overflow-wrap|word-break)\s*:/;
  let checked = 0;
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = selectors.split(',').map((s) => s.trim());
    if (!list.includes('#src') || !layout.test(body)) continue;
    assert.ok(list.includes('#srcHlText'), `"${list.join(', ')}" lays out #src but not #srcHlText`);
    checked++;
  }
  assert.ok(checked >= 3, `found only ${checked} rules`);
});

/**
 * Runs sw.js in a sandbox registered at `scope`, with a network that answers every page (until
 * `offline()`). Returns its cache and a function that navigates to a URL.
 */
async function serviceWorker(scope) {
  const { runInNewContext } = await import('node:vm');
  const handlers = {};
  const cache = new Map(); // url -> body
  const caches = {
    open: async () => ({
      put: async (req, res) => { cache.set(req.url, await res.text()); },
      addAll: async (urls) => { for (const u of urls) cache.set(new URL(u, scope).href, `shell ${u}`); },
    }),
    match: async (req, { ignoreSearch } = {}) => {
      const u = new URL(req.url);
      if (ignoreSearch) u.search = '';
      return cache.has(u.href) ? new Response(cache.get(u.href)) : undefined;
    },
    keys: async () => [],
    delete: async () => true,
  };
  let online = true;
  const fetch = async (req) => {
    if (!online) throw new TypeError('offline');
    return new Response(`page ${new URL(req.url).pathname}`, { status: 200 });
  };
  const self = {
    location: new URL(scope),
    registration: { scope },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener: (type, f) => { handlers[type] = f; },
  };
  runInNewContext(read('sw.js'), { self, caches, fetch, Request, Response, URL, Promise });
  const wait = [];
  handlers.install({ waitUntil: (p) => wait.push(p) });
  await Promise.all(wait);
  async function navigate(url) {
    let answer = null;
    handlers.fetch({ request: { url, method: 'GET', mode: 'navigate' }, respondWith: (p) => { answer = p; } });
    // not answered by the worker: the browser asks the network itself
    const res = await (answer ?? fetch({ url })).catch(() => Response.error());
    await new Promise((r) => setTimeout(r, 0)); // let the cache write finish
    return res.type === 'error' ? null : res.text();
  }
  return { cache, navigate, offline: () => { online = false; } };
}

test('the service worker keeps only the app itself as the page to start offline', async () => {
  // #32: opening the old /meditor/ address (a forwarding page) replaced the cached app, so the
  // installed app showed "meditor has moved" offline and reloaded forever
  const sw = await serviceWorker('https://meditor-app.github.io/');
  assert.equal(await sw.navigate('https://meditor-app.github.io/?code=c&state=s'), 'page /');
  assert.equal(await sw.navigate('https://meditor-app.github.io/meditor/#repo=a/b'), 'page /meditor/');
  assert.equal(await sw.navigate('https://meditor-app.github.io/icons/icon.svg'), 'page /icons/icon.svg');
  assert.equal(sw.cache.get('https://meditor-app.github.io/'), 'page /');
  assert.ok(!sw.cache.has('https://meditor-app.github.io/meditor/'));
  await sw.navigate('https://meditor-app.github.io/index.html');
  assert.equal(sw.cache.get('https://meditor-app.github.io/'), 'page /index.html');
  sw.offline();
  assert.equal(await sw.navigate('https://meditor-app.github.io/?x=1#repo=a/b'), 'page /index.html');
  assert.equal(await sw.navigate('https://meditor-app.github.io/meditor/'), null);
});

test('package.json asks for a Node that has what the code uses', () => {
  // src/auth.js uses the global `crypto` (Web Crypto), which Node has without a flag from 19 on
  const pkg = JSON.parse(read('package.json'));
  const min = Number(pkg.engines.node.match(/^>=\s*(\d+)/)[1]);
  assert.ok(min >= 20, `engines.node is ${pkg.engines.node}`);
  assert.match(read('src/auth.js'), /\bcrypto\.getRandomValues/);
});
