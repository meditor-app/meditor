// The old address, /meditor/: forward to the root, keeping the fragment (which names the
// file), and drop the service worker that was installed here, so that an app installed from
// the old address does not keep serving its cached copy.
navigator.serviceWorker?.getRegistrations().then((regs) => {
  for (const r of regs) if (new URL(r.scope).pathname.startsWith('/meditor/')) r.unregister();
}).catch(() => {});
location.replace(new URL('../', location.href).href + location.hash);
