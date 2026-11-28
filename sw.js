// meditor's service worker: lets the installed app start without a network.
//
// It keeps a copy of the page's own files (and nothing else: GitHub's API, the sign-in
// relay and images are never cached). Network first, so an update to the site is picked up
// on the next start whenever online; the copy is only used when the network fails.

// v4: drops copies of other pages that v3 kept as the app shell (#32)
const CACHE = 'meditor-v4';
const SHELL = [
  './',
  'manifest.webmanifest',
  'src/app.css',
  'src/main.js',
  'src/ui.js',
  'src/markdown.js',
  'src/highlight.js',
  'src/emoji.js',
  'src/entities.js',
  'src/github.js',
  'src/auth.js',
  'src/config.js',
  'src/links.js',
  'src/edit.js',
  'src/diff.js',
  'src/find.js',
  'src/mdsyntax.js',
  'src/filetypes.js',
  'src/fork.js',
  'src/images.js',
  'src/drafts.js',
  'src/nav.js',
  'icons/icon.svg',
  'icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  let key = req;
  if (req.mode === 'navigate') {
    // the page itself, whatever its query (?code=… on the way back from signing in); any other
    // page of the site (the old /meditor/ address, a file opened directly) is left alone, so
    // that it never takes the app's place in the cache
    const root = new URL('./', self.registration.scope);
    if (url.pathname !== root.pathname && url.pathname !== root.pathname + 'index.html') return;
    key = new Request(root);
  }
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return res;
    }).catch(() => caches.match(key, { ignoreSearch: true }).then((hit) => hit || Response.error())),
  );
});
