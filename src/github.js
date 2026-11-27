// The GitHub REST API, as much of it as an editor of Markdown files needs.
//
// Everything goes straight from the browser to api.github.com, which allows that (CORS),
// so the page needs no server of its own. The user's token never goes anywhere else.
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
   * @param {string|null} token a personal access token, or null for anonymous access
   *   (public repositories only, and 60 requests an hour)
   * @param {typeof fetch} [fetchImpl]
   */
  constructor(token, fetchImpl = (...a) => fetch(...a)) {
    this.token = token || null;
    this.fetch = fetchImpl;
    this.rate = null;
  }

  async request(method, path, { body, accept, raw } = {}) {
    const headers = {
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
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

  /** Follows `Link: rel="next"` up to `max` pages. */
  async paged(path, max = 10) {
    const out = [];
    let url = path;
    for (let page = 0; url && page < max; page++) {
      const res = await this.request('GET', url, { raw: 'response' });
      out.push(...(await res.json()));
      const link = res.headers?.get?.('link') || '';
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
    }
    return out;
  }

  user() { return this.request('GET', '/user'); }

  /** Repositories the user can see, most recently pushed first. */
  async repos() {
    const list = await this.paged('/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
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
  if (status === 401) return 'GitHub did not accept the token (it may have expired or been revoked).';
  if (status === 403 && gh.rate && gh.rate.remaining === 0) {
    const when = new Date(gh.rate.reset * 1000).toLocaleTimeString();
    return `GitHub's rate limit is used up until ${when}.${gh.token ? '' : ' Signing in with a token raises it.'}`;
  }
  if (status === 403) return `Not allowed: ${msg}. The token may lack the "Contents: write" permission for this repository.`;
  if (status === 404) return gh.token ? `Not found (or the token cannot see it): ${msg}` : `Not found: ${msg}. For a private repository, sign in with a token.`;
  if (status === 409) return 'The file changed on GitHub since it was opened. Reload it (your text is kept as a draft) and commit again.';
  if (status === 422) return `GitHub refused the change: ${data?.errors?.[0]?.message || msg}`;
  return msg;
}
