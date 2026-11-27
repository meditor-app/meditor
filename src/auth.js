// Signing in to GitHub: "Sign in with GitHub" through a GitHub App, or a personal access
// token pasted by hand.
//
// The GitHub App way is OAuth's web flow. The page sends the user to github.com, which sends
// them back with a one-time code; the code becomes a token at github.com/login/oauth/
// access_token. That last step needs the app's client secret, and github.com does not let
// pages call it anyway (no CORS), so it goes through the relay in worker/relay.js, which
// adds the secret and nothing else. The token that comes back expires after eight hours and
// is renewed with its refresh token, again through the relay.
//
// Pure apart from the injected fetch, storage and clock, so it is tested headless.

/**
 * @typedef {{kind: 'app'|'pat', token: string, id?: string, expires?: number, refresh?: string, refreshExpires?: number}} Credentials
 *   `id` names the sign-in, so that a tab can tell a renewed token from someone else's
 */

const KEY = 'meditor:auth';
const EARLY = 5 * 60 * 1000; // renew this long before the token expires

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomString(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE S256 challenge for a verifier. */
export async function challenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** The address GitHub sends the user back to: this page, without query or fragment. */
export function redirectUri(href) {
  const u = new URL(href);
  return u.origin + u.pathname.replace(/index\.html$/, '');
}

/** GitHub turned the sign-in down for good (a used or revoked refresh token, a bad code). */
export class AuthError extends Error {}

/** The key the credentials are stored under; a 'storage' event for it means another tab changed them. */
export const AUTH_KEY = KEY;

/** Whether two credentials are the same sign-in (one renews into the other), not just the same token. */
export const sameSignIn = (a, b) => !!(a && b && a.kind === b.kind && a.id === b.id);

/**
 * After the user check that follows a sign-in failed: whether to keep the credentials. Only
 * GitHub saying no ends the sign-in; an outage or a dropped connection should not.
 */
/**
 * Where the page keeps credentials: localStorage, or sessionStorage when the user asked not to
 * be remembered (`remember`, set before saving a new sign-in). Reads look in both,
 * localStorage first, and reading them sets `remember` to where they are: a renewal of
 * credentials adopted from another tab must go back where that tab and new tabs read them.
 * @param {() => Storage} local @param {() => Storage} session getters: touching a blocked
 *   storage throws
 */
export function credentialStore(local, session) {
  const store = {
    remember: true,
    get(k) {
      try {
        const v = local().getItem(k);
        if (k === KEY && (v ?? session().getItem(k)) !== null) store.remember = v !== null;
        return v ?? session().getItem(k);
      } catch { return null; }
    },
    set(k, v) {
      try {
        (store.remember ? session() : local()).removeItem(k);
        (store.remember ? local() : session()).setItem(k, v);
      } catch { /* private mode: lasts for this page only */ }
    },
    del(k) {
      try { local().removeItem(k); session().removeItem(k); } catch { /* ignore */ }
    },
  };
  return store;
}

export const keepSignIn = (e) => !(e instanceof AuthError || e?.status === 401);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Auth {
  /**
   * @param {{clientId?: string, relay?: string}} app the GitHub App's client ID and the
   *   relay's URL; without them only tokens pasted by hand work
   * @param {{get(k: string): string|null, set(k: string, v: string): void, del(k: string): void}} store
   *   where credentials persist (localStorage, or sessionStorage when not remembered); other
   *   tabs share it, so it is read again around every renewal
   * @param {{fetchImpl?: Function, now?: () => number, locks?: {request(name: string, fn: () => Promise<any>): Promise<any>}|null, wait?: (ms: number) => Promise<void>}} [opts]
   *   `locks` (navigator.locks) keeps two tabs from renewing at once; without it a tab whose
   *   renewal was refused waits a little for the tab that won
   */
  constructor(app, store, { fetchImpl = (...a) => fetch(...a), now = () => Date.now(), locks = globalThis.navigator?.locks ?? null, wait = sleep } = {}) {
    this.app = app || {};
    this.store = store;
    this.fetch = fetchImpl;
    this.now = now;
    this.locks = locks;
    this.wait = wait;
    this.persisted = true; // false when storage does not keep what is saved (private mode): no other tab to watch
    this.creds = this.load();
    this.refreshing = null;
    /** Called when another tab signed out, or signed in as someone else; set by the page. */
    this.onchange = null;
  }

  get enabled() { return !!(this.app.clientId && this.app.relay); }
  get kind() { return this.creds?.kind ?? null; }

  load() {
    try {
      const c = JSON.parse(this.store.get(KEY) || 'null');
      return c && c.token ? c : null;
    } catch {
      return null;
    }
  }

  save(creds) {
    this.creds = creds;
    if (creds) this.store.set(KEY, JSON.stringify(creds));
    else this.store.del(KEY);
    this.persisted = this.load()?.token === creds?.token;
  }

  usePat(token) { this.save({ kind: 'pat', token, id: randomString(9) }); }

  signOut() {
    const c = this.creds;
    this.save(null);
    if (c?.kind === 'app') this.revoke(c.token);
    return c;
  }

  /** Revoking an app token needs the client secret too, so the relay does it. Best effort. */
  revoke(token) {
    if (this.enabled) this.post('/revoke', { access_token: token }).catch(() => {});
  }

  /**
   * Catch up with what another tab did to the stored credentials. A newer token of the same
   * sign-in is taken quietly; a sign-out or a different sign-in is taken and reported through
   * onchange. @returns {boolean} whether the sign-in changed
   */
  sync() {
    if (!this.persisted) return false;
    const was = this.creds;
    const s = this.load();
    if (sameSignIn(s, was)) {
      this.creds = s;
      return false;
    }
    if (!s && !was) return false;
    this.creds = s;
    this.onchange?.();
    return true;
  }

  /** The latest stored credentials of sign-in c, or null when another tab ended or replaced it. */
  latest(c) {
    if (!this.persisted) return c;
    const s = this.load();
    return sameSignIn(s, c) ? s : null;
  }

  /**
   * Where to send the user to sign in, and what to remember until they come back.
   * @returns {Promise<{url: string, pending: {state: string, verifier: string, redirect: string}}>}
   */
  async begin(href) {
    if (!this.enabled) throw new AuthError('Signing in with GitHub is not set up for this page.');
    const state = randomString(16);
    const verifier = randomString(32);
    const redirect = redirectUri(href);
    const q = new URLSearchParams({
      client_id: this.app.clientId,
      redirect_uri: redirect,
      state,
      code_challenge: await challenge(verifier),
      code_challenge_method: 'S256',
    });
    return { url: `https://github.com/login/oauth/authorize?${q}`, pending: { state, verifier, redirect } };
  }

  /** Back from github.com with `code` and `state`: trade them for a token. */
  async complete(code, state, pending) {
    if (!pending || !state || pending.state !== state) {
      throw new AuthError('The sign-in did not start on this page (or was started in another tab). Please try again.');
    }
    const t = await this.post('/token', { code, redirect_uri: pending.redirect, code_verifier: pending.verifier });
    this.save(this.fromResponse(t, { id: randomString(9) }));
    return this.creds;
  }

  /** Credentials from GitHub's token response; renewals keep the sign-in's id. */
  fromResponse(t, prev) {
    const now = this.now();
    const c = { kind: 'app', token: t.access_token };
    if (prev?.id) c.id = prev.id;
    if (t.expires_in) c.expires = now + t.expires_in * 1000;
    if (t.refresh_token) c.refresh = t.refresh_token;
    if (t.refresh_token_expires_in) c.refreshExpires = now + t.refresh_token_expires_in * 1000;
    return c;
  }

  expiring(c) { return c.kind === 'app' && !!c.expires && c.expires - EARLY < this.now(); }

  /**
   * The token to send now, renewed first if it is about to expire; null when signed out.
   * Throws when the renewal failed for now (relay or GitHub down) and the old token has run
   * out, and when another tab signed in as someone else meanwhile.
   */
  async token() {
    const c = this.creds;
    if (!c) return null;
    if (!this.expiring(c)) return c.token;
    try {
      await this.renew();
    } catch (e) {
      if (this.creds?.token === c.token && c.expires > this.now()) return c.token; // still good for a few minutes
      throw e;
    }
    if (this.creds && !sameSignIn(this.creds, c)) throw new Error('You signed in to GitHub differently in another tab; please try again.');
    return this.creds?.token ?? null;
  }

  /**
   * Renew an app token (after a 401, say). @returns {Promise<boolean>} whether there is a
   * fresh token; false when it cannot be renewed. Throws when the renewal failed for now.
   */
  renew() {
    if (this.refreshing) return this.refreshing;
    // One tab at a time: refresh tokens are single-use, so the second would be turned down.
    const run = () => this.renewNow();
    this.refreshing = (this.locks ? this.locks.request('meditor:refresh', run) : run())
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async renewNow() {
    const was = this.creds;
    if (!was) return false;
    // Another tab may have renewed it already, signed out, or signed in as someone else.
    const c = this.latest(was);
    if (!c) {
      this.sync();
      return false;
    }
    this.creds = c;
    if (c.token !== was.token && !this.expiring(c)) return true;
    if (c.kind !== 'app' || !c.refresh || !this.enabled) return false;
    if (c.refreshExpires && c.refreshExpires < this.now()) {
      this.save(null);
      return false;
    }
    let t;
    try {
      t = await this.post('/refresh', { refresh_token: c.refresh });
    } catch (e) {
      if (!(e instanceof AuthError)) throw e; // temporary: keep the credentials for a later try
      return this.refused(c);
    }
    const next = this.fromResponse(t, c);
    // Signed out (here or in another tab) while this was on its way: do not bring it back.
    if (!sameSignIn(this.creds, c) || !this.latest(c)) {
      this.revoke(next.token);
      this.sync();
      return false;
    }
    this.save(next);
    return true;
  }

  /**
   * GitHub turned the refresh token down. Most likely another tab (without navigator.locks)
   * used it first: wait a little for that tab's new credentials before giving up on them.
   */
  async refused(c) {
    for (let i = 0; ; i++) {
      if (!sameSignIn(this.creds, c)) return false;
      const s = this.latest(c);
      if (!s) {
        this.sync();
        return false;
      }
      if (s.token !== c.token) {
        this.creds = s;
        return true;
      }
      if (i === 6 || !this.persisted) break;
      await this.wait(250);
    }
    // checked just now: storage still holds the refused token, so this wipes no other tab's
    this.save(null); // the refresh token is no good
    return false;
  }

  async post(path, body) {
    let res;
    try {
      res = await this.fetch(this.app.relay.replace(/\/$/, '') + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('Could not reach the sign-in relay. Check the connection and try again.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (res.ok && data && !data.error && (path === '/revoke' || data.access_token)) return data;
    const why = data?.error_description || data?.error || `HTTP ${res.status}`;
    // The relay answers 400 when GitHub said no. Anything else (5xx, 429, an error page that is
    // not JSON; 'bad_response' is how older relays passed on a GitHub outage) may pass.
    if (res.status === 400 && data?.error && data.error !== 'bad_response') {
      throw new AuthError(`GitHub did not sign you in: ${why}`);
    }
    throw new Error(`Signing in to GitHub failed for now (${why}). Please try again in a moment.`);
  }
}
