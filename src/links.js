// Where the editor is: the page's fragment names a file in a repository, so a link to
// the page opens that file, and the back button walks between files.
//
//   #repo=owner/name&ref=branch&path=docs/intro.md
//
// Plus resolving the links and images inside a document against the file's location.

/** @typedef {{owner: string, name: string, ref?: string, path?: string}} Location */

export function parseFragment(hash) {
  const p = new URLSearchParams(String(hash).replace(/^#/, ''));
  const repo = p.get('repo');
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const [owner, name] = repo.split('/');
  const loc = { owner, name };
  if (p.get('ref')) loc.ref = p.get('ref');
  if (p.get('path')) loc.path = p.get('path').replace(/^\/+/, '');
  return loc;
}

export function formatFragment(loc) {
  if (!loc) return '';
  // URLSearchParams would turn every '/' into %2F; keep paths readable.
  const q = (s) => encodeURIComponent(s).replace(/%2F/g, '/');
  let s = `#repo=${q(loc.owner)}/${q(loc.name)}`;
  if (loc.ref) s += `&ref=${q(loc.ref)}`;
  if (loc.path) s += `&path=${q(loc.path)}`;
  return s;
}

/**
 * A github.com URL (or "owner/name") as a location. The part after blob/ or tree/ is the
 * branch and the path run together, and branch names may contain '/', so it comes back
 * as `rest` for the caller to split once it knows the repository's branches.
 * @returns {{owner: string, name: string, rest?: string}|null}
 */
export function parseGitHubUrl(input) {
  const s = String(input).trim();
  let m = s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (m && !s.includes(':')) return { owner: m[1], name: m[2] };
  m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:blob|tree|edit)\/([^?#]+))?\/?(?:[?#].*)?$/);
  if (m) {
    const out = { owner: m[1], name: m[2] };
    if (m[3]) out.rest = decodeURIComponent(m[3]);
    return out;
  }
  m = s.match(/^(?:https?:\/\/)?raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\/([^?#]+)/);
  if (m) return { owner: m[1], name: m[2], rest: decodeURIComponent(m[3]) };
  return null;
}

/** Splits "branch/with/slashes/path/to/file.md" using the known branch names. */
export function splitRefPath(rest, branches) {
  const byLength = [...branches].sort((a, b) => b.length - a.length);
  for (const b of byLength) {
    if (rest === b) return { ref: b, path: '' };
    if (rest.startsWith(b + '/')) return { ref: b, path: rest.slice(b.length + 1) };
  }
  const i = rest.indexOf('/');
  return i < 0 ? { ref: rest, path: '' } : { ref: rest.slice(0, i), path: rest.slice(i + 1) };
}

export const dirname = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const basename = (path) => path.slice(path.lastIndexOf('/') + 1);

/** `rel` (a relative URL path) resolved against the directory `dir`, or null if it leaves the repository. */
export function joinPath(dir, rel) {
  const parts = rel.startsWith('/') ? [] : dir.split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const isAbsolute = (url) => /^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//.test(url);

/**
 * How a URL inside the document at `loc` should be followed.
 * @returns {{kind: 'external'|'anchor'|'repo', url: string, path?: string, hash?: string}}
 */
export function resolveRef(url, loc) {
  if (!url || isAbsolute(url)) return { kind: 'external', url };
  if (url.startsWith('#')) return { kind: 'anchor', url };
  const [, pathPart, query = '', hash = ''] = url.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  let path;
  try { path = joinPath(dirname(loc.path || ''), decodeURIComponent(pathPart)); } catch { path = null; }
  if (path === null) return { kind: 'external', url };
  return { kind: 'repo', url, path, hash: hash.slice(1), query };
}

/** The address of a file of the repository on github.com. */
export function githubUrl(loc, path, kind = 'blob') {
  const p = path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${loc.owner}/${loc.name}/${kind}/${encodeURIComponent(loc.ref).replace(/%2F/g, '/')}/${p}`;
}

export function rawUrl(loc, path) {
  const p = path.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${loc.owner}/${loc.name}/${encodeURIComponent(loc.ref).replace(/%2F/g, '/')}/${p}`;
}

// ---------------------------------------------------------------- recent files

const recentKey = (l) => `${l.owner}/${l.name}@${l.ref}:${l.path}`.toLowerCase();

/** The recent-files list with `loc` (opened at time `at`) moved to the front. */
export function addRecent(list, loc, at, max = 20) {
  const k = recentKey(loc);
  const entry = { owner: loc.owner, name: loc.name, ref: loc.ref, path: loc.path, at };
  return [entry, ...(Array.isArray(list) ? list : []).filter((r) => r && r.path && recentKey(r) !== k)].slice(0, max);
}

export function removeRecent(list, loc) {
  const k = recentKey(loc);
  return list.filter((r) => recentKey(r) !== k);
}

/** The recent-files list after the file at `loc` was renamed to `path` (it keeps its place). */
export function renameRecent(list, loc, path) {
  const k = recentKey(loc);
  const to = recentKey({ ...loc, path });
  // a file already listed under the new name gives way to the renamed one
  return list.filter((r) => recentKey(r) !== to || to === k).map((r) => (recentKey(r) === k ? { ...r, path } : r));
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", or a date. */
export function ago(at, now) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(at).toISOString().slice(0, 10);
}
