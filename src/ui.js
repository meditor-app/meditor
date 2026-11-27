// The page: account, repository and file navigation, the editor, the preview, commits.
// The only module that touches the DOM.

import { renderMarkdown, sanitizeHtml, escapeHtml, ID_PREFIX } from './markdown.js';
import { GitHub, MARKDOWN_EXT } from './github.js';
import { Auth, AuthError } from './auth.js';
import { GITHUB_APP } from './config.js';
import {
  parseFragment, formatFragment, parseGitHubUrl, splitRefPath, resolveRef, githubUrl, rawUrl,
  dirname, basename, joinPath, addRecent, removeRecent, renameRecent, ago,
} from './links.js';
import {
  wrap, togglePrefix, orderedList, taskList, heading, link, codeBlock, table, rule, indent,
  continueList, toggleTask, countWords,
} from './edit.js';
import { lineDiff } from './diff.js';

const $ = (id) => document.getElementById(id);
const K = {
  oldToken: 'meditor:token',
  pending: 'meditor:signin',
  scratch: 'meditor:scratch',
  draft: 'meditor:draft:',
  panels: 'meditor:panels',
  prefs: 'meditor:prefs',
  recent: 'meditor:recent',
  repos: 'meditor:repos',
};
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

const WELCOME = `# Welcome to meditor

This is the **scratchpad**: it lives only in this browser. Type on the left, see the page on
the right.

To edit a file on GitHub, choose **open repository…** above, pick a repository and a file,
edit, and **commit…** (\`Ctrl+S\`). You can commit straight to the branch or open a pull
request.

- Public repositories open without signing in.
- For private ones, and to commit, **sign in** (top right).
- Unsaved changes are kept in this browser as drafts, file by file, until you commit them.

## Markdown, quickly

| you type | you get |
| --- | --- |
| \`**bold**\`, \`_italic_\`, \`~~struck~~\` | **bold**, _italic_, ~~struck~~ |
| \`[a link](https://github.com)\` | [a link](https://github.com) |
| \`- [ ] a task\` | a box you can tick, here too |

- [x] write the README
- [ ] proof-read it

> [!TIP]
> \`Ctrl+B\`, \`Ctrl+I\`, \`Ctrl+K\` format the selection; \`Tab\` indents a list item;
> \`Enter\` continues a list.
`;

const store = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode or full */ }
  },
  del(k) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  },
};

const state = {
  gh: new GitHub(null),
  user: null,
  repos: null,
  repo: null, // slimRepo of the open repository
  branches: [],
  tree: null, // { truncated, entries }
  open: new Set(), // expanded directories
  loc: null, // { owner, name, ref, path } of the open file, or null for the scratchpad
  doc: { base: '', sha: null, isNew: false },
  renderer: 'local',
  view: 'split',
  sync: true,
  images: new Map(), // repo image path -> object URL (private repositories)
  loading: 0,
};

// ---------------------------------------------------------------- small helpers

let toastTimer;
function toast(html, ms = 4000) {
  const t = $('toast');
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function status(text, kind = '') {
  const s = $('status');
  s.textContent = text;
  s.className = `status ${kind}`;
}

async function busy(label, fn) {
  state.loading++;
  status(label + '…');
  try {
    return await fn();
  } catch (e) {
    status(e.message || String(e), 'bad');
    throw e;
  } finally {
    state.loading--;
    if (!state.loading && $('status').textContent === label + '…') status('');
  }
}

const sameRepo = (a, b) => a && b && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();
const draftKey = (loc) => `${K.draft}${loc.owner}/${loc.name}@${loc.ref}:${loc.path}`;

// ---------------------------------------------------------------- account

// Credentials live in localStorage, or in sessionStorage when the user asked not to be
// remembered; reads look in both.
let rememberCreds = true;
const credStore = {
  get(k) {
    try { return localStorage.getItem(k) ?? sessionStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try {
      (rememberCreds ? sessionStorage : localStorage).removeItem(k);
      (rememberCreds ? localStorage : sessionStorage).setItem(k, v);
    } catch { /* private mode: lasts for this page only */ }
  },
  del(k) {
    try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch { /* ignore */ }
  },
};
const auth = new Auth(GITHUB_APP, credStore);
const installUrl = () => `https://github.com/apps/${GITHUB_APP.slug}/installations/new`;

/** Whoever the stored credentials say, checked with GitHub. */
async function useCredentials() {
  const gh = new GitHub(auth);
  state.user = await gh.user();
  state.gh = gh;
  // keep the cached repository list: it is checked against the user, and refreshed anyway
  state.repos = null;
  reposFresh = false;
  showAccount();
}

async function signInWithToken(token, remember) {
  const user = await new GitHub(token).user();
  rememberCreds = remember;
  auth.usePat(token);
  state.gh = new GitHub(auth);
  state.user = user;
  forgetRepos();
  showAccount();
}

async function signInWithGitHub() {
  saveDraftNow();
  const { url, pending } = await auth.begin(location.href);
  sessionStorage.setItem(K.pending, JSON.stringify({ ...pending, hash: location.hash }));
  location.assign(url);
}

/**
 * Back from github.com: either signed in (?code=…&state=…), or meditor was installed on more
 * repositories (?installation_id=…&setup_action=…). Returns where to go next.
 */
async function finishSignIn() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('setup_action') && !q.has('error')) return;
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(K.pending) || 'null'); sessionStorage.removeItem(K.pending); } catch { /* none */ }
  // drop the query: the code is single-use and should not stay in the address or history
  history.replaceState(null, '', location.pathname + (pending?.hash || location.hash));
  if (q.has('error')) {
    toast(`GitHub did not sign you in: ${escapeHtml(q.get('error_description') || q.get('error'))}`, 8000);
    return;
  }
  if (q.has('code')) {
    try {
      rememberCreds = true;
      await auth.complete(q.get('code'), q.get('state'), pending);
      forgetRepos();
      await useCredentials();
      const inst = await state.gh.request('GET', '/user/installations?per_page=1').catch(() => null);
      if (inst && inst.total_count === 0) {
        toast(`Signed in as <b>${escapeHtml(state.user.login)}</b>. Now <a href="${escapeHtml(installUrl())}">choose the repositories</a> meditor may edit.`, 15000);
      } else {
        toast(`Signed in as <b>${escapeHtml(state.user.login)}</b>.`);
      }
    } catch (e) {
      auth.save(null);
      toast(escapeHtml(e.message), 8000);
    }
    return;
  }
  // setup_action=install|update: meditor can see a different set of repositories now
  forgetRepos();
  toast(auth.kind === 'app'
    ? 'meditor can now see the repositories you chose. Open one with “open…”.'
    : 'meditor is installed. Sign in with GitHub to use it.', 8000);
}

function signOut() {
  const was = auth.signOut();
  state.gh = new GitHub(null);
  state.user = null;
  forgetRepos();
  for (const url of state.images.values()) URL.revokeObjectURL(url);
  state.images.clear();
  showAccount();
  toast(was?.kind === 'pat'
    ? 'Signed out. The token is forgotten by this browser; revoke it on GitHub if you no longer need it.'
    : 'Signed out.');
}

function showAccount() {
  const b = $('account');
  if (state.user) {
    b.innerHTML = `<img src="${escapeHtml(state.user.avatar_url)}&amp;s=40" alt=""> ${escapeHtml(state.user.login)}`;
    b.title = 'signed in to GitHub; click to sign out';
  } else {
    b.textContent = 'sign in';
    b.title = 'sign in to GitHub';
  }
  updateCommitButton();
  renderTree(); // whether files can be renamed or deleted
}

function openSignin() {
  $('tokenInput').value = '';
  $('signinError').hidden = true;
  $('signout').hidden = !state.user;
  const who = $('whoBox');
  who.hidden = !state.user;
  if (state.user) {
    const how = auth.kind === 'app'
      ? `with GitHub · <a href="${escapeHtml(installUrl())}" target="_blank" rel="noopener">choose repositories ↗</a>`
      : 'with a personal access token';
    who.innerHTML = `<img src="${escapeHtml(state.user.avatar_url)}&amp;s=56" alt=""><span>Signed in as <b>${escapeHtml(state.user.login)}</b> ${how}</span>`;
  }
  $('appBox').hidden = !auth.enabled || !!state.user;
  $('installLink').href = installUrl();
  $('patBox').open = !auth.enabled && !state.user;
  $('patBox').hidden = !!state.user;
  $('signinDlg').showModal();
}

// ---------------------------------------------------------------- navigation

function go(loc, replace = false) {
  const frag = loc ? formatFragment(loc) : '';
  const url = frag || location.pathname + location.search;
  if (replace) history.replaceState(null, '', url);
  else if (frag !== location.hash) history.pushState(null, '', url);
  route();
}

let routing = Promise.resolve();
function route() {
  // one navigation at a time, in order
  routing = routing.then(() => applyLocation(parseFragment(location.hash))).catch((e) => console.error(e));
  return routing;
}

async function applyLocation(loc) {
  if (!loc) {
    if (state.loc) saveDraftNow();
    state.repo = null;
    state.tree = null;
    openScratch();
    renderTree();
    return;
  }
  if (!sameRepo(loc, state.repo)) {
    try {
      await busy(`opening ${loc.owner}/${loc.name}`, async () => {
        state.repo = await state.gh.repo(loc.owner, loc.name);
        state.branches = [];
        state.tree = null;
        state.open = new Set();
      });
    } catch {
      state.repo = null;
      renderTree();
      if (!state.loc) openScratch();
      return;
    }
    // the branch list is only needed for the selector; do not hold the file up for it
    state.gh.branches(state.repo.owner, state.repo.name).then((bs) => {
      state.branches = bs;
      renderBranches();
    }).catch(() => {});
  }
  const repo = state.repo;
  if (!loc.ref) {
    go({ owner: repo.owner, name: repo.name, ref: repo.defaultBranch, path: loc.path }, true);
    return;
  }
  if (!state.tree || state.tree.ref !== loc.ref) {
    try {
      await busy('reading the file list', async () => {
        const t = await state.gh.tree(repo.owner, repo.name, loc.ref);
        state.tree = { ...t, ref: loc.ref };
      });
    } catch {
      state.tree = { truncated: false, entries: [], ref: loc.ref };
    }
  }
  renderBranches();
  if (!loc.path) {
    const md = state.tree.entries.filter((e) => e.type === 'file' && MARKDOWN_EXT.test(e.path));
    const readme = md.find((e) => /^readme\.(md|markdown)$/i.test(e.path)) || md.find((e) => !e.path.includes('/')) || md[0];
    if (readme) {
      go({ owner: repo.owner, name: repo.name, ref: loc.ref, path: readme.path }, true);
      return;
    }
    renderTree();
    status('This branch has no Markdown files. Create one with “＋ new”.', 'warn');
    return;
  }
  await openFile({ owner: repo.owner, name: repo.name, ref: loc.ref, path: loc.path });
}

function openScratch() {
  if (state.loc) saveDraftNow();
  state.loc = null;
  state.doc = { base: null, sha: null, isNew: false };
  setText(store.get(K.scratch, WELCOME));
  showDoc();
}

async function openFile(loc) {
  if (state.loc && draftKey(state.loc) === draftKey(loc)) return;
  if (state.loc) saveDraftNow();
  let file;
  try {
    file = await busy(`opening ${loc.path}`, () => state.gh.getFile(loc.owner, loc.name, loc.path, loc.ref));
  } catch {
    return;
  }
  state.loc = loc;
  state.doc = file ? { base: file.text, sha: file.sha, isNew: false } : { base: '', sha: null, isNew: true };
  rememberRecent(loc);
  const draft = store.get(draftKey(loc));
  let banner = null;
  if (draft && draft.text !== state.doc.base) {
    if (draft.sha === state.doc.sha) {
      setText(draft.text);
      banner = { text: `Restored your unsaved changes from ${when(draft.at)}.`, actions: [['discard them', () => discardDraft()]] };
    } else {
      setText(state.doc.base);
      banner = {
        text: `You have unsaved changes from ${when(draft.at)}, but the file has changed on GitHub since.`,
        actions: [['restore my version', () => { setText(draft.text, true); hideBanner(); }], ['discard it', () => discardDraft()]],
      };
    }
  } else if (state.doc.isNew) {
    const title = basename(loc.path).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    setText(`# ${title.charAt(0).toUpperCase()}${title.slice(1)}\n\n`);
  } else {
    if (draft) store.del(draftKey(loc));
    setText(state.doc.base);
  }
  showDoc();
  if (banner) showBanner(banner.text, banner.actions);
  else hideBanner();
  if (state.doc.isNew) status(`${loc.path} is new: it will be created when you commit it.`, 'warn');
  else status('');
  $('src').setSelectionRange(0, 0);
  $('src').scrollTop = 0;
  $('previewScroll').scrollTop = 0;
}

function when(t) {
  if (!t) return 'earlier';
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString();
}

function discardDraft() {
  if (!state.loc) return;
  store.del(draftKey(state.loc));
  setText(state.doc.base, true);
  hideBanner();
  renderTree();
}

function showBanner(text, actions = []) {
  const b = $('banner');
  b.replaceChildren();
  const span = document.createElement('span');
  span.textContent = text;
  b.append(span);
  for (const [label, fn] of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', fn);
    b.append(btn);
  }
  b.hidden = false;
}

function hideBanner() { $('banner').hidden = true; }

function showDoc() {
  const loc = state.loc;
  $('docPath').textContent = loc ? `‎${loc.path}` : 'scratchpad';
  $('docPath').title = loc ? `${loc.owner}/${loc.name} @ ${loc.ref} : ${loc.path}` : 'kept in this browser only';
  const gh = $('viewOnGh');
  gh.hidden = !loc || state.doc.isNew;
  if (loc) gh.href = githubUrl(loc, loc.path);
  document.title = loc ? `${basename(loc.path)} · ${loc.owner}/${loc.name} — meditor` : 'meditor — Markdown editor for GitHub';
  renderTree();
  updateDirty();
  updateCommitButton();
  renderPreview(true);
}

// ---------------------------------------------------------------- the editor

const src = () => $('src');

/** Replace the whole text (opening a file); `undoable` keeps it on the undo stack. */
function setText(text, undoable = false) {
  const ta = src();
  if (undoable) {
    applyEdit({ text, start: 0, end: 0 });
    return;
  }
  ta.value = text;
  lineTops = null;
  onTextChanged();
}

/** Apply an edit computed by edit.js through the browser, so Ctrl+Z can undo it. */
function applyEdit(r) {
  const ta = src();
  const old = ta.value;
  let p = 0;
  while (p < old.length && p < r.text.length && old[p] === r.text[p]) p++;
  let s = 0;
  while (s < old.length - p && s < r.text.length - p && old[old.length - 1 - s] === r.text[r.text.length - 1 - s]) s++;
  const ins = r.text.slice(p, r.text.length - s);
  ta.focus();
  ta.setSelectionRange(p, old.length - s);
  let ok = false;
  try {
    ok = ins ? document.execCommand('insertText', false, ins) : (p === old.length - s || document.execCommand('delete'));
  } catch { ok = false; }
  if (!ok || ta.value !== r.text) {
    ta.value = r.text;
  }
  ta.setSelectionRange(r.start, r.end);
  onTextChanged();
}

const sel = () => ({ text: src().value, start: src().selectionStart, end: src().selectionEnd });

const COMMANDS = {
  bold: (s) => wrap(s, '**', '**', 'bold text'),
  italic: (s) => wrap(s, '_', '_', 'italic text'),
  strike: (s) => wrap(s, '~~', '~~', 'struck text'),
  code: (s) => wrap(s, '`', '`', 'code'),
  h1: (s) => heading(s, 1),
  h2: (s) => heading(s, 2),
  h3: (s) => heading(s, 3),
  ul: (s) => togglePrefix(s, '- '),
  ol: (s) => orderedList(s),
  task: (s) => taskList(s),
  quote: (s) => togglePrefix(s, '> '),
  link: (s) => link(s),
  image: (s) => link(s, true),
  codeblock: (s) => codeBlock(s),
  table: (s) => table(s),
  rule: (s) => rule(s),
};

function command(name) {
  if (state.view === 'preview') setView('split');
  applyEdit(COMMANDS[name](sel()));
}

let draftTimer;
let renderTimer;
function onTextChanged() {
  lineTops = null;
  updateDirty();
  updateStats();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 400);
  clearTimeout(renderTimer);
  const big = src().value.length > 200000;
  renderTimer = setTimeout(() => renderPreview(), state.renderer === 'github' ? 1200 : big ? 300 : 60);
}

function saveDraftNow() {
  clearTimeout(draftTimer);
  const text = src().value;
  if (!state.loc) {
    store.set(K.scratch, text);
    return;
  }
  const key = draftKey(state.loc);
  const had = store.get(key) !== null;
  if (text !== state.doc.base) store.set(key, { text, sha: state.doc.sha, at: Date.now() });
  else store.del(key);
  if (had !== (text !== state.doc.base)) renderTree();
}

const isDirty = () => !!state.loc && (state.doc.isNew || src().value !== state.doc.base);

function updateDirty() {
  $('dirty').hidden = !isDirty();
}

function updateStats() {
  const ta = src();
  const text = ta.value;
  const before = text.slice(0, ta.selectionStart);
  const line = before.split('\n').length;
  const col = ta.selectionStart - before.lastIndexOf('\n');
  const words = countWords(text);
  $('stats').textContent = `Ln ${line}, Col ${col} · ${words.toLocaleString()} words · ${text.split('\n').length.toLocaleString()} lines`;
}

function updateCommitButton() {
  const b = $('commit');
  const loc = state.loc;
  b.disabled = !loc;
  b.title = !loc ? 'open a file from a repository to commit it'
    : !state.user ? 'sign in to commit'
      : 'commit this file to GitHub (Ctrl+S)';
}

function onKeyDown(e) {
  const ta = src();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey) {
    const k = e.key.toLowerCase();
    const map = { b: 'bold', i: 'italic', k: 'link', e: 'code', 1: 'h1', 2: 'h2', 3: 'h3' };
    if (map[k] && !e.shiftKey) {
      e.preventDefault();
      command(map[k]);
      return;
    }
  }
  if (e.key === 'Tab' && !mod && !e.altKey) {
    e.preventDefault();
    applyEdit(indent(sel(), e.shiftKey));
    return;
  }
  if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.isComposing) {
    const r = continueList(sel());
    if (r) {
      e.preventDefault();
      applyEdit(r);
      // keep the new line in view
      if (ta.selectionEnd === ta.value.length) ta.scrollTop = ta.scrollHeight;
    }
  }
}

// ---------------------------------------------------------------- the preview

function resolveImage(url) {
  const loc = state.loc;
  if (!loc) return { src: url };
  const r = resolveRef(url, loc);
  if (r.kind !== 'repo') return { src: url };
  if (state.repo && !state.repo.private) return { src: rawUrl(loc, r.path) };
  const key = `${loc.owner}/${loc.name}@${loc.ref}:${r.path}`;
  return { src: state.images.get(key) || PIXEL, path: r.path };
}

function resolveLink(url) {
  const loc = state.loc;
  if (!loc) return url;
  const r = resolveRef(url, loc);
  if (r.kind !== 'repo') return url;
  if (MARKDOWN_EXT.test(r.path)) return formatFragment({ ...loc, path: r.path });
  const isDir = state.tree?.entries.some((e) => e.type === 'dir' && e.path === r.path) || url.endsWith('/') || r.path === '';
  return githubUrl(loc, r.path, isDir ? 'tree' : 'blob') + (r.hash ? '#' + r.hash : '');
}

let renderSeq = 0;
async function renderPreview(now = false) {
  clearTimeout(renderTimer);
  const text = src().value;
  const out = $('preview');
  const seq = ++renderSeq;
  if (state.renderer === 'github') {
    if (!now && text === out.dataset.rendered) return;
    $('renderNote').textContent = 'rendering on GitHub…';
    try {
      const ctx = state.loc ? `${state.loc.owner}/${state.loc.name}` : undefined;
      const html = await state.gh.renderMarkdown(text, ctx);
      if (seq !== renderSeq) return;
      out.innerHTML = sanitizeHtml(html);
      fixRelative(out);
      out.dataset.rendered = text;
      const rate = state.gh.rate;
      $('renderNote').textContent = rate ? `${rate.remaining} renders left this hour` : '';
    } catch (e) {
      if (seq !== renderSeq) return;
      $('renderNote').textContent = '';
      status(`GitHub could not render it: ${e.message}. Showing meditor's rendering.`, 'warn');
      state.renderer = 'local';
      $('renderer').value = 'local';
      renderPreview(true);
    }
    return;
  }
  $('renderNote').textContent = '';
  out.innerHTML = renderMarkdown(text, { resolveImage, resolveLink });
  out.dataset.rendered = text;
  for (const box of out.querySelectorAll('input.task-list-item-checkbox[data-line]')) box.disabled = false;
  for (const img of out.querySelectorAll('img')) img.addEventListener('error', () => img.classList.add('missing'), { once: true });
  fixRelative(out);
  previewBlocks = null;
}

/** Raw HTML in the document, and GitHub's renderer, leave relative links and images as written. */
function fixRelative(root) {
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^https?:/i.test(href)) {
      // never navigate the editor away (or hand the new page a handle on it)
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
    }
    if (/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href)) continue;
    a.setAttribute('href', resolveLink(href));
  }
  for (const img of root.querySelectorAll('img[src]')) {
    const s = img.getAttribute('src');
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(s)) continue;
    const r = resolveImage(s);
    img.setAttribute('src', r.src);
    if (r.path) img.dataset.path = r.path;
  }
  loadPrivateImages(root);
}

function loadPrivateImages(root) {
  const loc = state.loc;
  if (!loc) return;
  for (const img of root.querySelectorAll('img[data-path]')) {
    const key = `${loc.owner}/${loc.name}@${loc.ref}:${img.dataset.path}`;
    if (state.images.has(key)) {
      img.src = state.images.get(key);
      continue;
    }
    state.images.set(key, PIXEL); // one request per image, however often we re-render
    state.gh.getRaw(loc.owner, loc.name, img.dataset.path, loc.ref).then((blob) => {
      const url = URL.createObjectURL(blob);
      state.images.set(key, url);
      for (const i of $('preview').querySelectorAll('img[data-path]')) {
        if (i.dataset.path === img.dataset.path) i.src = url;
      }
    }).catch(() => {
      img.classList.add('missing');
      state.images.delete(key);
    });
  }
}

function onPreviewClick(e) {
  const box = e.target.closest('input.task-list-item-checkbox[data-line]');
  if (box) {
    e.preventDefault();
    const line = +box.dataset.line;
    const keep = $('previewScroll').scrollTop;
    const ta = src();
    const { selectionStart, selectionEnd } = ta;
    applyEdit({ text: toggleTask(ta.value, line), start: selectionStart, end: selectionEnd });
    renderPreview(true);
    $('previewScroll').scrollTop = keep;
    return;
  }
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (href.startsWith('#') && !href.startsWith('#repo=')) {
    e.preventDefault();
    // ids in the document all carry the prefix (see ID_PREFIX); links to them may or may not
    let id;
    try { id = decodeURIComponent(href.slice(1)); } catch { id = href.slice(1); }
    const bare = id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : id;
    const t = $('preview').querySelector(`[id="${CSS.escape(ID_PREFIX + bare)}"]`);
    if (t) t.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

// ---------------------------------------------------------------- scroll sync
//
// Each top-level block of the preview says which source line it starts at. A hidden copy
// of the textarea, one div per line, tells where each line is drawn once wrapped. The
// two scroll positions are matched by interpolating between neighbouring blocks.

let lineTops = null;
let previewBlocks = null;
let mirror = null;

function measureLines() {
  if (lineTops) return lineTops;
  const ta = src();
  if (!mirror) {
    mirror = document.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', left: '-9999px', top: '0' });
    document.body.append(mirror);
  }
  const cs = getComputedStyle(ta);
  for (const p of ['font', 'letterSpacing', 'paddingLeft', 'paddingRight', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak', 'lineHeight']) {
    mirror.style[p] = cs[p];
  }
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.style.boxSizing = 'border-box';
  const lines = ta.value.split('\n');
  const frag = document.createDocumentFragment();
  for (const l of lines) {
    const d = document.createElement('div');
    d.textContent = l || '​';
    frag.append(d);
  }
  mirror.replaceChildren(frag);
  const pad = parseFloat(cs.paddingTop) || 0;
  lineTops = Array.from(mirror.children, (d) => d.offsetTop + pad);
  lineTops.push(mirror.scrollHeight + pad);
  mirror.replaceChildren();
  return lineTops;
}

function blocks() {
  if (previewBlocks) return previewBlocks;
  const root = $('preview');
  const scroller = $('previewScroll');
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  previewBlocks = [...root.querySelectorAll(':scope > [data-line], :scope > ul > li[data-line], :scope > ol > li[data-line]')]
    .map((el) => ({ line: +el.dataset.line, top: el.getBoundingClientRect().top - base }))
    .sort((a, b) => a.line - b.line || a.top - b.top);
  return previewBlocks;
}

let syncLock = 0;
let syncSource = null;

function syncFrom(which) {
  if (!state.sync || state.view !== 'split') return;
  if (syncSource && syncSource !== which && performance.now() < syncLock) return;
  syncSource = which;
  syncLock = performance.now() + 80;
  const ta = src();
  const pv = $('previewScroll');
  const bl = state.renderer === 'local' ? blocks() : [];
  if (bl.length < 2) {
    // no landmarks: proportional
    const [from, to] = which === 'editor' ? [ta, pv] : [pv, ta];
    const f = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
    to.scrollTop = f * (to.scrollHeight - to.clientHeight);
    return;
  }
  const tops = measureLines();
  const pts = [{ e: 0, p: 0 }, ...bl.map((b) => ({ e: tops[b.line] ?? 0, p: b.top })),
    { e: Math.max(ta.scrollHeight, tops[tops.length - 1]), p: pv.scrollHeight }];
  const [key, other, from, to] = which === 'editor' ? ['e', 'p', ta, pv] : ['p', 'e', pv, ta];
  const y = from.scrollTop;
  let k = 0;
  while (k < pts.length - 2 && pts[k + 1][key] <= y) k++;
  const a = pts[k];
  const b = pts[k + 1];
  const f = b[key] > a[key] ? (y - a[key]) / (b[key] - a[key]) : 0;
  to.scrollTop = a[other] + Math.min(1, Math.max(0, f)) * (b[other] - a[other]);
}

// ---------------------------------------------------------------- the file tree

function renderTree() {
  renderRecent();
  const repo = state.repo;
  $('filesEmpty').hidden = !!repo;
  $('fileTools').hidden = !repo;
  $('branchBox').hidden = !repo;
  const name = $('repoName');
  name.textContent = repo ? repo.full : '';
  if (repo) name.href = `https://github.com/${repo.full}`;
  $('repoBadge').hidden = !repo || (!repo.private && repo.canPush);
  if (repo) $('repoBadge').textContent = repo.private ? 'private' : 'read-only';
  $('repoBadge').title = repo && !repo.canPush ? 'you cannot push to this repository' : '';
  const tree = $('tree');
  tree.replaceChildren();
  if (!repo || !state.tree) return;

  const filter = $('filter').value.trim().toLowerCase();
  const files = state.tree.entries.filter((e) => e.type === 'file' && MARKDOWN_EXT.test(e.path)).map((e) => e.path);
  const cur = state.loc?.path;
  if (cur && state.doc.isNew && !files.includes(cur)) files.push(cur);
  const drafts = new Set();
  try {
    const prefix = `${K.draft}${repo.owner}/${repo.name}@${state.tree.ref}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(prefix)) drafts.add(k.slice(prefix.length));
    }
  } catch { /* no storage */ }
  for (const d of drafts) if (!files.includes(d)) files.push(d);
  const cantChange = !state.user ? 'sign in to rename or delete files' : !repo.canPush ? 'you cannot push to this repository' : '';

  const fileNode = (path, label) => {
    const li = document.createElement('li');
    li.className = 'file';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'node' + (path === cur ? ' current' : '');
    b.dataset.path = path;
    b.title = path;
    b.innerHTML = `<span class="ic">▤</span><span class="nm">${escapeHtml(label)}</span>${drafts.has(path) ? '<span class="draft" title="unsaved changes in this browser">●</span>' : ''}`;
    const acts = document.createElement('span');
    acts.className = 'acts';
    for (const [act, text, title, cls] of [['move', '✎', 'rename or move…', ''], ['delete', '✕', 'delete…', 'del']]) {
      const a = document.createElement('button');
      a.type = 'button';
      a.className = cls;
      a.dataset.act = act;
      a.dataset.path = path;
      a.textContent = text;
      a.disabled = !!cantChange;
      a.title = cantChange || `${title.replace('…', '')} ${path}…`;
      a.setAttribute('aria-label', a.title);
      acts.append(a);
    }
    li.append(b, acts);
    return li;
  };

  const ul = document.createElement('ul');
  if (filter) {
    const hits = files.filter((p) => p.toLowerCase().includes(filter)).sort();
    for (const p of hits) ul.append(fileNode(p, p));
    if (!hits.length) ul.innerHTML = '<li class="note">no Markdown file matches</li>';
  } else {
    // a directory tree holding only the Markdown files
    const root = { dirs: new Map(), files: [] };
    for (const p of files) {
      const parts = p.split('/');
      let n = root;
      for (const d of parts.slice(0, -1)) {
        if (!n.dirs.has(d)) n.dirs.set(d, { dirs: new Map(), files: [] });
        n = n.dirs.get(d);
      }
      n.files.push(p);
    }
    if (cur) {
      // open the directories leading to the current file
      const parts = cur.split('/');
      for (let i = 1; i < parts.length; i++) state.open.add(parts.slice(0, i).join('/'));
    }
    const build = (n, prefix, into) => {
      for (const [d, sub] of [...n.dirs].sort(([a], [b]) => a.localeCompare(b))) {
        const path = prefix ? `${prefix}/${d}` : d;
        const li = document.createElement('li');
        li.className = 'dir';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'node';
        b.dataset.dir = path;
        const isOpen = state.open.has(path);
        b.setAttribute('aria-expanded', String(isOpen));
        b.innerHTML = `<span class="ic">${isOpen ? '▾' : '▸'}</span><span class="nm">${escapeHtml(d)}/</span>`;
        li.append(b);
        if (isOpen) {
          const inner = document.createElement('ul');
          build(sub, path, inner);
          li.append(inner);
        }
        into.append(li);
      }
      for (const p of n.files.sort((a, b) => basename(a).localeCompare(basename(b)))) into.append(fileNode(p, basename(p)));
    };
    build(root, '', ul);
    if (!files.length) ul.innerHTML = '<li class="note">no Markdown files on this branch</li>';
  }
  tree.append(ul);
  if (state.tree.truncated) {
    const n = document.createElement('p');
    n.className = 'note';
    n.textContent = 'The repository is too large for GitHub to list in full; some files may be missing. Open them by URL.';
    tree.append(n);
  }
  tree.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
}

function onTreeClick(e) {
  const act = e.target.closest('button[data-act]');
  if (act) {
    openFileDialog(act.dataset.act, act.dataset.path);
    return;
  }
  const b = e.target.closest('button.node');
  if (!b) return;
  if (b.dataset.dir) {
    const d = b.dataset.dir;
    if (state.open.has(d)) state.open.delete(d);
    else state.open.add(d);
    renderTree();
    return;
  }
  if (b.dataset.path && state.loc) go({ ...state.loc, path: b.dataset.path });
  else if (b.dataset.path && state.repo) go({ owner: state.repo.owner, name: state.repo.name, ref: state.tree.ref, path: b.dataset.path });
}

function renderBranches() {
  const sel = $('branch');
  const ref = state.loc?.ref || state.tree?.ref || state.repo?.defaultBranch;
  const names = state.branches.map((b) => b.name);
  if (ref && !names.includes(ref)) names.unshift(ref);
  sel.replaceChildren(...names.map((n) => {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n + (n === state.repo?.defaultBranch ? '  (default)' : '');
    return o;
  }));
  sel.value = ref || '';
}

// ---------------------------------------------------------------- recent files
//
// The files opened lately, newest first, kept in this browser (local storage, like the
// drafts: nothing about them is sent anywhere).

function rememberRecent(loc) {
  store.set(K.recent, addRecent(store.get(K.recent, []), loc, Date.now()));
  renderRecent();
}

function renderRecent() {
  const list = store.get(K.recent, []);
  const now = Date.now();
  const cur = state.loc;
  const same = (r) => cur && r.owner === cur.owner && r.name === cur.name && r.ref === cur.ref && r.path === cur.path;
  for (const ul of document.querySelectorAll('[data-recent]')) {
    ul.replaceChildren(...list.map((r) => {
      const li = document.createElement('li');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'open' + (same(r) ? ' current' : '');
      open.dataset.loc = JSON.stringify(r);
      open.title = `${r.owner}/${r.name} @ ${r.ref} : ${r.path}`;
      const dir = dirname(r.path);
      open.innerHTML = `<span class="nm">${escapeHtml(basename(r.path))}</span>`
        + `<span class="where">${escapeHtml(`${r.owner}/${r.name}${dir ? '/' + dir : ''} @ ${r.ref}`)} · ${escapeHtml(ago(r.at, now))}</span>`;
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'forget';
      forget.dataset.forget = JSON.stringify(r);
      forget.title = 'remove from the recent files';
      forget.setAttribute('aria-label', 'remove from the recent files');
      forget.textContent = '×';
      li.append(open, forget);
      return li;
    }));
  }
  for (const w of document.querySelectorAll('.recentwrap')) w.hidden = !list.length;
  $('recentBox').hidden = !list.length || !state.repo;
}

function onRecentClick(e) {
  const f = e.target.closest('button[data-forget]');
  if (f) {
    store.set(K.recent, removeRecent(store.get(K.recent, []), JSON.parse(f.dataset.forget)));
    renderRecent();
    return;
  }
  const b = e.target.closest('button[data-loc]');
  if (!b) return;
  const dlg = b.closest('dialog');
  if (dlg) dlg.close();
  go(JSON.parse(b.dataset.loc));
}

// ---------------------------------------------------------------- repositories

// The list of the user's repositories takes GitHub several requests to produce, so the last
// one is kept in this browser and shown at once, then refreshed in the background once per
// visit (or on ↻). It is dropped on signing in or out, and when the app's repositories change.

let reposFresh = false;
let reposLoading = null;

function forgetRepos() {
  state.repos = null;
  reposFresh = false;
  store.del(K.repos);
}

function cachedRepos() {
  const c = store.get(K.repos);
  if (!c || !state.user || c.login !== state.user.login || c.kind !== auth.kind || !Array.isArray(c.repos)) return null;
  return c;
}

/** Fetch the list from GitHub (one fetch at a time) and keep it. */
function loadRepos() {
  if (reposLoading) return reposLoading;
  const login = state.user.login;
  reposLoading = state.gh.repos().then((repos) => {
    if (state.user?.login !== login) return;
    state.repos = repos;
    reposFresh = true;
    store.set(K.repos, { login, kind: auth.kind, at: Date.now(), repos });
  }).finally(() => { reposLoading = null; });
  return reposLoading;
}

function showReposAge() {
  const c = cachedRepos();
  $('reposAge').textContent = c ? `updated ${ago(c.at, Date.now())}` : '';
}

async function refreshRepos(quiet) {
  const btn = $('reposRefresh');
  btn.disabled = true;
  if (!quiet || !state.repos) $('repoNote').textContent = 'loading your repositories…';
  try {
    await loadRepos();
    if ($('repoNote').textContent === 'loading your repositories…') $('repoNote').textContent = '';
  } catch (e) {
    // with a list on screen already, a failed background refresh is not worth an alarm
    if (!quiet || !state.repos) $('repoNote').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
  if ($('repoDlg').open) {
    renderRepoList();
    showReposAge();
  }
}

async function openRepoDialog() {
  const dlg = $('repoDlg');
  $('repoUrl').value = '';
  $('repoFilter').value = '';
  $('repoNote').textContent = state.user ? '' : 'Sign in to list your repositories, including private ones.';
  $('repoListBox').hidden = !state.user;
  $('repoInstall').hidden = auth.kind !== 'app';
  $('repoInstallLink').href = installUrl();
  renderRecent();
  dlg.showModal();
  $('repoUrl').focus();
  if (!state.user) return;
  if (!state.repos) state.repos = cachedRepos()?.repos ?? null;
  renderRepoList();
  showReposAge();
  if (!reposFresh) refreshRepos(true);
}

// owner/name in alphabetical order, ignoring case
const byName = (a, b) => a.full.localeCompare(b.full, 'en', { sensitivity: 'base' });

function renderRepoList() {
  const list = $('repoList');
  if (!state.repos) { list.replaceChildren(); return; }
  const f = $('repoFilter').value.trim().toLowerCase();
  const hits = state.repos
    .filter((r) => !f || r.full.toLowerCase().includes(f) || r.description.toLowerCase().includes(f))
    .sort(byName)
    .slice(0, 200);
  list.replaceChildren(...hits.map((r) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.repo = r.full;
    b.innerHTML = `<span class="full">${escapeHtml(r.full)}</span>${r.private ? '<span class="badge">private</span>' : ''}${r.canPush ? '' : '<span class="badge">read-only</span>'}<span class="desc">${escapeHtml(r.description)}</span>`;
    li.append(b);
    return li;
  }));
  if (!hits.length) $('repoNote').textContent = 'No repository matches.';
  else if ($('repoNote').textContent === 'No repository matches.') $('repoNote').textContent = '';
}

async function openByUrl(input) {
  const p = parseGitHubUrl(input);
  if (!p) {
    $('repoNote').textContent = 'That is not a GitHub repository URL or owner/name.';
    return false;
  }
  if (!p.rest) {
    go({ owner: p.owner, name: p.name });
    return true;
  }
  let branches = [];
  try {
    $('repoNote').textContent = 'looking up the branch…';
    branches = (await state.gh.branches(p.owner, p.name)).map((b) => b.name);
  } catch (e) {
    $('repoNote').textContent = e.message;
    return false;
  }
  const { ref, path } = splitRefPath(p.rest, branches);
  go({ owner: p.owner, name: p.name, ref, path: MARKDOWN_EXT.test(path) ? path : undefined });
  return true;
}

// ---------------------------------------------------------------- committing

function openCommitDialog() {
  const loc = state.loc;
  if (!loc) return;
  if (!state.user) {
    toast('Sign in with a GitHub token to commit.');
    openSignin();
    return;
  }
  if (!isDirty()) {
    toast('Nothing to commit: the file is as it is on GitHub.');
    return;
  }
  const repo = state.repo;
  $('commitPath').textContent = loc.path;
  $('commitBranch').textContent = loc.ref;
  $('commitMsg').value = `${state.doc.isNew ? 'Create' : 'Update'} ${basename(loc.path)}`;
  $('commitBody').value = '';
  $('commitError').hidden = true;
  $('diff').hidden = true;
  const login = state.user.login.toLowerCase().replace(/[^a-z0-9-]/g, '');
  $('prBranch').value = `${login}/${basename(loc.path).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36).slice(-4)}`;
  const direct = document.querySelector('input[name="target"][value="direct"]');
  direct.checked = true;
  const cantPush = !repo.canPush;
  $('commitGo').disabled = cantPush;
  $('commitNote').textContent = cantPush
    ? 'Your token cannot push to this repository. Download the file, or fork the repository on GitHub and open the fork here.'
    : '';
  $('commitDlg').showModal();
  $('commitMsg').select();
}

function showDiff() {
  const pre = $('diff');
  if (!pre.hidden) { pre.hidden = true; return; }
  const d = lineDiff(state.doc.base, src().value);
  pre.innerHTML = d.map(({ op, line }) => {
    if (op === '…') return '<span class="gap">⋯</span>';
    const cls = op === '+' ? 'add' : op === '-' ? 'del' : '';
    return cls ? `<span class="${cls}">${op} ${escapeHtml(line)}</span>` : `  ${escapeHtml(line)}\n`;
  }).join('');
  pre.hidden = false;
}

async function doCommit() {
  const loc = state.loc;
  const text = src().value;
  const title = $('commitMsg').value.trim();
  const body = $('commitBody').value.trim();
  const message = body ? `${title}\n\n${body}` : title;
  const pr = document.querySelector('input[name="target"]:checked').value === 'pr';
  const err = $('commitError');
  err.hidden = true;
  $('commitGo').disabled = true;
  try {
    let branch = loc.ref;
    if (pr) {
      branch = $('prBranch').value.trim();
      if (!branch) throw new Error('Name the new branch.');
      await busy(`creating branch ${branch}`, () => state.gh.createBranch(loc.owner, loc.name, branch, loc.ref));
    }
    const r = await busy('committing', () => state.gh.putFile(loc.owner, loc.name, loc.path, { text, message, branch, sha: state.doc.sha }));
    store.del(draftKey(loc));
    const wasNew = state.doc.isNew;
    state.doc = { base: text, sha: r.sha, isNew: false };
    $('commitDlg').close();
    hideBanner();
    let note = `Committed <a href="${escapeHtml(r.commit.html_url)}" target="_blank" rel="noopener">${r.commit.sha.slice(0, 7)}</a> to ${escapeHtml(branch)}.`;
    if (pr) {
      try {
        const p = await busy('opening the pull request', () => state.gh.createPull(loc.owner, loc.name, { head: branch, base: loc.ref, title, body }));
        note += ` Opened <a href="${escapeHtml(p.html_url)}" target="_blank" rel="noopener">pull request #${p.number}</a>.`;
      } catch {
        const cmp = `https://github.com/${loc.owner}/${loc.name}/compare/${encodeURIComponent(loc.ref)}...${encodeURIComponent(branch)}?expand=1`;
        note += ` <a href="${escapeHtml(cmp)}" target="_blank" rel="noopener">Open the pull request on GitHub</a>.`;
      }
      // further commits go to the pull request's branch
      state.branches.push({ name: branch, sha: r.commit.sha });
      const next = { ...loc, ref: branch };
      state.loc = next;
      rememberRecent(next);
      history.pushState(null, '', formatFragment(next));
      state.tree = { ...(await state.gh.tree(loc.owner, loc.name, branch)), ref: branch };
      renderBranches();
    } else if (wasNew && state.tree) {
      state.tree.entries.push({ path: loc.path, type: 'file', sha: r.sha });
    }
    status('');
    toast(note, 9000);
    showDoc();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    if (e.status === 409) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'load the latest version';
      btn.addEventListener('click', reloadKeepingText);
      err.append(' ', btn);
    }
  } finally {
    $('commitGo').disabled = !state.repo?.canPush;
  }
}

/** The file changed on GitHub: take its new version as the base, keep the text being edited. */
async function reloadKeepingText() {
  const loc = state.loc;
  const f = await busy('loading the latest version', () => state.gh.getFile(loc.owner, loc.name, loc.path, loc.ref));
  if (!f) return;
  state.doc = { base: f.text, sha: f.sha, isNew: false };
  saveDraftNow();
  updateDirty();
  $('commitError').hidden = true;
  $('diff').hidden = true;
  showDiff();
  $('commitNote').textContent = 'The diff now compares your text with the latest version on GitHub; committing replaces it with yours.';
}

// ---------------------------------------------------------------- rename, move, delete
//
// Each is one commit straight to the branch of the file list. A rename is made with the Git
// Data API (commitChanges), so that the history shows one commit, not a delete and a create.
// What this browser keeps about the file (its draft, its place in the recent files) follows
// it. A file that is not on GitHub yet (a new file, or only a draft) is renamed or dropped
// here only, without a commit.

let fileAction = null; // { act: 'move'|'delete', path, entry }

function openFileDialog(act, path) {
  const repo = state.repo;
  if (!repo || !state.tree) return;
  if (!state.user || !repo.canPush) return;
  const entry = state.tree.entries.find((e) => e.type === 'file' && e.path === path) || null;
  fileAction = { act, path, entry };
  const move = act === 'move';
  $('fileVerb').textContent = move ? 'Rename or move' : 'Delete';
  $('fileFrom').textContent = path;
  $('fileToBox').hidden = !move;
  $('fileTo').required = move;
  $('fileTo').value = path;
  $('fileMsgBox').hidden = !entry;
  $('fileMsg').required = !!entry;
  $('fileMsg').value = move ? '' : `Delete ${basename(path)}`;
  $('fileMsg').dataset.edited = '';
  $('fileError').hidden = true;
  const go = $('fileGo');
  go.textContent = move ? 'rename' : 'delete';
  go.classList.toggle('danger', !move);
  go.disabled = false;
  const draft = store.get(draftKey({ owner: repo.owner, name: repo.name, ref: state.tree.ref, path }));
  const open = state.loc?.path === path;
  const unsaved = draft || (open && isDirty());
  $('fileNote').textContent = !entry
    ? (move ? 'It is not on GitHub yet: only the draft in this browser is renamed.' : 'It is not on GitHub yet: this discards the draft kept in this browser.')
    : move ? `This commits straight to ${state.tree.ref}.${unsaved ? ' Your unsaved changes to it move with it.' : ''}`
      : `This commits straight to ${state.tree.ref}.${unsaved ? ' Your unsaved changes to it are discarded.' : ''} The file stays in the branch's history.`;
  $('fileDlg').showModal();
  if (move) {
    const i = $('fileTo');
    const dir = dirname(path);
    i.focus();
    i.setSelectionRange(dir ? dir.length + 1 : 0, path.replace(/\.[^./]+$/, '').length);
    suggestMoveMessage();
  } else {
    $('fileMsg').select();
  }
}

/** The default message, kept in step with the new path until the user edits it. */
function suggestMoveMessage() {
  const msg = $('fileMsg');
  if (msg.dataset.edited === '1' && msg.value) return;
  const from = fileAction.path;
  const to = joinPath('', $('fileTo').value.trim()) || '';
  msg.value = !to || to === from ? '' : dirname(to) === dirname(from) ? `Rename ${basename(from)} to ${basename(to)}` : `Move ${from} to ${to}`;
  msg.dataset.edited = '';
}

/** Why `to` cannot be the new path of `from`, or '' if it can. */
function badMovePath(from, to) {
  if (!to) return 'Give the new path.';
  if (to === from) return 'That is where it is already.';
  if (/\/$/.test(to)) return 'Give a file name, not a directory.';
  const entries = state.tree.entries;
  const hit = entries.find((e) => e.path === to);
  if (hit) return hit.type === 'dir' ? `${to} is a directory.` : `There is already a file ${to}.`;
  const parts = to.split('/');
  for (let i = 1; i < parts.length; i++) {
    const p = parts.slice(0, i).join('/');
    if (entries.some((e) => e.type === 'file' && e.path === p)) return `${p} is a file, so it cannot hold others.`;
  }
  const repo = state.repo;
  if (store.get(draftKey({ owner: repo.owner, name: repo.name, ref: state.tree.ref, path: to }))) return `You have a draft of ${to} in this browser; open it and commit or discard it first.`;
  return '';
}

async function doFileAction() {
  const { act, path, entry } = fileAction;
  const repo = state.repo;
  const ref = state.tree.ref;
  const loc = { owner: repo.owner, name: repo.name, ref, path };
  const isOpen = state.loc && draftKey(state.loc) === draftKey(loc);
  if (isOpen) saveDraftNow();
  const err = $('fileError');
  err.hidden = true;
  const to = act === 'move' ? joinPath('', $('fileTo').value.trim().replace(/^\/+/, '')) : null;
  if (act === 'move') {
    const why = badMovePath(path, to);
    if (why) {
      err.textContent = why;
      err.hidden = false;
      return;
    }
  }
  const message = $('fileMsg').value.trim();
  $('fileGo').disabled = true;
  let r = null;
  try {
    if (entry) {
      const changes = act === 'move'
        ? [{ path, delete: true, expect: entry.sha }, { path: to, sha: entry.sha, mode: entry.mode, expect: null }]
        : [{ path, delete: true, expect: entry.sha }];
      r = await busy(act === 'move' ? `moving ${path}` : `deleting ${path}`,
        () => state.gh.commitChanges(repo.owner, repo.name, ref, { message, changes }));
    }
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    $('fileGo').disabled = false;
    return;
  }
  $('fileDlg').close();

  // what this browser keeps about the file follows it
  const draft = store.get(draftKey(loc));
  store.del(draftKey(loc));
  if (act === 'move') {
    if (draft) store.set(draftKey({ ...loc, path: to }), draft);
    store.set(K.recent, renameRecent(store.get(K.recent, []), loc, to));
    if (entry) {
      entry.path = to;
      // the directories it may have moved into, for the checks of the next move
      const parts = to.split('/');
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        if (!state.tree.entries.some((e) => e.path === d)) state.tree.entries.push({ path: d, type: 'dir' });
      }
    }
  } else {
    store.set(K.recent, removeRecent(store.get(K.recent, []), loc));
    if (entry) state.tree.entries = state.tree.entries.filter((e) => e !== entry);
  }

  const commit = r ? ` in <a href="${escapeHtml(r.html_url)}" target="_blank" rel="noopener">${r.sha.slice(0, 7)}</a>` : '';
  toast(act === 'move'
    ? `Moved ${escapeHtml(path)} to ${escapeHtml(to)}${commit}.`
    : `Deleted ${escapeHtml(path)}${commit}.`, 9000);
  status('');

  if (isOpen && act === 'move') {
    // the same text, under its new name: no need to read it again
    state.loc = { ...loc, path: to };
    rememberRecent(state.loc);
    history.replaceState(null, '', formatFragment(state.loc));
    if (draft || isDirty()) saveDraftNow();
    showDoc();
    if (state.doc.isNew) status(`${to} is new: it will be created when you commit it.`, 'warn');
  } else if (isOpen) {
    // nothing to show any more: leave it without keeping a draft of it, and open another file
    clearTimeout(draftTimer);
    state.loc = null;
    openScratch();
    go({ owner: repo.owner, name: repo.name, ref }, true);
  } else {
    renderTree();
  }
}

// ---------------------------------------------------------------- new file, download

function openNewDialog() {
  if (!state.repo) return;
  const dir = state.loc ? dirname(state.loc.path) : '';
  $('newPath').value = dir ? `${dir}/untitled.md` : 'untitled.md';
  $('newError').hidden = true;
  $('newDlg').showModal();
  const i = $('newPath');
  i.setSelectionRange(dir ? dir.length + 1 : 0, i.value.length - 3);
}

function createNew() {
  let p = joinPath('', $('newPath').value.trim());
  if (!p) return false;
  if (!/\.[a-z0-9]+$/i.test(p)) p += '.md';
  const ref = state.tree?.ref || state.repo.defaultBranch;
  go({ owner: state.repo.owner, name: state.repo.name, ref, path: p });
  return true;
}

function download() {
  const name = state.loc ? basename(state.loc.path) : 'scratchpad.md';
  const blob = new Blob([src().value], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function openLocalFile(file) {
  const text = await file.text();
  if (state.loc) go(null);
  await routing;
  setText(text, true);
  saveDraftNow();
  status(`${file.name} is in the scratchpad now. Download it when done, or open a repository to commit it there.`);
}

// ---------------------------------------------------------------- view, panels, theme

function setView(v) {
  state.view = v;
  $('workspace').dataset.view = v;
  for (const b of document.querySelectorAll('[data-view]')) {
    if (b.tagName === 'BUTTON') b.setAttribute('aria-checked', String(b.dataset.view === v));
  }
  savePrefs();
  lineTops = null;
  previewBlocks = null;
  placeSplits();
}

function setFilesVisible(on) {
  $('workspace').classList.toggle('nofiles', !on);
  $('toggleFiles').setAttribute('aria-pressed', String(on));
  savePrefs();
  lineTops = null;
  previewBlocks = null;
  placeSplits();
}

function savePrefs() {
  store.set(K.prefs, {
    view: state.view,
    files: !$('workspace').classList.contains('nofiles'),
    renderer: state.renderer,
    sync: state.sync,
  });
}

function placeSplits() {
  const ws = $('workspace');
  const panes = ws.querySelectorAll('.files, .editorpane, .previewpane');
  const wsLeft = ws.getBoundingClientRect().left;
  const right = (el) => el.getBoundingClientRect().right - wsLeft;
  const [files, editor] = panes;
  ws.querySelector('[data-split="files"]').style.left = `${right(files)}px`;
  ws.querySelector('[data-split="editor"]').style.left = `${right(editor)}px`;
}

function initSplits() {
  const ws = $('workspace');
  const saved = store.get(K.panels, {});
  const apply = (s) => {
    if (s.files) ws.style.setProperty('--files-w', `${s.files}px`);
    else ws.style.removeProperty('--files-w');
    if (s.editor) {
      ws.style.setProperty('--editor-fr', `${s.editor}fr`);
      ws.style.setProperty('--preview-fr', `${1 - s.editor}fr`);
    } else {
      ws.style.removeProperty('--editor-fr');
      ws.style.removeProperty('--preview-fr');
    }
    requestAnimationFrame(placeSplits);
  };
  apply(saved);
  for (const h of ws.querySelectorAll('.split')) {
    const which = h.dataset.split;
    h.addEventListener('dblclick', () => {
      delete saved[which];
      store.set(K.panels, saved);
      apply(saved);
      lineTops = null;
      previewBlocks = null;
    });
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      h.classList.add('active');
      document.body.classList.add('resizing');
      const r = ws.getBoundingClientRect();
      const move = (ev) => {
        if (which === 'files') {
          saved.files = Math.round(Math.min(Math.max(ev.clientX - r.left, 150), r.width * 0.45));
        } else {
          const ed = ws.querySelector('.editorpane').getBoundingClientRect();
          const pv = ws.querySelector('.previewpane').getBoundingClientRect();
          const total = pv.right - ed.left - 8;
          saved.editor = Math.min(Math.max((ev.clientX - ed.left - 4) / total, 0.15), 0.85);
        }
        apply(saved);
      };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        h.classList.remove('active');
        document.body.classList.remove('resizing');
        store.set(K.panels, saved);
        lineTops = null;
        previewBlocks = null;
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
  }
  new ResizeObserver(() => {
    placeSplits();
    lineTops = null;
    previewBlocks = null;
  }).observe(ws);
}

function initTheme() {
  $('theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = cur === 'dark' ? 'light' : 'dark';
  });
}

// ---------------------------------------------------------------- installing as an app
//
// The browser offers to install the page (manifest.webmanifest) when it qualifies; Chrome
// and Edge let the page offer it too, with a button, through beforeinstallprompt. Other
// browsers install from their own menu (Safari: Share → Add to Dock / Home Screen).

let installPrompt = null;

function initInstall() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline start just will not work */ });
  }
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('install').hidden = false;
  });
  addEventListener('appinstalled', () => {
    installPrompt = null;
    $('install').hidden = true;
    toast('meditor is installed: start it from your applications like any other.');
  });
  $('install').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    $('install').hidden = true;
  });
}

// ---------------------------------------------------------------- boot

export async function boot() {
  initTheme();
  initInstall();
  initSplits();

  const prefs = store.get(K.prefs, {});
  state.renderer = prefs.renderer === 'github' ? 'github' : 'local';
  state.sync = prefs.sync !== false;
  $('renderer').value = state.renderer;
  $('syncScroll').checked = state.sync;
  setView(['edit', 'split', 'preview'].includes(prefs.view) ? prefs.view : 'split');
  setFilesVisible(prefs.files !== false && innerWidth > 900);

  // toolbar
  for (const b of document.querySelectorAll('[data-cmd]')) {
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
    b.addEventListener('click', () => command(b.dataset.cmd));
  }
  for (const b of document.querySelectorAll('button[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));
  $('toggleFiles').addEventListener('click', () => setFilesVisible($('workspace').classList.contains('nofiles')));
  $('openRepo').addEventListener('click', openRepoDialog);
  $('openRepo2').addEventListener('click', openRepoDialog);
  $('download').addEventListener('click', download);
  $('commit').addEventListener('click', openCommitDialog);
  $('localFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) openLocalFile(f);
    e.target.value = '';
  });

  // editor
  const ta = src();
  ta.addEventListener('input', onTextChanged);
  ta.addEventListener('keydown', onKeyDown);
  for (const ev of ['keyup', 'click', 'select']) ta.addEventListener(ev, updateStats);
  ta.addEventListener('scroll', () => syncFrom('editor'), { passive: true });
  $('previewScroll').addEventListener('scroll', () => syncFrom('preview'), { passive: true });
  $('preview').addEventListener('click', onPreviewClick);
  $('renderer').addEventListener('change', (e) => {
    state.renderer = e.target.value;
    savePrefs();
    renderPreview(true);
  });
  $('syncScroll').addEventListener('change', (e) => {
    state.sync = e.target.checked;
    savePrefs();
  });

  // files
  $('tree').addEventListener('click', onTreeClick);
  $('filter').addEventListener('input', renderTree);
  $('newFile').addEventListener('click', openNewDialog);
  $('refresh').addEventListener('click', async () => {
    if (!state.repo) return;
    const ref = state.tree?.ref;
    state.tree = { ...(await busy('reading the file list', () => state.gh.tree(state.repo.owner, state.repo.name, ref))), ref };
    renderTree();
  });
  $('branch').addEventListener('change', (e) => {
    const ref = e.target.value;
    const path = state.loc?.path;
    go({ owner: state.repo.owner, name: state.repo.name, ref, path });
  });

  // account
  $('account').addEventListener('click', openSignin);
  $('signin2').addEventListener('click', (e) => { e.preventDefault(); openSignin(); });
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
  $('signinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = $('tokenInput').value.trim();
    if (!token) return;
    $('signinGo').disabled = true;
    try {
      await signInWithToken(token, $('rememberToken').checked);
      $('signinDlg').close();
      toast(`Signed in as <b>${escapeHtml(state.user.login)}</b>.`);
      if (state.repo) {
        // the repository may look different now (private, writable)
        const loc = state.loc;
        state.repo = null;
        state.tree = null;
        state.loc = null;
        go(loc || null, true);
      }
    } catch (err) {
      $('signinError').textContent = err.status === 401 ? 'GitHub did not accept this token.' : err.message;
      $('signinError').hidden = false;
    } finally {
      $('signinGo').disabled = false;
    }
  });
  $('ghSignin').addEventListener('click', () => {
    signInWithGitHub().catch((err) => {
      $('signinError').textContent = err.message;
      $('signinError').hidden = false;
    });
  });
  $('signout').addEventListener('click', () => {
    $('signinDlg').close();
    signOut();
  });

  // repositories
  $('repoFilter').addEventListener('input', renderRepoList);
  $('reposRefresh').addEventListener('click', () => refreshRepos(false));
  for (const ul of document.querySelectorAll('[data-recent]')) ul.addEventListener('click', onRecentClick);
  $('repoList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-repo]');
    if (!b) return;
    const [owner, name] = b.dataset.repo.split('/');
    $('repoDlg').close();
    go({ owner, name });
  });
  $('repoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (document.activeElement === $('repoFilter')) {
      $('repoList').querySelector('button')?.click();
      return;
    }
    if (await openByUrl($('repoUrl').value)) $('repoDlg').close();
  });

  // commit
  $('commitForm').addEventListener('submit', (e) => {
    e.preventDefault();
    doCommit();
  });
  $('showDiff').addEventListener('click', showDiff);
  $('prBranch').addEventListener('focus', () => { document.querySelector('input[name="target"][value="pr"]').checked = true; });

  // rename, move, delete
  $('fileForm').addEventListener('submit', (e) => {
    e.preventDefault();
    doFileAction();
  });
  $('fileTo').addEventListener('input', () => {
    $('fileError').hidden = true;
    suggestMoveMessage();
  });
  $('fileMsg').addEventListener('input', () => { $('fileMsg').dataset.edited = '1'; });

  // new file
  $('newForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (createNew()) $('newDlg').close();
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 's') {
      e.preventDefault();
      if (state.loc) openCommitDialog();
      else download();
    } else if (k === 'o') {
      e.preventDefault();
      openRepoDialog();
    }
  });
  addEventListener('popstate', route);
  addEventListener('hashchange', route);
  addEventListener('pagehide', saveDraftNow);
  addEventListener('beforeunload', saveDraftNow);

  // tokens pasted before sign-in through GitHub existed
  const old = credStore.get(K.oldToken);
  if (old && !auth.creds) {
    try { rememberCreds = !!localStorage.getItem(K.oldToken); } catch { /* ignore */ }
    auth.usePat(old);
  }
  credStore.del(K.oldToken);

  // back from github.com, or signed in from before; then go wherever the address says
  await finishSignIn();
  if (auth.creds && !state.user) {
    try {
      await useCredentials();
    } catch (e) {
      if (e.status === 401 || e instanceof AuthError) {
        auth.save(null);
        toast('Your GitHub sign-in has expired; please sign in again.');
      } else {
        // offline or rate-limited: carry on with what we have
        state.gh = new GitHub(auth);
      }
    }
  }
  showAccount();
  await route();
  updateStats();
}
