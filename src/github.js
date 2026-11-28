// The GitHub REST API, as much of it as an editor of text files needs.
//
// Everything goes straight from the browser to api.github.com, which allows that (CORS),
// so the page needs no server of its own (apart from the sign-in relay, see auth.js).
// The user's token never goes anywhere else.
// `fetch` is injected so the tests can run against a fake.

import { decodeText, MAX_TEXT_BYTES } from './filetypes.js';

const API = 'https://api.github.com';

export { MARKDOWN_EXT } from './filetypes.js';

export class GitHubError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** UTF-8 text to base64, as the contents API wants it. */
export function encodeBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** Bytes (a Uint8Array) to base64. */
export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Base64 (possibly wrapped over lines, as the API sends it) to bytes. */
export function base64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Base64 (possibly wrapped over lines, as the API sends it) to UTF-8 text. */
export function decodeBase64(b64) {
  return new TextDecoder().decode(base64ToBytes(b64));
}

// Names and paths go into API URLs, where fetch resolves '.' and '..' segments: a path
// like '../../other/repo/contents/x' would read or commit to another repository than the
// one named. So nothing that could leave /repos/<owner>/<name>/ is ever put in a URL (and
// the methods that build URLs are async, so that a refusal rejects like any other error).

/** An account: letters, digits, '-' and '_' (managed users' "_shortcode"). */
export const isOwner = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(s);

/** A repository: the same and '.', but not '.' or '..'. */
export const isRepoName = (s) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(s) && s !== '.' && s !== '..';

// A segment as it reads after any number of percent-decodings, so that a later decoding
// (ours, the browser's or a server's) cannot turn '%2e%2e' into a climb.
function decoded(seg) {
  for (let i = 0; i < 8; i++) {
    let d;
    try { d = decodeURIComponent(seg); } catch { break; }
    if (d === seg) break;
    seg = d;
  }
  return seg;
}

const badSegment = (seg) => {
  const d = decoded(seg);
  // URL parsers read a backslash as '/' in http(s) URLs; a decoded '/' would be one more segment
  return d === '' || d === '.' || d === '..' || /[\\/]/.test(d);
};

/** A path inside the repository: no empty, '.' or '..' segments, no backslashes. */
export const isSafePath = (s) => typeof s === 'string' && s !== '' && !s.split('/').some(badSegment);

/** A branch, tag or commit; branch names hold '/', so the same rule as paths. */
export const isSafeRef = isSafePath;

const refuse = (what, s) => new GitHubError(400, `${JSON.stringify(String(s))} is not a valid ${what}.`);

/** The API's address of a repository, refusing names that are not GitHub's. */
function repoUrl(owner, name) {
  if (!isOwner(owner)) throw refuse('owner', owner);
  if (!isRepoName(name)) throw refuse('repository name', name);
  return `/repos/${owner}/${name}`;
}

/** A path (or a branch, in git/ref/heads/<branch>) as URL segments. */
const enc = (path, what = 'path in the repository') => {
  if (!isSafePath(path)) throw refuse(what, path);
  return path.split('/').map(encodeURIComponent).join('/');
};
const encBranch = (branch) => enc(branch, 'branch');

/** A ref as one URL component (a query value, or git/trees/<ref>). */
const encRef = (ref) => {
  if (!isSafeRef(ref)) throw refuse('branch', ref);
  return encodeURIComponent(ref);
};

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
    // an app token can expire early (revoked, clock skew): renew it once and try again. A
    // renewal that failed for now throws its own error, not the 401 that would end the sign-in.
    if (res.status === 401 && !retried && this.auth?.renew && await this.auth.renew()) {
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
    return slimRepo(await this.request('GET', repoUrl(owner, name)));
  }

  async branches(owner, name) {
    const list = await this.paged(`${repoUrl(owner, name)}/branches?per_page=100`, 5);
    return list.map((b) => ({ name: b.name, sha: b.commit.sha }));
  }

  /** Every path in the branch, files and directories, plus whether GitHub truncated it. */
  async tree(owner, name, ref) {
    const t = await this.request('GET', `${repoUrl(owner, name)}/git/trees/${encRef(ref)}?recursive=1`);
    return {
      truncated: !!t.truncated,
      entries: t.tree.filter((e) => e.type === 'blob' || e.type === 'tree')
        .map((e) => ({ path: e.path, type: e.type === 'tree' ? 'dir' : 'file', sha: e.sha, size: e.size, mode: e.mode })),
    };
  }

  /**
   * A text file. One that is no text (binary content: see filetypes.js, decodeText) or larger
   * than MAX_TEXT_BYTES comes back without its text, saying so (`binary`, `tooLarge`, with
   * its `size`), and one that large is not even downloaded.
   * @returns {Promise<{text: string, sha: string}|{text: null, sha: string, size: number,
   *   binary?: true, tooLarge?: true}|null>} null when there is no such file
   */
  async getFile(owner, name, path, ref) {
    let f;
    try {
      f = await this.request('GET', `${repoUrl(owner, name)}/contents/${enc(path)}?ref=${encRef(ref)}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    if (Array.isArray(f) || f.type !== 'file') throw new GitHubError(400, `${path} is not a file`);
    if (f.size > MAX_TEXT_BYTES) return { text: null, sha: f.sha, size: f.size, tooLarge: true };
    let b64 = f.content || '';
    // Over 1 MB the contents API leaves `content` empty; the blob API has no such limit.
    if (f.encoding === 'none' || (!f.content && f.size > 0)) {
      b64 = (await this.request('GET', `${repoUrl(owner, name)}/git/blobs/${f.sha}`)).content;
    }
    const text = decodeText(base64ToBytes(b64));
    if (text === null) return { text: null, sha: f.sha, size: f.size, binary: true };
    return { text, sha: f.sha };
  }

  /** A file's bytes (for images in private repositories, which have no public URL). */
  async getRaw(owner, name, path, ref) {
    return this.request('GET', `${repoUrl(owner, name)}/contents/${enc(path)}?ref=${encRef(ref)}`,
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
    const r = await this.request('PUT', `${repoUrl(owner, name)}/contents/${enc(path)}`, { body });
    return { sha: r.content.sha, commit: { sha: r.commit.sha, html_url: r.commit.html_url } };
  }

  async deleteFile(owner, name, path, { message, branch, sha }) {
    return this.request('DELETE', `${repoUrl(owner, name)}/contents/${enc(path)}`, { body: { message, branch, sha } });
  }

  /**
   * Several files changed in one commit, through the Git Data API: the branch's head commit,
   * new blobs, a new tree on top of the head's, a commit, and the branch moved to it. The
   * contents API (putFile) can only make one commit per file.
   *
   * Each change is one of
   *   { path, text }         a file with this text (created or replaced)
   *   { path, blobBase64 }   a file with these bytes (an image)
   *   { path, sha }          a file with a blob already in the repository (a move)
   *   { path, delete: true } no file here any more
   * plus, optionally, `mode` (default the plain file mode) and `expect`: the blob sha the path
   * must have at the head (null: there must be no file), so that a change someone else made
   * meanwhile is refused (409) rather than overwritten, as putFile does with `sha`.
   *
   * The branch is moved without forcing it: if someone pushed while this was being prepared,
   * GitHub refuses and nothing is committed. Blobs and trees made on the way are left for
   * GitHub to collect.
   *
   * @param {{message: string, changes: object[], expectedHead?: string}} c
   *   `expectedHead`: refuse (409) unless the branch is still at this commit
   * @returns {Promise<{sha: string, html_url: string, blobs: Record<string, string>}>}
   *   the new commit, and the blob sha now at each path written
   */
  async commitChanges(owner, name, branch, { message, changes, expectedHead }) {
    const R = `${repoUrl(owner, name)}/git`;
    if (!changes?.length) throw new Error('Nothing to commit.');
    const ref = await this.request('GET', `${R}/ref/heads/${encBranch(branch)}`);
    const head = ref.object.sha;
    if (expectedHead && head !== expectedHead) throw moved(branch);
    for (const c of changes) {
      if (c.expect === undefined) continue;
      const now = await this.blobSha(owner, name, c.path, head);
      if (now !== c.expect) {
        throw new GitHubError(409, c.expect === null
          ? `${c.path} already exists on GitHub.`
          : `${c.path} changed on GitHub since it was opened. Reload it (your text is kept as a draft) and commit again.`,
        { path: c.path });
      }
    }
    const base = await this.request('GET', `${R}/commits/${head}`);
    const tree = [];
    const blobs = {};
    for (const c of changes) {
      const entry = { path: c.path, mode: c.mode || '100644', type: 'blob' };
      if (c.delete) entry.sha = null;
      else if (c.sha) entry.sha = c.sha;
      else {
        const content = c.blobBase64 ?? encodeBase64(c.text);
        entry.sha = (await this.request('POST', `${R}/blobs`, { body: { content, encoding: 'base64' } })).sha;
      }
      if (entry.sha) blobs[c.path] = entry.sha;
      tree.push(entry);
    }
    const t = await this.request('POST', `${R}/trees`, { body: { base_tree: base.tree.sha, tree } });
    const commit = await this.request('POST', `${R}/commits`, { body: { message, tree: t.sha, parents: [head] } });
    try {
      await this.request('PATCH', `${R}/refs/heads/${encBranch(branch)}`, { body: { sha: commit.sha, force: false } });
    } catch (e) {
      // 422 "Update is not a fast forward": the branch moved after we read it
      if (e.status === 422 || e.status === 409) throw moved(branch);
      throw e;
    }
    return { sha: commit.sha, html_url: commit.html_url, blobs };
  }

  /** The blob sha of the file at `path` in `ref`, null if there is none ('dir' for a directory). */
  async blobSha(owner, name, path, ref) {
    let f;
    try {
      f = await this.request('GET', `${repoUrl(owner, name)}/contents/${enc(path)}?ref=${encRef(ref)}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    return Array.isArray(f) ? 'dir' : f.sha;
  }

  /** A new branch starting where `from` (a branch name) is now. */
  async createBranch(owner, name, branch, from) {
    const ref = await this.request('GET', `${repoUrl(owner, name)}/git/ref/heads/${encBranch(from)}`);
    await this.createRef(owner, name, branch, ref.object.sha);
  }

  /** The commit a branch points at, or null when there is no such branch (yet). */
  async branchSha(owner, name, branch) {
    try {
      const ref = await this.request('GET', `${repoUrl(owner, name)}/git/ref/heads/${encBranch(branch)}`);
      return ref.object.sha;
    } catch (e) {
      // 409: the repository is empty, as a new fork is while GitHub is still copying it
      if (e.status === 404 || e.status === 409) return null;
      throw e;
    }
  }

  async createRef(owner, name, branch, sha) {
    // in the body, not the URL, but '../tags/x' would still make a ref outside refs/heads/
    encBranch(branch);
    return this.request('POST', `${repoUrl(owner, name)}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha } });
  }

  /** Moves a branch to `sha`; only with `force` may that drop commits. */
  async updateRef(owner, name, branch, sha, force = false) {
    return this.request('PATCH', `${repoUrl(owner, name)}/git/refs/heads/${encBranch(branch)}`, { body: { sha, force } });
  }

  /**
   * Forks a repository to the user's account. GitHub answers at once and copies the
   * repository afterwards; if the user has forked it before, it hands back that fork.
   */
  async fork(owner, name) {
    return slimRepo(await this.request('POST', `${repoUrl(owner, name)}/forks`, { body: {} }));
  }

  /** Brings a fork's branch up to date with the same branch of the repository it came from. */
  async mergeUpstream(owner, name, branch) {
    return this.request('POST', `${repoUrl(owner, name)}/merge-upstream`, { body: { branch } });
  }

  async createPull(owner, name, { head, base, title, body }) {
    const pr = await this.request('POST', `${repoUrl(owner, name)}/pulls`, { body: { head, base, title, body, draft: false } });
    return { number: pr.number, html_url: pr.html_url };
  }

  /** Markdown rendered by GitHub itself: exact, but one request per render. */
  renderMarkdown(text, context) {
    return this.request('POST', '/markdown', { body: { text, mode: 'gfm', context }, accept: 'text/html', raw: 'text' });
  }
}

function moved(branch) {
  return new GitHubError(409, `Someone pushed to ${branch} while this was being committed, so GitHub refused it and nothing was committed. Try again.`, { moved: true });
}

function slimRepo(r) {
  return {
    owner: r.owner.login,
    name: r.name,
    full: r.full_name,
    private: !!r.private,
    defaultBranch: r.default_branch,
    canPush: !!r.permissions?.push,
    // for a fork, the repository it was forked from ("owner/name")
    parent: r.fork && r.parent ? r.parent.full_name : null,
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
