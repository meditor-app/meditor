import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../worker/relay.js';

const ENV = { GITHUB_CLIENT_ID: 'Iv1.abc', GITHUB_CLIENT_SECRET: 's3cret', ALLOWED_ORIGINS: 'https://ondrik.github.io, http://localhost:8000' };
const ORIGIN = 'https://ondrik.github.io';

let realFetch;
let sent;
beforeEach(() => {
  realFetch = globalThis.fetch;
  sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    if (url.startsWith('https://api.github.com/applications/')) return new Response(null, { status: 204 });
    const b = JSON.parse(init.body);
    const data = b.code === 'bad' ? { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' } : { access_token: 'ghu_x', token_type: 'bearer' };
    return new Response(JSON.stringify(data), { status: 200 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const req = (path, body, origin = ORIGIN, method = 'POST') => new Request(`https://relay.example${path}`, {
  method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined,
});

test('trades a code for a token, adding the secret', async () => {
  const res = await handle(req('/token', { code: 'c', redirect_uri: 'https://ondrik.github.io/meditor/', code_verifier: 'v' }), ENV);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.deepEqual(await res.json(), { access_token: 'ghu_x', token_type: 'bearer' });
  assert.equal(sent[0].url, 'https://github.com/login/oauth/access_token');
  assert.deepEqual(sent[0].body, { client_id: 'Iv1.abc', client_secret: 's3cret', code: 'c', redirect_uri: 'https://ondrik.github.io/meditor/', code_verifier: 'v' });
});

test('refreshes and revokes', async () => {
  await handle(req('/refresh', { refresh_token: 'r' }), ENV);
  assert.deepEqual(sent[0].body, { client_id: 'Iv1.abc', client_secret: 's3cret', grant_type: 'refresh_token', refresh_token: 'r' });
  const res = await handle(req('/revoke', { access_token: 'ghu_x' }), ENV);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(sent[1].method, 'DELETE');
  assert.equal(sent[1].headers.Authorization, `Basic ${btoa('Iv1.abc:s3cret')}`);
});

test('passes GitHub errors on as 400', async () => {
  const res = await handle(req('/token', { code: 'bad' }), ENV);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_verification_code');
});

test('serves only the allowed pages, and only POST', async () => {
  const other = await handle(req('/token', { code: 'c' }, 'https://evil.example'), ENV);
  assert.equal(other.status, 403);
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  assert.equal(sent.length, 0);
  const pre = await handle(req('/token', null, 'http://localhost:8000', 'OPTIONS'), ENV);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal((await handle(req('/token', null, ORIGIN, 'GET'), ENV)).status, 405);
  assert.equal((await handle(req('/nope', {}), ENV)).status, 404);
  assert.equal((await handle(req('/token', {}), ENV)).status, 400);
  assert.equal((await handle(req('/token', { code: 'c' }), { ...ENV, GITHUB_CLIENT_SECRET: '' })).status, 500);
});
