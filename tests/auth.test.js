import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auth, AuthError, AUTH_KEY, challenge, credentialStore, keepSignIn, redirectUri, signInReturn } from '../src/auth.js';

test('an OAuth error is shown only when it answers a sign-in this tab started (#32)', () => {
  // anyone can link to ?error=…&error_description=…; that text must not become meditor's toast
  const spoof = '?error=x&error_description=Session%20expired%3A%20re-enter%20your%20token%20at%20evil.example';
  assert.deepEqual(signInReturn(spoof, null), { kind: 'ignore' });
  assert.deepEqual(signInReturn(spoof + '&state=guess', { state: 's1' }), { kind: 'ignore' });
  assert.deepEqual(signInReturn(spoof, { state: 's1' }), { kind: 'ignore' });
  assert.deepEqual(signInReturn('?error=access_denied&error_description=The+user+denied&state=s1', { state: 's1' }),
    { kind: 'error', message: 'The user denied' });
  assert.deepEqual(signInReturn('?error=access_denied&state=s1', { state: 's1' }), { kind: 'error', message: 'access_denied' });
  assert.deepEqual(signInReturn('?code=c&state=s1', null), { kind: 'code', code: 'c', state: 's1' });
  assert.deepEqual(signInReturn('?installation_id=1&setup_action=install', null), { kind: 'installed' });
  assert.equal(signInReturn('', null), null);
  assert.equal(signInReturn('?x=1', { state: 's1' }), null);
});
import { GitHub, GitHubError } from '../src/github.js';

const APP = { clientId: 'Iv1.abc', relay: 'https://relay.example/' };

function memory() {
  const m = new Map();
  return { m, get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), del: (k) => m.delete(k) };
}

function relay(handlers) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const [status, data] = handlers[new URL(url).pathname](body);
    return { ok: status < 300, status, json: async () => data };
  };
  f.calls = calls;
  return f;
}

test('PKCE challenge is base64url SHA-256 of the verifier', async () => {
  // base64url(SHA-256(verifier)), checked with openssl
  assert.equal(await challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r7wW1gFWFOEjXk'), 'bwWFMyPfdG9qreDhH2lmftFx_dFeLDalzcT1gb_j68g');
  assert.equal(redirectUri('https://meditor-app.github.io/index.html?x=1#repo=a/b'), 'https://meditor-app.github.io/');
});

test('sign-in round trip: authorize URL, code for token, state checked', async () => {
  const f = relay({ '/token': () => [200, { access_token: 'ghu_1', expires_in: 28800, refresh_token: 'ghr_1', refresh_token_expires_in: 15897600 }] });
  const a = new Auth(APP, memory(), { fetchImpl: f, now: () => 1000 });
  const { url, pending } = await a.begin('https://meditor-app.github.io/#repo=o/r');
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'Iv1.abc');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://meditor-app.github.io/');
  assert.equal(u.searchParams.get('code_challenge'), await challenge(pending.verifier));
  await assert.rejects(a.complete('c', 'forged', pending), AuthError);
  const c = await a.complete('c', pending.state, pending);
  assert.equal(typeof c.id, 'string');
  assert.deepEqual(c, { kind: 'app', token: 'ghu_1', id: c.id, expires: 1000 + 28800e3, refresh: 'ghr_1', refreshExpires: 1000 + 15897600e3 });
  assert.equal(f.calls[0].url, 'https://relay.example/token');
  assert.deepEqual(f.calls[0].body, { code: 'c', redirect_uri: 'https://meditor-app.github.io/', code_verifier: pending.verifier });
  // persisted
  assert.equal(new Auth(APP, a.store).creds.token, 'ghu_1');
});

test('an expiring token is renewed once, even when asked twice at once', async () => {
  let n = 0;
  const f = relay({ '/refresh': (b) => { n++; return [200, { access_token: `ghu_${n + 1}`, expires_in: 28800, refresh_token: `ghr_${n + 1}` }]; } });
  let now = 0;
  const store = memory();
  const a = new Auth(APP, store, { fetchImpl: f, now: () => now });
  a.save({ kind: 'app', token: 'ghu_1', expires: 28800e3, refresh: 'ghr_1' });
  assert.equal(await a.token(), 'ghu_1');
  now = 28800e3 - 60e3; // a minute before expiry
  const [x, y] = await Promise.all([a.token(), a.token()]);
  assert.equal(x, 'ghu_2');
  assert.equal(y, 'ghu_2');
  assert.equal(n, 1);
  assert.deepEqual(f.calls[0].body, { refresh_token: 'ghr_1' });
});

test('a rejected refresh token signs out', async () => {
  const f = relay({ '/refresh': () => [400, { error: 'bad_refresh_token' }] });
  const a = new Auth(APP, memory(), { fetchImpl: f, now: () => 1e12, wait: async () => {} });
  a.save({ kind: 'app', token: 'ghu_1', expires: 1, refresh: 'ghr_1' });
  assert.equal(await a.token(), null);
  assert.equal(a.creds, null);
});

test('a personal access token is used as is, and never refreshed', async () => {
  const a = new Auth({}, memory());
  assert.equal(a.enabled, false);
  a.usePat('ghp_x');
  assert.equal(await a.token(), 'ghp_x');
  assert.equal(await a.renew(), false);
});

test('GitHub renews the token after a 401 and retries', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.Authorization);
    const ok = init.headers.Authorization === 'Bearer fresh';
    return { ok, status: ok ? 200 : 401, headers: new Map(), json: async () => (ok ? { login: 'me' } : { message: 'Bad credentials' }) };
  };
  let token = 'stale';
  const gh = new GitHub({ kind: 'app', token: async () => token, renew: async () => { token = 'fresh'; return true; } }, fetchImpl);
  assert.deepEqual(await gh.user(), { login: 'me' });
  assert.deepEqual(seen, ['Bearer stale', 'Bearer fresh']);
});

test('signed in through the app, repositories come from its installations', async () => {
  const repo = (n, t) => ({ owner: { login: 'o' }, name: n, full_name: `o/${n}`, default_branch: 'main', permissions: { push: true }, pushed_at: t });
  const routes = {
    '/user/installations?per_page=100': { installations: [{ id: 1 }, { id: 2 }] },
    '/user/installations/1/repositories?per_page=100': { repositories: [repo('old', '2020')] },
    '/user/installations/2/repositories?per_page=100': { repositories: [repo('new', '2026')] },
  };
  const fetchImpl = async (url) => ({ ok: true, status: 200, headers: new Map(), json: async () => routes[url.replace('https://api.github.com', '')] });
  const gh = new GitHub({ kind: 'app', token: async () => 't' }, fetchImpl);
  assert.deepEqual((await gh.repos()).map((r) => r.full), ['o/new', 'o/old']);
});

// ---------------------------------------------------------------- renewal across tabs and errors (#26)

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600e3;

/**
 * A relay in front of GitHub that, like GitHub, takes each refresh token once. `delay(n)` is
 * how long the n-th request takes to answer; whether it is accepted is decided on arrival.
 */
function github({ delay = () => 0 } = {}) {
  const live = new Set(['r1']);
  let n = 0;
  const calls = [];
  const f = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body });
    let answer;
    if (path === '/revoke') answer = [200, { ok: true }];
    else if (live.delete(body.refresh_token)) {
      n++;
      live.add(`r${n + 1}`);
      answer = [200, { access_token: `new${n}`, expires_in: 8 * 3600, refresh_token: `r${n + 1}` }];
    } else answer = [400, { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }];
    await tick(delay(calls.length));
    return { ok: answer[0] < 300, status: answer[0], json: async () => answer[1] };
  };
  f.calls = calls;
  return f;
}

/** A tab: its own Auth on the shared storage. */
const tab = (store, fetchImpl, now, opts = {}) => new Auth(APP, store, { fetchImpl, now: () => now.t, locks: null, wait: () => tick(10), ...opts });
const signedIn = (store, c) => store.set(AUTH_KEY, JSON.stringify({ kind: 'app', id: 's1', refresh: 'r1', ...c }));
const stored = (store) => JSON.parse(store.get(AUTH_KEY) || 'null');

test('a temporary relay or GitHub failure keeps the sign-in for a later try', async () => {
  const answers = [
    () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError('not JSON'); } }), // an error page
    () => ({ ok: false, status: 429, json: async () => { throw new SyntaxError('not JSON'); } }), // over the worker's limit
    () => ({ ok: false, status: 502, json: async () => ({ error: 'github_unreachable' }) }),
    () => ({ ok: false, status: 400, json: async () => ({ error: 'bad_response', error_description: 'GitHub answered HTTP 502' }) }), // older relay
    () => { throw new TypeError('Failed to fetch'); },
  ];
  for (const answer of answers) {
    const store = memory();
    const now = { t: 10 * HOUR };
    signedIn(store, { token: 'old', expires: now.t - 1 });
    const a = tab(store, async () => answer(), now);
    await assert.rejects(a.token(), (e) => !(e instanceof AuthError));
    await assert.rejects(a.renew(), (e) => !(e instanceof AuthError));
    assert.equal(a.creds.token, 'old');
    assert.equal(stored(store).refresh, 'r1');
    // the relay is back
    a.fetch = github();
    assert.equal(await a.token(), 'new1');
  }
  // while the old token still has a few minutes, it is used meanwhile
  const store = memory();
  const now = { t: 10 * HOUR };
  signedIn(store, { token: 'old', expires: now.t + 60e3 });
  const a = tab(store, async () => ({ ok: false, status: 503, json: async () => null }), now);
  assert.equal(await a.token(), 'old');
});

test('two tabs renewing at once both end up with the new token (without navigator.locks)', async () => {
  // either tab's answer may come first; the loser waits for the winner's credentials
  for (const delay of [() => 10, (n) => (n === 1 ? 30 : 1)]) {
    const store = memory();
    const now = { t: 10 * HOUR };
    signedIn(store, { token: 'old', expires: now.t - 1 });
    const f = github({ delay });
    const A = tab(store, f, now);
    const B = tab(store, f, now);
    assert.deepEqual(await Promise.all([A.token(), B.token()]), ['new1', 'new1']);
    assert.equal(stored(store).token, 'new1');
    assert.equal(stored(store).refresh, 'r2');
  }
});

test('with navigator.locks only one tab renews', async () => {
  let chain = Promise.resolve();
  const locks = { request: (name, fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; } };
  for (const opts of [{ locks }, { locks: globalThis.navigator?.locks }]) {
    if (!opts.locks) continue;
    const store = memory();
    const now = { t: 10 * HOUR };
    signedIn(store, { token: 'old', expires: now.t - 1 });
    const f = github({ delay: () => 10 });
    const A = tab(store, f, now, opts);
    const B = tab(store, f, now, opts);
    assert.deepEqual(await Promise.all([A.token(), B.token()]), ['new1', 'new1']);
    assert.deepEqual(f.calls.map((c) => c.path), ['/refresh']);
  }
});

test('a tab refused just before the winning tab saves keeps the new token (without navigator.locks)', async () => {
  // the winner's answer lands during the loser's last wait
  const store = memory();
  const now = { t: 10 * HOUR };
  signedIn(store, { token: 'old', expires: now.t - 1 });
  const f = github({ delay: (n) => (n === 1 ? 55 : 1) });
  const A = tab(store, f, now);
  const B = tab(store, f, now);
  assert.deepEqual(await Promise.all([A.token(), B.token()]), ['new1', 'new1']);
  assert.equal(stored(store).token, 'new1');
  assert.deepEqual(f.calls.map((c) => c.path), ['/refresh', '/refresh']);
});

test('a 401 while the relay is down keeps the sign-in', async () => {
  // GitHub turns down a token that has not run out by the local clock (clock skew, say)
  const store = memory();
  const now = { t: 10 * HOUR };
  signedIn(store, { token: 'old', expires: now.t + HOUR });
  const a = tab(store, async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError('not JSON'); } }), now);
  const api = async () => ({ ok: false, status: 401, headers: new Map(), json: async () => ({ message: 'Bad credentials' }) });
  const e = await new GitHub(a, api).user().catch((x) => x);
  assert.equal(keepSignIn(e), true, e.message);
  assert.equal(stored(store).refresh, 'r1');
});

test('renewing a sign-in taken from another tab keeps it where other tabs read it', async () => {
  // localStorage is shared; each tab has its own sessionStorage
  const storage = () => {
    const m = new Map();
    return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  };
  const local = storage();
  const now = { t: 10 * HOUR };
  const f = github();
  const storeA = credentialStore(() => local, ((s) => () => s)(storage()));
  const storeB = credentialStore(() => local, ((s) => () => s)(storage()));
  const A = tab(storeA, f, now);
  storeA.remember = false;
  A.usePat('patX'); // not remembered: this tab's sessionStorage
  assert.equal(local.m.size, 0);
  const B = tab(storeB, f, now);
  B.save({ kind: 'app', id: 's1', token: 'old', expires: now.t + HOUR, refresh: 'r1' });
  assert.equal(A.sync(), true); // A's 'storage' event: it follows B's sign-in
  now.t += HOUR;
  assert.equal(await A.token(), 'new1');
  assert.equal(JSON.parse(local.m.get(AUTH_KEY)).token, 'new1');
  assert.equal(B.sync(), false);
  assert.equal(await B.token(), 'new1');
  // and a tab that loads unremembered credentials renews them where they were
  const session = storage();
  session.setItem(AUTH_KEY, JSON.stringify({ kind: 'app', id: 's2', token: 'x', expires: now.t - 1, refresh: 'r2' }));
  const C = tab(credentialStore(() => storage(), () => session), f, now);
  assert.equal(await C.token(), 'new2');
  assert.equal(JSON.parse(session.m.get(AUTH_KEY)).token, 'new2');
});

test('a refresh token GitHub turned down still signs out, after a short wait for other tabs', async () => {
  const store = memory();
  const now = { t: 10 * HOUR };
  signedIn(store, { token: 'old', expires: now.t - 1, refresh: 'revoked' });
  const a = tab(store, github(), now);
  assert.equal(await a.token(), null);
  assert.equal(a.creds, null);
  assert.equal(stored(store), null);
});

test('signing out in one tab is not undone by another tab', async () => {
  const store = memory();
  const now = { t: 10 * HOUR };
  signedIn(store, { token: 'old', expires: now.t + HOUR });
  const f = github();
  const A = tab(store, f, now);
  const B = tab(store, f, now);
  let told = 0;
  B.onchange = () => told++;
  A.signOut();
  now.t += HOUR; // B's token runs out before it heard of the sign-out
  assert.equal(await B.token(), null);
  assert.equal(stored(store), null);
  assert.equal(B.kind, null);
  assert.equal(told, 1);
  assert.deepEqual(f.calls.map((c) => c.path), ['/revoke']);
  // ... and a tab that hears of it (a 'storage' event) signs out at once
  signedIn(store, { token: 'old', expires: now.t + HOUR });
  const C = tab(store, f, now);
  C.onchange = () => told++;
  A.sync();
  A.signOut();
  assert.equal(C.sync(), true);
  assert.equal(C.kind, null);
  assert.equal(told, 2);
});

test('signing out while a renewal is on its way keeps the user signed out', async () => {
  const store = memory();
  const now = { t: 10 * HOUR };
  signedIn(store, { token: 'old', expires: now.t - 1 });
  const f = github({ delay: () => 20 });
  const a = tab(store, f, now);
  const p = a.token();
  await tick(5);
  a.signOut();
  assert.equal(await p, null);
  assert.equal(a.kind, null);
  assert.equal(stored(store), null);
  await tick(30);
  // the token that came back is revoked too
  assert.deepEqual(f.calls.filter((c) => c.path === '/revoke').map((c) => c.body.access_token).sort(), ['new1', 'old']);
});

test('a renewal never hands out the token of a different sign-in from another tab', async () => {
  for (const other of [{ kind: 'pat', token: 'patY' }, { kind: 'pat', token: 'patY', id: 'p2' }, { kind: 'app', token: 'appY', id: 's2', expires: 20 * HOUR }]) {
    const store = memory();
    const now = { t: 10 * HOUR };
    store.set(AUTH_KEY, JSON.stringify({ kind: 'app', token: 'appX', expires: now.t - 1, refresh: 'r' }));
    const f = github();
    const A = tab(store, f, now);
    let told = 0;
    A.onchange = () => told++;
    store.set(AUTH_KEY, JSON.stringify(other)); // signed in again in another tab
    await assert.rejects(A.token(), /another tab/);
    assert.equal(told, 1, 'the page hears of it and checks who is signed in now');
    assert.equal(f.calls.length, 0);
  }
});

test('only GitHub saying no ends a sign-in whose user check failed', async () => {
  assert.equal(keepSignIn(new GitHubError(502, 'Bad gateway')), true);
  assert.equal(keepSignIn(new TypeError('Failed to fetch')), true);
  assert.equal(keepSignIn(new GitHubError(401, 'Bad credentials')), false);
  assert.equal(keepSignIn(new AuthError('bad_refresh_token')), false);
  // a code exchange that failed for now is not an AuthError either, and leaves storage alone
  const store = memory();
  signedIn(store, { token: 'before' });
  const a = new Auth(APP, store, { fetchImpl: async () => ({ ok: false, status: 503, json: async () => null }) });
  const { pending } = await a.begin('https://meditor-app.github.io/');
  await assert.rejects(a.complete('c', pending.state, pending), (e) => keepSignIn(e));
  assert.equal(stored(store).token, 'before');
});
