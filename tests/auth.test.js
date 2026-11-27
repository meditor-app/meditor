import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auth, AuthError, challenge, redirectUri } from '../src/auth.js';
import { GitHub } from '../src/github.js';

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
  assert.deepEqual(c, { kind: 'app', token: 'ghu_1', expires: 1000 + 28800e3, refresh: 'ghr_1', refreshExpires: 1000 + 15897600e3 });
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
  const a = new Auth(APP, memory(), { fetchImpl: f, now: () => 1e12 });
  a.save({ kind: 'app', token: 'ghu_1', expires: 1, refresh: 'ghr_1' });
  assert.equal(await a.token(), null);
  assert.equal(a.creds, null);
});

test('a personal access token is used as is, and never refreshed', async () => {
  const a = new Auth({}, memory());
  assert.equal(a.enabled, false);
  a.usePat('ghp_x');
  assert.equal(await a.token(), 'ghp_x');
  assert.equal(await a.refresh(), false);
});

test('GitHub renews the token after a 401 and retries', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.Authorization);
    const ok = init.headers.Authorization === 'Bearer fresh';
    return { ok, status: ok ? 200 : 401, headers: new Map(), json: async () => (ok ? { login: 'me' } : { message: 'Bad credentials' }) };
  };
  let token = 'stale';
  const gh = new GitHub({ kind: 'app', token: async () => token, refresh: async () => { token = 'fresh'; return true; } }, fetchImpl);
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
