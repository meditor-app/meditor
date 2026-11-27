// Proposing a change to a repository the user cannot push to, as github.com's own editor
// does: fork it to the user's account (or find the fork made before), commit the file to a
// new branch of the fork, and open a pull request from that branch.
//
// Only GitHub calls (through github.js) and waiting, which is injected: the whole sequence
// runs in the tests against a fake fetch.

/** Something the user has to fix on github.com; `actions` are the pages to do it on. */
export class ForkError extends Error {
  /** @param {...({url: string, label: string}|null)} actions (nulls are left out) */
  constructor(message, ...actions) {
    super(message);
    this.actions = actions.filter(Boolean);
  }
}

const lower = (s) => String(s).toLowerCase();
const detail = (e) => e.body?.message || e.message;

/** Whether `repo` (a slimRepo) is a fork of `up` ({owner, name}). */
export const isForkOf = (repo, up) => !!repo?.parent && lower(repo.parent) === lower(`${up.owner}/${up.name}`);

/** A pull request's `head` when the branch is in a fork: "user:branch". */
export const headRef = (fork, branch) => `${fork.owner}:${branch}`;

/** github.com's page for opening the pull request by hand, if the API would not open it. */
export function compareUrl(up, fork, branch) {
  const e = encodeURIComponent;
  return `https://github.com/${up.owner}/${up.name}/compare/${e(up.ref)}...${e(fork.owner)}:${e(fork.name)}:${e(branch)}?expand=1`;
}

/** The user's fork of `up`, if they have one under the same name; null otherwise. */
export async function findFork(gh, up, login) {
  try {
    const r = await gh.repo(login, up.name);
    return isForkOf(r, up) ? r : null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/**
 * Forks `upstream` (or finds the user's fork), commits `text` to a new branch there, and
 * opens a pull request against `upstream.ref`.
 *
 * The branch starts at the commit `upstream.ref` is at now, not where the fork's own copy
 * of that branch is (the fork may be far behind): a fork shares its objects with the
 * repository it came from, so GitHub normally takes that commit as it is. When it does
 * not, the fork's branch is brought up to date first (merge-upstream). Either way the file
 * on the new branch is the file as it is upstream, so `sha` (the version the edit started
 * from) is the right one to replace: if the file changed upstream meanwhile, GitHub
 * refuses with 409, just as for a direct commit, instead of undoing that change.
 *
 * @param {import('./github.js').GitHub} gh
 * @param {{upstream: {owner: string, name: string, ref: string, path: string}, login: string,
 *   branch: string, text: string, message: string, sha: string|null, title: string, body: string,
 *   installUrl?: string, resume?: boolean, images?: {path: string, blobBase64: string}[]}} o
 *   `images`: pasted images to commit with the document (in the same commit; each must be
 *   new, as for a direct commit)
 *   `resume`: an earlier attempt created `branch` in the fork and failed after that (the
 *   branch holds nothing of the user's), so take it over rather than refuse
 * @param {{progress?(text: string): void, created?(fork: object, branch: string): void,
 *   sleep?(ms: number): Promise<void>, interval?: number, tries?: number}} [env]
 * @returns {Promise<{fork: object, branch: string, sha: string, commit: {sha: string, html_url: string},
 *   pull: {number: number, html_url: string}|null, pullError: string|null, compare: string, synced: boolean}>}
 */
export async function proposeChange(gh, o, env = {}) {
  const say = env.progress || (() => {});
  const sleep = env.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const interval = env.interval ?? 2000;
  const tries = env.tries ?? 45;
  const up = o.upstream;
  const full = `${up.owner}/${up.name}`;
  const app = gh.auth?.kind === 'app';
  const install = app && o.installUrl ? { url: o.installUrl, label: 'install meditor on your fork' } : null;

  if (lower(o.login) === lower(up.owner)) throw new ForkError(`${full} is in your own account, so it cannot be forked there.`);

  say(`reading ${full} @ ${up.ref}`);
  const base = await gh.branchSha(up.owner, up.name, up.ref);
  if (!base) throw new ForkError(`${full} has no branch ${up.ref} any more.`);

  // 1. the fork
  say('looking for your fork');
  let fork = await findFork(gh, up, o.login);
  if (!fork) {
    say(`forking ${full} to your account`);
    try {
      fork = await gh.fork(up.owner, up.name);
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) throw e;
      // (signed in through the app, a private fork the app is not installed on looks
      // missing too, so it may be there already)
      throw new ForkError(`GitHub did not let meditor fork ${full} (${detail(e)}). Fork it on GitHub, then try again: meditor will find your fork and use it.`
        + (app ? ' Signed in with GitHub, meditor must be installed on the fork as well (or on all your repositories).' : ''),
        { url: `https://github.com/${full}/fork`, label: 'fork it on GitHub' }, install);
    }
  }
  // GitHub copies the repository after it has answered (a fork found here may be one an
  // earlier attempt gave up waiting for): wait until the copy has its default branch
  for (let i = 0; !await gh.branchSha(fork.owner, fork.name, fork.defaultBranch); i++) {
    if (i >= tries) {
      throw new ForkError(`GitHub is still copying ${full} to ${fork.full}. Try again in a minute: meditor will use the fork once it is ready.`
        + (app && fork.private ? ' If it stays like this, meditor may need to be installed on the fork.' : ''), install);
    }
    say(`waiting for GitHub to copy ${full} to ${fork.full} (${Math.round(((i + 1) * interval) / 1000)} s)`);
    await sleep(interval);
  }

  // Signed in through the app, meditor may write only where it is installed, and a new
  // fork is covered only if it is installed on all of the user's repositories.
  const cannotWrite = (e) => {
    if (e.status !== 403 && e.status !== 404) return e;
    if (app) {
      return new ForkError(`meditor may not write to your fork ${fork.full}: signed in with GitHub, meditor can change only the repositories it is installed on, and a new fork is among them only if it is installed on all your repositories. Add ${fork.full} to meditor's installation (or choose “All repositories”), then press “fork and propose” again.`, install);
    }
    return new ForkError(`Your token may not write to your fork ${fork.full} (${detail(e)}). A fine-grained token needs “Contents: Read and write” on it, and one limited to selected repositories does not cover a new fork: add ${fork.full} to the token (or use another), then try again.`,
      { url: 'https://github.com/settings/personal-access-tokens', label: 'your tokens' });
  };

  // 2. the branch, at upstream's commit
  say(`creating the branch ${o.branch} in ${fork.full}`);
  let synced = false;
  try {
    await gh.createRef(fork.owner, fork.name, o.branch, base);
  } catch (e) {
    if (e.status !== 422) throw cannotWrite(e);
    if (/already exists/i.test(detail(e))) {
      if (!o.resume) throw e;
      await gh.updateRef(fork.owner, fork.name, o.branch, base, true).catch((e2) => { throw cannotWrite(e2); });
    } else {
      // GitHub would not take upstream's commit into the fork: bring the fork up to date
      say(`bringing ${fork.full} @ ${up.ref} up to date with ${full}`);
      try {
        await gh.mergeUpstream(fork.owner, fork.name, up.ref);
      } catch (e2) {
        if (e2.status === 403 || e2.status === 404) throw cannotWrite(e2);
        throw new ForkError(`Your fork ${fork.full} does not have the latest ${up.ref} of ${full}, and GitHub could not bring it up to date (${detail(e2)}); the fork's ${up.ref} may have commits of its own. Sync it on GitHub, then try again.`,
          { url: `https://github.com/${fork.full}`, label: 'open your fork' });
      }
      synced = true;
      await gh.createRef(fork.owner, fork.name, o.branch, base).catch((e3) => { throw cannotWrite(e3); });
    }
  }
  env.created?.(fork, o.branch);

  // 3. the commit
  say(`committing to ${fork.full} @ ${o.branch}`);
  let put;
  try {
    if (o.images?.length) {
      const changes = [{ path: up.path, text: o.text, expect: o.sha ?? null }];
      for (const i of o.images) changes.push({ path: i.path, blobBase64: i.blobBase64, expect: null });
      const c = await gh.commitChanges(fork.owner, fork.name, o.branch, { message: o.message, changes });
      put = { sha: c.blobs[up.path], commit: { sha: c.sha, html_url: c.html_url } };
    } else {
      put = await gh.putFile(fork.owner, fork.name, up.path, { text: o.text, message: o.message, branch: o.branch, sha: o.sha });
    }
  } catch (e) {
    throw cannotWrite(e);
  }

  // 4. the pull request
  say('opening the pull request');
  let pull = null;
  let pullError = null;
  try {
    pull = await gh.createPull(up.owner, up.name, { head: headRef(fork, o.branch), base: up.ref, title: o.title, body: o.body });
  } catch (e) {
    pullError = e.message;
  }
  return { fork, branch: o.branch, sha: put.sha, commit: put.commit, pull, pullError, compare: compareUrl(up, fork, o.branch), synced };
}
