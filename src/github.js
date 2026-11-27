// The GitHub REST API, as much of it as an editor of Markdown files needs.
//
// Everything goes straight from the browser to api.github.com, which allows that (CORS),
// so the page needs no server of its own (apart from the sign-in relay, see auth.js).
// The user's token never goes anywhere else.
// `fetch` is injected so the tests can run against a fake.

const API = 'https://api.github.com';

export const MARKDOWN_EXT = /\.(md|markdown|mdown|mkdn|mkd|mdx|rmd)$/i;

export class GitHubError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** UTF-8 text to base64, as the contents API wants it. */
export function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Base64 (possibly wrapped over lines, as the API sends it) to UTF-8 text. */
export function decodeBase64(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const enc = (path) => path.split('/').map(encodeURIComponent).join('/');

export class GitHub {
  /**
   * @param {string|null|{token(): Promise<string|null>, refresh?(): Promise<boolean>, kind?: string}} auth
   *   a token, something that hands out (and renews) tokens — see auth.js — or null for
   *   anonymous access (public repositories only, and 60 requests an hour)
   * @param {typeof fetch} [fetchImpl]
   */
  constructor(auth, fetchImpl = (...a) => fetch(...a)) {
    this.auth = typeof auth === 'string' ? { token: async () => auth, kind: 'pat' } : auth || null;
    this.fetch = fetchImpl;
    this.rate = null;
  }

  get signedIn() { return !!this.auth; }

  async request(method, path, { body, accept, raw } = {}, retried = false) {
    const headers = {
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const token = this.auth ? await this.auth.token() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const url = path.startsWith('http') ? path : API + path;
    const res = await this.fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: method === 'GET' ? 'no-cache' : undefined,
    });
    const remaining = res.headers?.get?.('x-ratelimit-remaining');
    if (remaining != null) this.rate = { remaining: +remaining, reset: +res.headers.get('x-ratelimit-reset') };
    // an app token can expire early (revoked, clock skew): renew it once and try again
    if (res.status === 401 && !retried && this.auth?.refresh && await this.auth.refresh()) {
      return this.request(method, path, { body, accept, raw }, true);
    }
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { /* not JSON */ }
      throw new GitHubError(res.status, explain(res.status, data, this), data);
    }
    if (raw === 'response') return res;
    if (raw === 'text') return res.text();
    if (raw === 'blob') return res.blob();
    if (res.status === 204) return null;
    return res.json();
  }

  /** Follows `Link: rel="next"` up to `max` pages; `key` names the list in an object response. */
  async paged(path, max = 10, key = null) {
    const out = [];
    let url = path;
    for (let page = 0; url && page < max; page++) {
      const res = await this.request('GET', url, { raw: 'response' });
      const data = await res.json();
      out.push(...(key ? data[key] : data));
      const link = res.headers?.get?.('link') || '';
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
    }
    return out;
  }

  user() { return this.request('GET', '/user'); }

  /**
   * Repositories the user can open, most recently pushed first. Signed in through the
   * GitHub App, that is the repositories the app is installed on (and the user can see).
   */
  async repos() {
    let list;
    if (this.auth?.kind === 'app') {
      const inst = await this.paged('/user/installations?per_page=100', 5, 'installations');
      list = [];
      for (const i of inst) list.push(...await this.paged(`/user/installations/${i.id}/repositories?per_page=100`, 10, 'repositories'));
      list.sort((a, b) => String(b.pushed_at).localeCompare(String(a.pushed_at)));
    } else {
      list = await this.paged('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
    }
    return list.map(slimRepo);
  }

  async repo(owner, name) {
    return slimRepo(await this.request('GET', `/repos/${owner}/${name}`));
  }

  async branches(owner, name) {
    const list = await this.paged(`/repos/${owner}/${name}/branches?per_page=100`, 5);
    return list.map((b) => ({ name: b.name, sha: b.commit.sha }));
  }

  /** Every path in the branch, files and directories, plus whether GitHub truncated it. */
  async tree(owner, name, ref) {
    const t = await this.request('GET', `/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    return {
      truncated: !!t.truncated,
      entries: t.tree.filter((e) => e.type === 'blob' || e.type === 'tree')
        .map((e) => ({ path: e.path, type: e.type === 'tree' ? 'dir' : 'file', sha: e.sha, size: e.size })),
    };
  }

  /** @returns {Promise<{text: string, sha: string}|null>} null when there is no such file */
  async getFile(owner, name, path, ref) {
    let f;
    try {
      f = await this.request('GET', `/repos/${owner}/${name}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    if (Array.isArray(f) || f.type !== 'file') throw new GitHubError(400, `${path} is not a file`);
    // Over 1 MB the contents API leaves `content` empty; the blob API has no such limit.
    if (f.encoding === 'none' || (!f.content && f.size > 0)) {
      const blob = await this.request('GET', `/repos/${owner}/${name}/git/blobs/${f.sha}`);
      return { text: decodeBase64(blob.content), sha: f.sha };
    }
    return { text: decodeBase64(f.content || ''), sha: f.sha };
  }

  /** A file's bytes (for images in private repositories, which have no public URL). */
  getRaw(owner, name, path, ref) {
    return this.request('GET', `/repos/${owner}/${name}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`,
      { accept: 'application/vnd.github.raw', raw: 'blob' });
  }

  /**
   * Creates or updates one file in one commit.
   * @param {{text: string, message: string, branch: string, sha?: string|null}} f
   *   `sha` is the blob being replaced; omit it to create a new file. If someone else
   *   changed the file meanwhile, GitHub refuses with 409 rather than overwrite them.
   * @returns {Promise<{sha: string, commit: {sha: string, html_url: string}}>}
   */
  async putFile(owner, name, path, { text, message, branch, sha }) {
    const body = { message, content: encodeBase64(text), branch };
    if (sha) body.sha = sha;
    const r = await this.request('PUT', `/repos/${owner}/${name}/contents/${enc(path)}`, { body });
    return { sha: r.content.sha, commit: { sha: r.commit.sha, html_url: r.commit.html_url } };
  }

  async deleteFile(owner, name, path, { message, branch, sha }) {
    return this.request('DELETE', `/repos/${owner}/${name}/contents/${enc(path)}`, { body: { message, branch, sha } });
  }

  /** A new branch starting where `from` (a branch name) is now. */
  async createBranch(owner, name, branch, from) {
    const ref = await this.request('GET', `/repos/${owner}/${name}/git/ref/heads/${enc(from)}`);
    await this.request('POST', `/repos/${owner}/${name}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: ref.object.sha } });
  }

  async createPull(owner, name, { head, base, title, body }) {
    const pr = await this.request('POST', `/repos/${owner}/${name}/pulls`, { body: { head, base, title, body, draft: false } });
    return { number: pr.number, html_url: pr.html_url };
  }

  /** Markdown rendered by GitHub itself: exact, but one request per render. */
  renderMarkdown(text, context) {
    return this.request('POST', '/markdown', { body: { text, mode: 'gfm', context }, accept: 'text/html', raw: 'text' });
  }
}

function slimRepo(r) {
  return {
    owner: r.owner.login,
    name: r.name,
    full: r.full_name,
    private: !!r.private,
    defaultBranch: r.default_branch,
    canPush: !!r.permissions?.push,
    description: r.description || '',
    pushedAt: r.pushed_at,
  };
}

function explain(status, data, gh) {
  const msg = data?.message || `HTTP ${status}`;
  if (status === 401) return 'GitHub did not accept the sign-in (it may have expired or been revoked). Please sign in again.';
  if (status === 403 && gh.rate && gh.rate.remaining === 0) {
    const when = new Date(gh.rate.reset * 1000).toLocaleTimeString();
    return `GitHub's rate limit is used up until ${when}.${gh.auth ? '' : ' Signing in raises it.'}`;
  }
  if (status === 403 && gh.auth?.kind === 'app') return `Not allowed: ${msg}. meditor may not be installed on this repository, or you cannot write to it.`;
  if (status === 403) return `Not allowed: ${msg}. The token may lack the "Contents: write" permission for this repository.`;
  if (status === 404 && gh.auth?.kind === 'app') return `Not found: ${msg}. For a private repository, install meditor on it first.`;
  if (status === 404) return gh.auth ? `Not found (or the token cannot see it): ${msg}` : `Not found: ${msg}. For a private repository, sign in first.`;
  if (status === 409) return 'The file changed on GitHub since it was opened. Reload it (your text is kept as a draft) and commit again.';
  if (status === 422) return `GitHub refused the change: ${data?.errors?.[0]?.message || msg}`;
  return msg;
}
