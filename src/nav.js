// Opening a location: the repository, its file list and the file are read first, and the
// editor takes them over together only once all of it has arrived. A failure part-way
// leaves the editor where it was, never showing one repository's files around another's
// text (#31).

import { MARKDOWN_EXT } from './github.js';
import { notTextKind } from './filetypes.js';

/** @typedef {import('./links.js').Location} Location */

export const sameRepo = (a, b) => !!(a && b && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase());

const sameFile = (a, b) => !!(a && b && a.owner === b.owner && a.name === b.name && a.ref === b.ref && a.path === b.path);

/**
 * The Markdown file a branch opens with: its README, else a top-level file, else any. For a
 * directory (`dir`, a github.com/…/tree/… link), its own README comes first.
 */
export function defaultFile(entries, dir = '') {
  const md = entries.filter((e) => e.type === 'file' && MARKDOWN_EXT.test(e.path));
  const inDir = dir && md.find((e) => e.path.startsWith(`${dir}/`) && /^readme\.(md|markdown)$/i.test(e.path.slice(dir.length + 1)));
  const f = inDir || md.find((e) => /^readme\.(md|markdown)$/i.test(e.path)) || md.find((e) => !e.path.includes('/')) || md[0];
  return f ? f.path : undefined;
}

/**
 * The error loadLocation rejects with for a file that is not opened as text: `notText` is
 * 'binary', 'encoding' (not UTF-8) or 'large' (see filetypes.js), `loc` the file.
 */
export class NotTextError extends Error {
  constructor(loc, notText, size) {
    super(`${loc.path} is not opened as text (${notText})`);
    this.loc = loc;
    this.notText = notText;
    this.size = size;
  }
}

/**
 * Reads what the editor needs to show `want`, changing nothing. `cur` is what is open now
 * ({repo, tree, loc}); what of it still applies is reused. `step(label, fn)` runs each
 * request (the editor shows the label while it runs).
 *
 * Resolves to {repo, tree, loc, file, same, branches}: `loc` is `want` completed (the
 * default branch, the branch's README) and has no path for a branch without Markdown
 * files; `file` is what getFile gave (null for a file that does not exist yet); `same`
 * says `loc` is the file open already (it is not read again); `branches`, for a repository
 * other than the current one, is its branch list on the way (a promise that never rejects:
 * null if it failed). Rejects if the repository or the file cannot be read, and with a
 * NotTextError for a file that is not text or too large (known by its name, its size in the
 * list, `cur.notText(loc)` — what an earlier try found — or once read), so that it is not
 * opened either. A path that is a directory opens its README.
 */
export async function loadLocation(gh, cur, want, step = (label, fn) => fn()) {
  const newRepo = !sameRepo(want, cur.repo);
  const repo = newRepo ? await step(`opening ${want.owner}/${want.name}`, () => gh.repo(want.owner, want.name)) : cur.repo;
  // only needed for the branch selector: do not hold the file up for it
  const branches = newRepo ? gh.branches(repo.owner, repo.name).catch(() => null) : null;
  const ref = want.ref || repo.defaultBranch;
  let tree = !newRepo && cur.tree && cur.tree.ref === ref ? cur.tree : null;
  if (!tree) {
    try {
      tree = { ...(await step('reading the file list', () => gh.tree(repo.owner, repo.name, ref))), ref };
    } catch {
      tree = { truncated: false, entries: [], ref };
    }
  }
  const loc = { owner: repo.owner, name: repo.name, ref };
  const dir = want.path && tree.entries.some((e) => e.type === 'dir' && e.path === want.path);
  const path = dir || !want.path ? defaultFile(tree.entries, dir ? want.path : '') : want.path;
  if (path) loc.path = path;
  const same = !!path && sameFile(loc, cur.loc);
  let file;
  if (path && !same) {
    const entry = tree.entries.find((e) => e.type === 'file' && e.path === path);
    const kind = cur.notText?.(loc) || notTextKind(path, entry?.size);
    if (kind) throw new NotTextError(loc, kind, entry?.size);
    file = await step(`opening ${path}`, () => gh.getFile(repo.owner, repo.name, path, ref));
    if (file && file.text === null) {
      throw new NotTextError(loc, file.tooLarge ? 'large' : file.notUtf8 ? 'encoding' : 'binary', file.size);
    }
  }
  return { repo, tree, loc, file, same, branches };
}

/**
 * A counter for answers that may arrive out of order: `begin()` returns a check that holds
 * only until `begin()` is called again, so a slow answer to an earlier request is dropped.
 */
export function latest() {
  let n = 0;
  return {
    begin() {
      const mine = ++n;
      return () => mine === n;
    },
  };
}
