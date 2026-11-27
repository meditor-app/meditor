// The sign-in relay for meditor: a Cloudflare Worker.
//
// meditor is a static page. To sign in with GitHub it needs to trade a one-time code for a
// token at github.com/login/oauth/access_token, which requires the GitHub App's client
// secret (which cannot live in a public page) and which github.com does not allow pages to
// call (no CORS). This worker does that one thing: it takes the code (or a refresh token)
// from the page, adds the client ID and secret, asks GitHub, and passes GitHub's answer
// back. It stores nothing and logs nothing.
//
//   POST /token    {code, redirect_uri, code_verifier}  -> GitHub's token response
//   POST /refresh  {refresh_token}                       -> GitHub's token response
//   POST /revoke   {access_token}                        -> {ok: true}
//
// 400 means GitHub turned the request down; 502 that GitHub could not be asked right now.
//
// Configuration (see wrangler.toml): GITHUB_CLIENT_ID and ALLOWED_ORIGINS as variables,
// GITHUB_CLIENT_SECRET as a secret (`npx wrangler secret put GITHUB_CLIENT_SECRET`).

const TOKEN_URL = 'https://github.com/login/oauth/access_token';

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
  });
}

// The page signs the user out only on a 400 (GitHub said no to the code or refresh token);
// a 502 means GitHub could not be asked just now, and the page keeps its credentials.
async function askGitHub(params) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'meditor-relay' },
      body: JSON.stringify(params),
    });
  } catch {
    return { data: { error: 'github_unreachable', error_description: 'GitHub could not be reached' }, status: 502 };
  }
  let data;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data) return { data: { error: 'github_unavailable', error_description: `GitHub answered HTTP ${res.status}` }, status: 502 };
  // GitHub reports a bad code or refresh token with HTTP 200 and an `error` field.
  return { data, status: data.error ? 400 : 200 };
}

export async function handle(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const cors = allowed.includes(origin)
    ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    }
    : null;

  if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
  if (!cors) return json({ error: 'origin_not_allowed' }, 403, {});
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return json({ error: 'relay_not_configured' }, 500, cors);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, cors); }
  const str = (v) => (typeof v === 'string' && v.length < 2048 ? v : undefined);
  const client = { client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET };
  const path = new URL(request.url).pathname;

  if (path === '/token') {
    if (!str(body.code)) return json({ error: 'bad_request' }, 400, cors);
    const params = { ...client, code: body.code };
    if (str(body.redirect_uri)) params.redirect_uri = body.redirect_uri;
    if (str(body.code_verifier)) params.code_verifier = body.code_verifier;
    const { data, status } = await askGitHub(params);
    return json(data, status, cors);
  }
  if (path === '/refresh') {
    if (!str(body.refresh_token)) return json({ error: 'bad_request' }, 400, cors);
    const { data, status } = await askGitHub({ ...client, grant_type: 'refresh_token', refresh_token: body.refresh_token });
    return json(data, status, cors);
  }
  if (path === '/revoke') {
    if (!str(body.access_token)) return json({ error: 'bad_request' }, 400, cors);
    const res = await fetch(`https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
        'Content-Type': 'application/json',
        'User-Agent': 'meditor-relay',
      },
      body: JSON.stringify({ access_token: body.access_token }),
    });
    return json({ ok: res.status === 204 }, res.status === 204 ? 200 : 400, cors);
  }
  return json({ error: 'not_found' }, 404, cors);
}

export default { fetch: handle };
