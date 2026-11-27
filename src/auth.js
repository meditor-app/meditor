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

/** @typedef {{kind: 'app'|'pat', token: string, expires?: number, refresh?: string, refreshExpires?: number}} Credentials */

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

export class AuthError extends Error {}

export class Auth {
  /**
   * @param {{clientId?: string, relay?: string}} app the GitHub App's client ID and the
   *   relay's URL; without them only tokens pasted by hand work
   * @param {{get(k: string): string|null, set(k: string, v: string): void, del(k: string): void}} store
   *   where credentials persist (localStorage, or sessionStorage when not remembered)
   */
  constructor(app, store, { fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
    this.app = app || {};
    this.store = store;
    this.fetch = fetchImpl;
    this.now = now;
    this.creds = this.load();
    this.refreshing = null;
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
  }

  usePat(token) { this.save({ kind: 'pat', token }); }

  signOut() {
    const c = this.creds;
    this.save(null);
    // Revoking an app token needs the client secret too, so the relay does it. Best effort.
    if (c?.kind === 'app' && this.enabled) {
      this.post('/revoke', { access_token: c.token }).catch(() => {});
    }
    return c;
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
    this.save(this.fromResponse(t));
    return this.creds;
  }

  fromResponse(t) {
    const now = this.now();
    const c = { kind: 'app', token: t.access_token };
    if (t.expires_in) c.expires = now + t.expires_in * 1000;
    if (t.refresh_token) c.refresh = t.refresh_token;
    if (t.refresh_token_expires_in) c.refreshExpires = now + t.refresh_token_expires_in * 1000;
    return c;
  }

  /** The token to send now, renewed first if it is about to expire; null when signed out. */
  async token() {
    const c = this.creds;
    if (!c) return null;
    if (c.kind === 'app' && c.expires && c.expires - EARLY < this.now()) {
      await this.refresh();
      return this.creds?.token ?? null;
    }
    return c.token;
  }

  /** Renew an app token. @returns {Promise<boolean>} whether there is a fresh token */
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      // Another tab may have renewed it already, and refresh tokens are single-use.
      const stored = this.load();
      if (stored && stored.token !== this.creds?.token && (!stored.expires || stored.expires - EARLY > this.now())) {
        this.creds = stored;
        return true;
      }
      const c = this.creds;
      if (!c || c.kind !== 'app' || !c.refresh || !this.enabled) return false;
      if (c.refreshExpires && c.refreshExpires < this.now()) {
        this.save(null);
        return false;
      }
      try {
        const t = await this.post('/refresh', { refresh_token: c.refresh });
        this.save(this.fromResponse(t));
        return true;
      } catch (e) {
        if (e instanceof AuthError) this.save(null); // the refresh token is no good
        return false;
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
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
    if (!res.ok || !data || data.error || (path !== '/revoke' && !data.access_token)) {
      const why = data?.error_description || data?.error || `HTTP ${res.status}`;
      throw new AuthError(`GitHub did not sign you in: ${why}`);
    }
    return data;
  }
}
