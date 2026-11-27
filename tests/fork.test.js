import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, encodeBase64 } from '../src/github.js';
import { proposeChange, ForkError, headRef, compareUrl, isForkOf } from '../src/fork.js';

// A fake api.github.com: `routes` maps "METHOD /path" to a response, a function of the
// request returning one, or a list of responses served one after another (the last one
// repeats), as for a fork that is not ready at first.
function fake(routes) {
  const calls = [];
  const served = {};
  const f = async (url, init) => {
    const key = `${init.method} ${url.replace('https://api.github.com', '')}`;
    calls.push(init.body ? `${key} ${init.body}` : key);
    let r = routes[key];
    if (Array.isArray(r)) {
      const i = served[key] = (served[key] ?? -1) + 1;
      r = r[Math.min(i, r.length - 1)];
    }
    if (typeof r === 'function') r = r(init);
    if (!r) r = { status: 404, body: { message: 'Not Found' } };
    const { status = 200, body } = r;
    return { ok: status < 300, status, headers: new Map(), json: async () => body, text: async () => body };
  };
  f.calls = calls;
  return f;
}

const repo = (owner, name, extra = {}) => ({
  owner: { login: owner }, name, full_name: `${owner}/${name}`, private: false, default_branch: 'main',
  permissions: { push: true }, ...extra,
});
const UP = repo('me', 'docs', { permissions: { push: false } });
const FORK = repo('tester', 'docs', { fork: true, parent: UP });
const ref = (sha) => ({ body: { object: { sha } } });
const NOT_YET = { status: 409, body: { message: 'Git Repository is empty.' } };

const upstream = { owner: 'me', name: 'docs', ref: 'main', path: 'docs/guide.md' };
const change = {
  upstream, login: 'tester', branch: 'guide-x1', text: '# Guide\n\nbetter\n', message: 'Update guide.md',
  sha: 'g1', title: 'Update guide.md', body: '', installUrl: 'https://github.com/apps/meditor/installations/new',
};
const put = { body: { content: { sha: 'g2' }, commit: { sha: 'c9', html_url: 'https://github.com/tester/docs/commit/c9' } } };
const pull = { status: 201, body: { number: 7, html_url: 'https://github.com/me/docs/pull/7' } };
const noWait = { sleep: async () => {}, interval: 2000, tries: 5 };
const app = (f) => new GitHub({ token: async () => 'T', kind: 'app' }, f);

test('forks, waits for the copy, commits to a new branch at upstream\'s commit, opens the pull request', async () => {
  const f = fake({
    'GET /repos/me/docs/git/ref/heads/main': ref('up1'),
    'POST /repos/me/docs/forks': { status: 202, body: FORK },
    // the fork is not there yet, then empty, then ready
    'GET /repos/tester/docs/git/ref/heads/main': [{ status: 404, body: { message: 'Not Found' } }, NOT_YET, ref('old')],
    'POST /repos/tester/docs/git/refs': { status: 201, body: {} },
    'PUT /repos/tester/docs/contents/docs/guide.md': put,
    'POST /repos/me/docs/pulls': pull,
  });
  const said = [];
  let slept = 0;
  let created = null;
  const r = await proposeChange(new GitHub('T', f), change, {
    ...noWait, sleep: async () => { slept++; }, progress: (t) => said.push(t), created: (fk, b) => { created = `${fk.full}:${b}`; },
  });
  assert.equal(slept, 2);
  assert.equal(created, 'tester/docs:guide-x1');
  assert.deepEqual(f.calls, [
    'GET /repos/me/docs/git/ref/heads/main',
    'GET /repos/tester/docs', // no fork yet: 404
    'POST /repos/me/docs/forks {}',
    'GET /repos/tester/docs/git/ref/heads/main',
    'GET /repos/tester/docs/git/ref/heads/main',
    'GET /repos/tester/docs/git/ref/heads/main',
    'POST /repos/tester/docs/git/refs {"ref":"refs/heads/guide-x1","sha":"up1"}',
    `PUT /repos/tester/docs/contents/docs/guide.md {"message":"Update guide.md","content":"${encodeBase64(change.text)}","branch":"guide-x1","sha":"g1"}`,
    'POST /repos/me/docs/pulls {"head":"tester:guide-x1","base":"main","title":"Update guide.md","body":"","draft":false}',
  ]);
  assert.equal(r.fork.full, 'tester/docs');
  assert.equal(r.sha, 'g2');
  assert.deepEqual(r.pull, { number: 7, html_url: 'https://github.com/me/docs/pull/7' });
  assert.equal(r.synced, false);
  assert.ok(said.some((t) => /waiting for GitHub to copy me\/docs to tester\/docs \(4 s\)/.test(t)), said.join('\n'));
});

test('uses the fork the user has already, without forking again', async () => {
  const f = fake({
    'GET /repos/me/docs/git/ref/heads/main': ref('up1'),
    'GET /repos/tester/docs': { body: FORK },
    'GET /repos/tester/docs/git/ref/heads/main': ref('old'),
    'POST /repos/tester/docs/git/refs': { status: 201, body: {} },
    'PUT /repos/tester/docs/contents/docs/guide.md': put,
    'POST /repos/me/docs/pulls': pull,
  });
  await proposeChange(new GitHub('T', f), change, noWait);
  assert.ok(!f.calls.some((c) => c.includes('/forks')));
});

test('a repository of the same name that is not the fork is left alone', async () => {
  const f = fake({
    'GET /repos/me/docs/git/ref/heads/main': ref('up1'),
    'GET /repos/tester/docs': { body: repo('tester', 'docs') },
    'POST /repos/me/docs/forks': { status: 202, body: repo('tester', 'docs-1', { fork: true, parent: UP }) },
    'GET /repos/tester/docs-1/git/ref/heads/main': ref('old'),
    'POST /repos/tester/docs-1/git/refs': { status: 201, body: {} },
    'PUT /repos/tester/docs-1/contents/docs/guide.md': put,
    'POST /repos/me/docs/pulls': { status: 422, body: { message: 'Validation Failed' } },
  });
  const r = await proposeChange(new GitHub('T', f), change, noWait);
  assert.equal(r.fork.full, 'tester/docs-1');
  assert.ok(!f.calls.some((c) => c.startsWith('PUT /repos/tester/docs/')));
  // the pull request could not be opened: github.com's page for it instead
  assert.equal(r.pull, null);
  assert.match(r.pullError, /Validation Failed/);
  assert.equal(r.compare, 'https://github.com/me/docs/compare/main...tester:docs-1:guide-x1?expand=1');
});

test('a fork behind upstream is brought up to date when GitHub will not take the commit', async () => {
  const f = fake({
    'GET /repos/me/docs/git/ref/heads/main': ref('up1'),
    'GET /repos/tester/docs': { body: FORK },
    'GET /repos/tester/docs/git/ref/heads/main': ref('old'),
    'POST /repos/tester/docs/git/refs': [{ status: 422, body: { message: 'Object does not exist' } }, { status: 201, body: {} }],
    'POST /repos/tester/docs/merge-upstream': { body: { merge_type: 'fast-forward' } },
    'PUT /repos/tester/docs/contents/docs/guide.md': put,
    'POST /repos/me/docs/pulls': pull,
  });
  const r = await proposeChange(new GitHub('T', f), change, noWait);
  assert.equal(r.synced, true);
  assert.deepEqual(f.calls.slice(3, 6), [
    'POST /repos/tester/docs/git/refs {"ref":"refs/heads/guide-x1","sha":"up1"}',
    'POST /repos/tester/docs/merge-upstream {"branch":"main"}',
    'POST /repos/tester/docs/git/refs {"ref":"refs/heads/guide-x1","sha":"up1"}',
  ]);
});

test('a fork that cannot be brought up to date is explained', async () => {
  const f = fake({
    'GET /repos/me/docs/git/ref/heads/main': ref('up1'),
    'GET /repos/tester/docs': { body: FORK },
    'GET /repos/tester/docs/git/ref/heads/main': ref('old'),
    'POST /repos/tester/docs/git/refs': { status: 422, body: { message: 'Object does not exist' } },
    'POST /repos/tester/docs/merge-upstream': { status: 409, body: { message: 'There are merge conflicts' } },
  });
  await assert.rejects(proposeChange(new GitHub('T', f), change, noWait), (e) => e instanceof ForkError
    && /merge conflicts/.test(e.message) && /Sync it on GitHub/.test(e.message) && e.actions[0].url === 'https://github.com/tester/docs');
});

test('signed in with the app, a fork meditor is not installed on sends the user to install it', async () => {
  for (const status of [403, 404]) {
    const f = fake({
      'GET /repos/me/docs/git/ref/heads/main': ref('up1'),
      'POST /repos/me/docs/forks': { status: 202, body: FORK },
      'GET /repos/tester/docs/git/ref/heads/main': ref('old'),
      'POST /repos/tester/docs/git/refs': { status, body: { message: 'Resource not accessible by integration' } },
    });
    await assert.rejects(proposeChange(app(f), change, noWait), (e) => e instanceof ForkError
      && /installed on all your repositories/.test(e.message)
      && e.actions[0].url === change.installUrl);
  }
});

test('with a token that may not write to the fork, says what the token needs', async () => {
  const f = fake({
    'GET /repos/me/docs/git/ref/heads/main': ref('up1'),
    'GET /repos/tester/docs': { body: FORK },
    'GET /repos/tester/docs/git/ref/heads/main': ref('old'),
    'POST /repos/tester/docs/git/refs': { status: 201, body: {} },
    'PUT /repos/tester/docs/contents/docs/guide.md': { status: 403, body: { message: 'Resource not accessible by personal access token' } },
  });
  await assert.rejects(proposeChange(new GitHub('T', f), change, noWait), (e) => e instanceof ForkError
    && /Contents: Read and write/.test(e.message) && /personal access token/.test(e.message));
});

test('GitHub refusing the fork sends the user to fork it by hand (and, with the app, to install it there)', async () => {
  const routes = {
    'GET /repos/me/docs/git/ref/heads/main': ref('up1'),
    'POST /repos/me/docs/forks': { status: 403, body: { message: 'Resource not accessible by integration' } },
  };
  await assert.rejects(proposeChange(app(fake(routes)), change, noWait), (e) => e instanceof ForkError
    && /installed on the fork/.test(e.message)
    && e.actions.map((a) => a.url).join(' ') === `https://github.com/me/docs/fork ${change.installUrl}`);
  await assert.rejects(proposeChange(new GitHub('T', fake(routes)), change, noWait), (e) => e instanceof ForkError
    && !/installed/.test(e.message) && e.actions.length === 1);
});

test('gives up waiting for a fork that does not appear', async () => {
  const f = fake({
    'GET /repos/me/docs/git/ref/heads/main': ref('up1'),
    'POST /repos/me/docs/forks': { status: 202, body: { ...FORK, private: true } },
    'GET /repos/tester/docs/git/ref/heads/main': NOT_YET,
  });
  await assert.rejects(proposeChange(app(f), change, noWait), (e) => e instanceof ForkError
    && /still copying/.test(e.message) && /installed on the fork/.test(e.message));
  assert.equal(f.calls.filter((c) => c === 'GET /repos/tester/docs/git/ref/heads/main').length, 6);
});

test('the file changed upstream: GitHub refuses the commit, and a second attempt takes the branch over', async () => {
  const routes = {
    'GET /repos/me/docs/git/ref/heads/main': ref('up1'),
    'GET /repos/tester/docs': { body: FORK },
    'GET /repos/tester/docs/git/ref/heads/main': ref('old'),
    'POST /repos/tester/docs/git/refs': { status: 201, body: {} },
    'PUT /repos/tester/docs/contents/docs/guide.md': { status: 409, body: { message: 'is at g0 but expected g1' } },
  };
  let f = fake(routes);
  let created = false;
  await assert.rejects(proposeChange(new GitHub('T', f), change, { ...noWait, created: () => { created = true; } }),
    (e) => e.status === 409 && /changed on GitHub/.test(e.message));
  assert.equal(created, true);
  // after loading the latest version (and upstream moving on), the same branch name again
  f = fake({
    ...routes,
    'GET /repos/me/docs/git/ref/heads/main': ref('up2'),
    'POST /repos/tester/docs/git/refs': { status: 422, body: { message: 'Reference already exists' } },
    'PATCH /repos/tester/docs/git/refs/heads/guide-x1': { body: {} },
    'PUT /repos/tester/docs/contents/docs/guide.md': put,
    'POST /repos/me/docs/pulls': pull,
  });
  await proposeChange(new GitHub('T', f), { ...change, sha: 'g0', resume: true }, noWait);
  assert.ok(f.calls.includes('PATCH /repos/tester/docs/git/refs/heads/guide-x1 {"sha":"up2","force":true}'));
  // without `resume` a branch of that name is not the user's to take
  f = fake({ ...routes, 'POST /repos/tester/docs/git/refs': { status: 422, body: { message: 'Reference already exists' } } });
  await assert.rejects(proposeChange(new GitHub('T', f), change, noWait), (e) => e.status === 422 && /already exists/.test(e.message));
});

test('one\'s own repository is not forked', async () => {
  const f = fake({});
  await assert.rejects(proposeChange(new GitHub('T', f), { ...change, login: 'Me' }, noWait), ForkError);
  assert.equal(f.calls.length, 0);
});

test('pull request heads and compare pages for forks', () => {
  const fork = { owner: 'tester', name: 'docs' };
  assert.equal(headRef(fork, 'fix/x'), 'tester:fix/x');
  assert.equal(compareUrl({ owner: 'me', name: 'docs', ref: 'main' }, fork, 'fix/x'),
    'https://github.com/me/docs/compare/main...tester:docs:fix%2Fx?expand=1');
  assert.equal(isForkOf({ parent: 'Me/Docs' }, { owner: 'me', name: 'docs' }), true);
  assert.equal(isForkOf({ parent: null }, { owner: 'me', name: 'docs' }), false);
});
