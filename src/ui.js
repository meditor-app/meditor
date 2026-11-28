// The page: account, repository and file navigation, the editor, the preview, commits.
// The only module that touches the DOM.

import { renderMarkdown, sanitizeHtml, escapeHtml, isExternalLink, ID_PREFIX } from './markdown.js';
import { GitHub, MARKDOWN_EXT, bytesToBase64, recordCommit, encodeFile, PLAIN_FORMAT } from './github.js';
import { Auth, AUTH_KEY, credentialStore, keepSignIn, signInReturn } from './auth.js';
import { GITHUB_APP } from './config.js';
import {
  parseFragment, formatFragment, parseGitHubUrl, splitRefPath, resolveRef, githubUrl, rawUrl,
  dirname, basename, joinPath, addRecent, removeRecent, renameRecent, ago,
} from './links.js';
import {
  wrap, togglePrefix, orderedList, taskList, heading, link, codeBlock, table, rule, indent,
  continueList, toggleTask, countWords, indentUnit, newlineIndent,
} from './edit.js';
import { lineDiff } from './diff.js';
import {
  findAll, matchFrom, matchBefore, replaceOne, replaceAll, escapeRegExp, MAX_MATCHES,
  anchorAfter, findShortcut, findOptionKey, shortcutText, commandHeld,
} from './find.js';
import { retokenize, rangesByLine, lineHtml, syntaxFor } from './mdsyntax.js';
import { isMarkdown, notTextKind, fileLanguage, newFilePath, MAX_TEXT_BYTES } from './filetypes.js';
import { proposeChange } from './fork.js';
import { proposeImagePath, imageMarkdown, referencedPaths, formatSize } from './images.js';
import { Drafts, newFileText } from './drafts.js';
import { loadLocation, latest, NotTextError } from './nav.js';

const $ = (id) => document.getElementById(id);
const IS_MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || '');
/** What the shortcut functions of find.js look at in a key event. */
const keyInfo = (e) => ({
  key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey,
  altGraph: !!e.getModifierState?.('AltGraph'),
});
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
| \`**bold**\`, \`*italic*\`, \`~~struck~~\` | **bold**, *italic*, ~~struck~~ |
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
  /** False when storage refused it (private mode, or full). */
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; }
  },
  del(k) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  },
};

// The theme chosen with ◐ ('light' or 'dark'; null follows the system), kept in the prefs. It
// is set the moment this module runs, before boot() and, as a rule, before the page is first
// drawn (index.html loads main.js from <head>; the Content Security Policy allows no inline
// script that could do it sooner). app.css makes native controls follow it (color-scheme).
let theme = ((t) => (t === 'light' || t === 'dark' ? t : null))(store.get(K.prefs, {})?.theme);
if (theme) document.documentElement.dataset.theme = theme;

const drafts = new Drafts(store);

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
  view: 'split', // what is shown: edit, split or preview
  wideView: 'split', // the view chosen on wider screens
  phoneView: 'edit', // and on a phone, which shows one panel at a time
  filesPref: true, // the file list shown beside the panels on wider screens
  mdOnly: false, // the file list shows only the Markdown files
  notText: new Map(), // repo path -> why it is not opened (binary, too large), found on opening
  sync: true,
  images: new Map(), // repo image path -> object URL (private repositories)
  pending: new Map(), // pasted images of the open document, not committed yet (see loadPending)
  loading: 0,
};

// The screen sizes at which the layout changes (app.css asks the same questions): narrow
// screens show the file list as a drawer, phones one panel at a time.
const narrow = matchMedia('(max-width: 900px), (max-height: 500px) and (max-width: 960px)');
const phone = matchMedia('(max-width: 640px)');

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
    if (!state.loading && $('status').textContent === label + '…') {
      status('');
      draftWarning(); // what is only in this tab, said again
    }
  }
}

/** The open document is Markdown (the scratchpad is): rendered beside its source, with the toolbar. */
const isMdDoc = () => !state.loc || isMarkdown(state.loc.path);

const draftKey = (loc) => `${K.draft}${loc.owner}/${loc.name}@${loc.ref}:${loc.path}`;

// ---------------------------------------------------------------- account

const credStore = credentialStore(() => localStorage, () => sessionStorage);
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
  credStore.remember = remember;
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
  if (!signInReturn(location.search, null)) return;
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(K.pending) || 'null'); sessionStorage.removeItem(K.pending); } catch { /* none */ }
  const back = signInReturn(location.search, pending);
  // drop the query: the code is single-use and should not stay in the address or history
  history.replaceState(null, '', location.pathname + (pending?.hash || location.hash));
  if (back.kind === 'ignore') return; // an error that answers no sign-in of this tab
  if (back.kind === 'error') {
    toast(`GitHub did not sign you in: ${escapeHtml(back.message)}`, 8000);
    return;
  }
  if (back.kind === 'code') {
    let issued = false;
    try {
      credStore.remember = true;
      await auth.complete(back.code, back.state, pending);
      issued = true;
      forgetRepos();
      await useCredentials();
      const inst = await state.gh.request('GET', '/user/installations?per_page=1').catch(() => null);
      if (inst && inst.total_count === 0) {
        toast(`Signed in as <b>${escapeHtml(state.user.login)}</b>. Now <a href="${escapeHtml(installUrl())}">choose the repositories</a> meditor may edit.`, 15000);
      } else {
        toast(`Signed in as <b>${escapeHtml(state.user.login)}</b>.`);
      }
    } catch (e) {
      // A code GitHub would not take leaves things as they were. After it, an outage keeps the
      // new token (boot tries the user check again); GitHub refusing it revokes it.
      if (issued && !keepSignIn(e)) auth.signOut();
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
  signedOut();
  toast(was?.kind === 'pat'
    ? 'Signed out. The token is forgotten by this browser; revoke it on GitHub if you no longer need it.'
    : 'Signed out.');
}

function signedOut() {
  state.gh = new GitHub(null);
  state.user = null;
  forgetRepos();
  for (const url of state.images.values()) URL.revokeObjectURL(url);
  state.images.clear();
  showAccount();
}

/** Another tab signed out, or signed in as someone else: follow it. */
async function accountChanged() {
  const was = state.user;
  signedOut(); // at once, so nothing is committed under the old name meanwhile
  if (!auth.creds) {
    if (was) toast('Signed out in another tab.');
    return;
  }
  try {
    await useCredentials();
  } catch (e) {
    if (keepSignIn(e)) state.gh = new GitHub(auth);
  }
}

function showAccount() {
  const b = $('account');
  if (state.user) {
    b.innerHTML = `<img src="${escapeHtml(state.user.avatar_url)}&amp;s=40" alt=""> <span class="login">${escapeHtml(state.user.login)}</span>`;
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

// a branch list asked for one repository must not land in another (#31)
const branchRequests = latest();

async function applyLocation(want) {
  if (!want) {
    if (state.loc) saveDraftNow();
    state.repo = null;
    state.tree = null;
    openScratch();
    renderTree();
    return;
  }
  let r;
  try {
    const notText = (loc) => state.notText.get(notTextKey(loc));
    r = await loadLocation(state.gh, { repo: state.repo, tree: state.tree, loc: state.loc, notText }, want, busy);
  } catch (e) {
    // a file that is not text (or too large) opens on GitHub instead: say so, with a link
    if (e instanceof NotTextError) {
      state.notText.set(notTextKey(e.loc), e.notText);
      toast(`${escapeHtml(notTextReason(e.loc.path, e.size, e.notText))} <a href="${escapeHtml(githubUrl(e.loc, e.loc.path))}" target="_blank" rel="noopener">Open it on GitHub ↗</a>`, 10000);
      renderTree();
    }
    // nothing has changed (busy said why): the address goes back to what is still open. With
    // nothing open it is kept, so that reloading (signed in, say) tries it again.
    if (state.repo) history.replaceState(null, '', formatFragment(state.loc || { owner: state.repo.owner, name: state.repo.name, ref: state.tree?.ref }));
    else if (!state.loc) openScratch();
    return;
  }
  const { repo, tree, loc } = r;
  if (!want.ref || want.path !== loc.path) history.replaceState(null, '', formatFragment(loc));
  if (r.branches) {
    const current = branchRequests.begin();
    state.branches = [];
    state.open = new Set();
    r.branches.then((bs) => {
      if (!bs || !current()) return;
      state.branches = bs;
      renderBranches();
    });
  }
  state.repo = repo;
  state.tree = tree;
  if (!loc.path) {
    openScratch();
    renderBranches();
    status('This branch has no Markdown file to start with: open any file from the list, or create one with “＋ new”.', 'warn');
    return;
  }
  if (!r.same) showFile(loc, r.file);
  else renderTree(); // the text stays, but the file list may be another (a fork's)
  renderBranches();
}

function openScratch() {
  if (state.loc) saveDraftNow();
  state.loc = null;
  clearPending();
  state.doc = { base: null, sha: null, isNew: false };
  setText(drafts.openScratch(K.scratch, WELCOME));
  hideBanner();
  showDoc();
  draftWarning();
}

/** Shows the file at `loc`, as getFile read it (null: a new file). */
function showFile(loc, file) {
  if (state.loc) saveDraftNow();
  state.loc = loc;
  // the text has LF line endings and no BOM, as the textarea will; `format` writes them back
  state.doc = file ? { base: file.text, sha: file.sha, isNew: false, format: file.format }
    : { base: '', sha: null, isNew: true, format: PLAIN_FORMAT };
  clearPending();
  rememberRecent(loc);
  // a new file starts with a heading, but is not a draft until the user types
  const opened = drafts.openFile(draftKey(loc), state.doc, state.doc.isNew ? newFileText(loc.path) : '');
  const { draft } = opened;
  setText(opened.text);
  let banner = null;
  if (opened.kind === 'restored') {
    banner = { text: `Restored your unsaved changes from ${when(draft.at)}.`, actions: [['discard them', () => discardDraft()]] };
  } else if (opened.kind === 'conflict') {
    // the draft stays stored until one of these is chosen (or the file is committed)
    banner = {
      text: `You have unsaved changes from ${when(draft.at)}, but the file has changed on GitHub since.`,
      actions: [['restore my version', () => { drafts.resolve(); setText(draft.text, true); hideBanner(); }], ['discard it', () => discardDraft()]],
    };
  }
  showDoc();
  if (banner) showBanner(banner.text, banner.actions);
  else hideBanner();
  if (drafts.unstored) draftWarning();
  else if (state.doc.isNew) status(`${loc.path} is new: it will be created when you commit it.`, 'warn');
  else status('');
  loadPending(loc, draft?.text);
  $('src').setSelectionRange(0, 0);
  $('src').scrollTop = 0;
  $('previewScroll').scrollTop = 0;
}

const notTextKey = (loc) => `${loc.owner}/${loc.name}@${loc.ref}:${loc.path}`;

/**
 * Why the file at `path` is not opened in the editor, or '' when it is: `found` is what
 * opening it found ('binary', 'encoding', 'large'), else its name and `size` tell.
 */
function notTextReason(path, size, found) {
  const name = basename(path);
  const kind = found || notTextKind(path, size);
  if (kind === 'binary') return `${name} is not a text file, so meditor does not edit it.`;
  if (kind === 'encoding') {
    return `${name} is not UTF-8 text (it may be Latin-1 or another old encoding): meditor could neither show nor commit it as it is.`;
  }
  if (kind === 'large') {
    return `${name} is ${size ? formatSize(size) : 'too large'}: meditor opens text files up to ${formatSize(MAX_TEXT_BYTES)}.`;
  }
  return '';
}

function when(t) {
  if (!t) return 'earlier';
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString();
}

function discardDraft() {
  if (!state.loc) return;
  drafts.discard();
  forgetImages(draftKey(state.loc));
  clearPending();
  setText(state.doc.base, true);
  hideBanner();
  renderTree();
  draftWarning();
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
  showDocKind();
  renderTree();
  updateDirty();
  updateCommitButton();
  renderPreview(true);
}

/**
 * Markdown is edited beside its rendered page, with the formatting toolbar and a word count;
 * any other text file in the editor alone, full width (the view chosen for Markdown is kept
 * for the next Markdown file), as code.
 */
function showDocKind() {
  const md = isMdDoc();
  document.body.classList.toggle('codefile', !md);
  const ta = src();
  ta.spellcheck = md;
  ta.setAttribute('aria-label', md ? 'Markdown source' : 'source');
  for (const b of document.querySelectorAll('button[data-view]')) {
    b.dataset.title ??= b.title;
    b.disabled = !md;
    b.title = md ? b.dataset.title : 'only Markdown files are rendered';
  }
  applyView();
  updateStats();
  drawSource(); // a rename may have changed the language
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
  drafts.edit();
  onTextChanged();
}

const sel = () => ({ text: src().value, start: src().selectionStart, end: src().selectionEnd });

const COMMANDS = {
  bold: (s) => wrap(s, '**', '**', 'bold text'),
  italic: (s) => wrap(s, '*', '*', 'italic text'), // '_' does not work inside a word
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
  if (state.view === 'preview') setView(phone.matches ? 'edit' : 'split');
  applyEdit(COMMANDS[name](sel()));
}

let draftTimer;
let renderTimer;
function onTextChanged() {
  lineTops = null;
  if (find.open) searchText(false);
  drawSource();
  updateDirty();
  updateStats();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 400);
  clearTimeout(renderTimer);
  if (!isMdDoc()) return;
  const big = src().value.length > 200000;
  renderTimer = setTimeout(() => renderPreview(), state.renderer === 'github' ? 1200 : big ? 300 : 60);
}

/** Stores the text as a draft, if the user changed it in this tab (see drafts.js). */
function saveDraftNow() {
  clearTimeout(draftTimer);
  // the tree marks files with a draft: rebuilt only when that changes (it is costly, and
  // reopens directories the user closed)
  const had = state.loc && store.get(drafts.key) !== null;
  drafts.save(src().value);
  if (state.loc && had !== (store.get(drafts.key) !== null)) renderTree();
  draftWarning();
}

// Text that could not be stored stays in this tab; say so for as long as it is the case,
// whichever document is open (the page also asks before it is closed).
const DRAFT_WARN = {
  full: () => 'This browser’s storage is full: your changes are not kept as a draft. Commit or download them before you leave.',
  held: () => 'Your changes are not kept as a draft until you restore or discard the older one above.',
  other: () => {
    const names = [...drafts.memory.keys()].filter((k) => k !== drafts.key)
      .map((k) => (k === K.scratch ? 'the scratchpad' : k.slice(k.indexOf(':', K.draft.length) + 1)));
    return `Your changes to ${names.join(', ')} are only in this tab: they could not be kept as a draft. Open ${names.length > 1 ? 'them' : 'it'} again to commit or download them before you leave.`;
  },
};
let draftWarned = '';
function draftWarning() {
  const why = drafts.unstored;
  if (why) status((draftWarned = DRAFT_WARN[why]()), 'bad');
  else if (draftWarned && $('status').textContent === draftWarned) status('');
  if (!why) draftWarned = '';
}

/** Another tab stored a draft: show it in the file list, and offer it if it is of this document. */
function onStorage(e) {
  if (!e.key || (e.key !== K.scratch && !e.key.startsWith(K.draft))) return;
  if (e.key.startsWith(K.draft) && (e.oldValue === null) !== (e.newValue === null)) renderTree();
  let v = null;
  try { v = e.newValue === null ? null : JSON.parse(e.newValue); } catch { return; }
  const d = drafts.incoming(e.key, v, src().value);
  if (!d) return;
  // made on another version of the file: taking it, then committing, would undo a change
  const stale = d.stale ? `, made on another version of it than the one open here (it has changed on GitHub)` : '';
  showBanner(`Another tab or window saved changes to ${state.loc ? 'this file' : 'the scratchpad'} at ${when(d.at)}${stale}.`, [
    ['show them', () => { setText(d.text); drafts.take(d); hideBanner(); draftWarning(); }],
    ['keep mine', () => { drafts.keepMine(d); hideBanner(); saveDraftNow(); }],
  ]);
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
  const words = isMdDoc() ? `${countWords(text).toLocaleString()} words · ` : '';
  $('stats').textContent = `Ln ${line}, Col ${col} · ${words}${text.split('\n').length.toLocaleString()} lines`;
}

function updateCommitButton() {
  const b = $('commit');
  const loc = state.loc;
  b.disabled = !loc;
  b.title = shortcutText(!loc ? 'open a file from a repository to commit it'
    : !state.user ? 'sign in to commit'
      : canFork() ? 'you cannot push here: propose this change through a fork (Ctrl+S)'
        : 'commit this file to GitHub (Ctrl+S)', IS_MAC);
}

/** The user cannot push to the open repository, but can fork it and propose the change. */
const canFork = () => !!state.user && !!state.repo && !state.repo.canPush
  && state.user.login.toLowerCase() !== state.repo.owner.toLowerCase();

function onKeyDown(e) {
  const ta = src();
  const mod = e.ctrlKey || e.metaKey;
  const md = isMdDoc();
  if (md && commandHeld(e, IS_MAC) && !e.altKey) {
    const k = e.key.toLowerCase();
    const map = { b: 'bold', i: 'italic', k: 'link', e: 'code', 1: 'h1', 2: 'h2', 3: 'h3' };
    if (map[k] && !e.shiftKey) {
      e.preventDefault();
      command(map[k]);
      return;
    }
  }
  if (e.key === 'Escape' && find.open && !e.isComposing) {
    e.preventDefault();
    closeFind();
    return;
  }
  if (e.key === 'Tab' && !mod && !e.altKey) {
    e.preventDefault();
    applyEdit(indent(sel(), e.shiftKey, md ? null : indentUnit(ta.value, fileLanguage(state.loc.path) === 'make')));
    return;
  }
  if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.isComposing) {
    const r = md ? continueList(sel()) : newlineIndent(sel());
    if (r) {
      e.preventDefault();
      applyEdit(r);
      // keep the new line in view
      if (ta.selectionEnd === ta.value.length) ta.scrollTop = ta.scrollHeight;
    }
  }
}

// ---------------------------------------------------------------- highlighting
//
// The textarea's own text is transparent (its caret and selection are not); under it lies a
// copy of the text, one div per line, coloured by mdsyntax.js (Markdown) or highlight.js
// (code, by the file's language: see filetypes.js) and laid out exactly alike:
// same font, padding, wrapping and width, and moved with the textarea's scroll. Find
// matches are marked in the same copy, so it is also shown, uncoloured and under visible
// text, while the find bar is open with highlighting off. An edit re-tokenizes only the
// lines it touched, and those after it whose state it changed (an opened code fence).

const hl = {
  on: true,
  mode: '', // 'colour', 'plain' (find matches only) or '' (not shown)
  syntax: null, // the tokenizer (mdsyntax.js, syntaxFor) the colours are from
  lines: [], // the text drawn, by line
  states: [], // states[i]: the tokenizer's state before line i
  tokens: [],
  marks: [], // per line: the find marks drawn on it, as a string
  marked: 0, // lines with find marks
  els: [], // the lines' divs
};

// The lines' divs are grouped in blocks of CHUNK, so that the browser lays out again only
// the block an edit touched, not a container of thousands of lines. Blocks are not
// rebalanced as lines come and go; a full draw evens them out.
const CHUNK = 64;
const ZWSP = '\u200b'; // gives an empty line its height

/** Bring the highlighted copy up to date with the text and the find matches. */
function drawSource() {
  // the file's language, by its name, or a script's by its #! line; plain text has none
  const text = src().value;
  const nl = text.indexOf('\n');
  const syntax = syntaxFor(state.loc ? fileLanguage(state.loc.path, text.slice(0, nl < 0 ? 200 : Math.min(nl, 200))) : 'markdown');
  if (syntax !== hl.syntax) {
    hl.syntax = syntax;
    hl.lines = []; // all again
  }
  const want = hl.on && syntax ? 'colour' : find.open ? 'plain' : '';
  const box = $('srcHlText');
  if (want !== hl.mode) {
    hl.mode = want;
    hl.lines = [];
    $('srcWrap').classList.toggle('coloured', want === 'colour');
    $('srcHl').hidden = !want;
    if (!want) {
      box.replaceChildren();
      hl.els = [];
    } else {
      fitHl();
      scrollHl();
    }
  }
  // (and no reading of the textarea's layout from here on: that would lay it out again
  // at every keystroke; its scroll events keep the copy in place)
  if (!want) return;
  const lines = text.split('\n');
  const marks = find.open && find.matches.length
    ? rangesByLine(lines, find.matches, (k) => (k === find.cur ? 'hit cur' : 'hit')) : null;
  const colour = want === 'colour';
  const markKey = (i) => marks?.get(i)?.map((m) => m.join(',')).join(';') || '';
  const draw = (i) => {
    hl.marks[i] = markKey(i);
    hl.els[i].innerHTML = lineHtml(lines[i], colour ? hl.tokens[i] : [], marks?.get(i)) || ZWSP;
  };

  // the lines that changed: [a, newEnd) now, [a, oldEnd) before
  const old = hl.lines;
  const n = lines.length;
  let a = 0;
  while (a < n && a < old.length && lines[a] === old[a]) a++;
  let b = 0;
  while (b < n - a && b < old.length - a && lines[n - 1 - b] === old[old.length - 1 - b]) b++;
  const newEnd = n - b;
  const oldEnd = old.length - b;
  hl.lines = lines;

  // all at once: one innerHTML is much faster than hundreds of lines one by one
  const drawAll = () => {
    let st = syntax?.start;
    hl.states = [st];
    hl.tokens = [];
    hl.marks = [];
    hl.marked = 0;
    const html = [];
    for (let i = 0; i < n; i++) {
      if (colour) {
        const r = syntax.line(lines[i], st, lines[i + 1]);
        hl.tokens[i] = r.tokens;
        st = r.state;
        hl.states.push(st);
      }
      hl.marks[i] = markKey(i);
      if (hl.marks[i]) hl.marked++;
      if (i % CHUNK === 0) html.push(i ? '</div><div>' : '<div>');
      html.push(`<div>${lineHtml(lines[i], colour ? hl.tokens[i] : [], marks?.get(i)) || ZWSP}</div>`);
    }
    box.innerHTML = html.join('') + '</div>';
    hl.els = [...box.querySelectorAll(':scope > div > div')];
  };
  const MANY = 300;
  if (!old.length || newEnd - a > MANY) {
    // opening a file, a large paste
    drawAll();
    return;
  }

  const fresh = newEnd - a;
  hl.marks.splice(a, oldEnd - a, ...new Array(fresh).fill(null));
  const added = Array.from({ length: fresh }, () => document.createElement('div'));
  const removed = hl.els.splice(a, oldEnd - a, ...added);
  for (const el of removed) el.remove();
  if (a > 0) hl.els[a - 1].after(...added);
  else if (hl.els[fresh]) hl.els[fresh].before(...added);
  else (box.firstElementChild || box.appendChild(document.createElement('div'))).append(...added);

  if (colour) {
    // the lines whose colours may have changed; if that is far (a code fence opened above
    // the rest of the document), everything again
    const end = retokenize(lines, hl.tokens, hl.states, a, oldEnd, newEnd, MANY, syntax);
    if (end < 0) {
      drawAll();
      return;
    }
    for (let i = Math.max(0, a - 1); i < end; i++) draw(i);
  } else {
    for (let i = a; i < newEnd; i++) draw(i);
  }

  // find marks that came, went or moved
  if (marks || hl.marked) {
    hl.marked = 0;
    for (let i = 0; i < n; i++) {
      const k = markKey(i);
      if (k !== hl.marks[i]) draw(i);
      if (k) hl.marked++;
    }
  }
}

/** The copy is as wide and high as the textarea's inside (without its scrollbar). */
function fitHl() {
  if (!hl.mode) return;
  const ta = src();
  const s = $('srcHl').style;
  s.width = `${ta.clientWidth}px`;
  s.height = `${ta.clientHeight}px`;
}

function scrollHl() {
  if (!hl.mode) return;
  const ta = src();
  $('srcHlText').style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
}

// ---------------------------------------------------------------- find and replace
//
// Ctrl+F (Ctrl+H with replace; ⌘F, ⌥⌘F on macOS) in the editor opens a bar above the
// text. The matches are found by find.js; the current one is selected in the textarea, and
// all of them are marked in the highlighted copy, which also tells where the current one
// is drawn.

const find = {
  open: false,
  opts: { caseSensitive: false, wholeWord: false, regex: false },
  matches: [],
  cur: -1, // index of the current match, or -1 when the selection is on none
  capped: false,
  error: '',
  anchor: 0, // where a changed query looks for its first match from
};

function openFind(replace) {
  const ta = src();
  const input = $('findInput');
  if (state.view === 'preview') setView(phone.matches ? 'edit' : 'split');
  // the selected text becomes the query, unless it is the current match already
  const s = ta.value.slice(ta.selectionStart, ta.selectionEnd);
  const m = find.open && find.matches[find.cur];
  const onMatch = m && m.start === ta.selectionStart && m.end === ta.selectionEnd;
  if (s && !s.includes('\n') && s.length <= 200 && !onMatch) input.value = find.opts.regex ? escapeRegExp(s) : s;
  find.anchor = ta.selectionStart;
  if (!find.open) {
    find.open = true;
    $('findBar').hidden = false;
    showReplace(replace);
    lineTops = null;
  } else if (replace) showReplace(true);
  const to = replace && input.value ? $('replaceInput') : input;
  to.focus();
  to.select();
  searchText(true);
  drawSource();
  reveal();
}

function closeFind() {
  if (!find.open) return;
  find.open = false;
  find.matches = [];
  find.cur = -1;
  $('findBar').hidden = true;
  lineTops = null;
  drawSource();
  src().focus();
}

function showReplace(on) {
  $('replaceRow').hidden = !on;
  $('replaceToggle').setAttribute('aria-expanded', String(on));
}

/** Find the matches again; `jump` makes the first one from the anchor current and selects it. */
function searchText(jump) {
  const ta = src();
  const r = findAll(ta.value, $('findInput').value, find.opts);
  find.matches = r.matches;
  find.capped = r.capped;
  find.error = r.error;
  if (jump) {
    find.cur = matchFrom(find.matches, find.anchor);
    if (find.cur >= 0) select();
  } else {
    // still on a match if the selection is exactly one
    const i = matchFrom(find.matches, ta.selectionStart);
    const m = find.matches[i];
    find.cur = m && m.start === ta.selectionStart && m.end === ta.selectionEnd ? i : -1;
  }
  showCount();
}

function select() {
  const m = find.matches[find.cur];
  src().setSelectionRange(m.start, m.end);
  updateStats();
}

function showCount() {
  const c = $('findCount');
  const q = $('findInput').value;
  const n = find.matches.length;
  const total = find.capped ? `${MAX_MATCHES.toLocaleString()}+` : n.toLocaleString();
  c.textContent = find.error || !q ? find.error
    : !n ? 'no matches'
      : find.cur >= 0 ? `${(find.cur + 1).toLocaleString()} of ${total}` : `${total} found`;
  c.title = find.error ? `not a valid regular expression: ${find.error}` : '';
  const bad = !!find.error || (!!q && !n);
  c.classList.toggle('bad', bad);
  $('findInput').classList.toggle('bad', bad);
  for (const id of ['findPrev', 'findNext', 'replaceOne', 'replaceAll']) $(id).disabled = !n;
}

/** Scroll the textarea so that the current match is in view, if it is not. */
function reveal() {
  const m = find.matches[find.cur];
  if (!m) return;
  const ta = src();
  // the highlighted copy is laid out like the textarea, so its mark is where the match is
  // drawn, wrapping included; an empty match has no mark, but its line's top will do
  const el = $('srcHlText').querySelector('.cur');
  let top;
  let bottom;
  if (el) {
    top = el.offsetTop;
    bottom = top + el.offsetHeight;
  } else {
    const tops = measureLines();
    const line = ta.value.slice(0, m.start).split('\n').length - 1;
    top = tops[line];
    bottom = tops[line + 1];
  }
  const view = ta.clientHeight;
  if (top < ta.scrollTop + 4 || bottom > ta.scrollTop + view - 4) ta.scrollTop = Math.max(0, top - view / 3);
}

/** To the next (1) or previous (-1) match, from the current one or from the selection. */
function step(dir) {
  const n = find.matches.length;
  if (!n) return;
  const ta = src();
  const m = find.matches[find.cur];
  const on = m && m.start === ta.selectionStart && m.end === ta.selectionEnd;
  find.cur = on ? (find.cur + dir + n) % n
    : dir > 0 ? matchFrom(find.matches, ta.selectionEnd) : matchBefore(find.matches, ta.selectionStart);
  find.anchor = find.matches[find.cur].start;
  select();
  showCount();
  drawSource();
  reveal();
}

function replaceCurrent() {
  const ta = src();
  const m = find.matches[find.cur];
  if (!m || m.start !== ta.selectionStart || m.end !== ta.selectionEnd) {
    step(1);
    return;
  }
  const r = replaceOne(ta.value, m, $('findInput').value, $('replaceInput').value, find.opts);
  if (r) {
    find.anchor = anchorAfter(r, m);
    applyEdit({ text: r.text, start: r.end, end: r.end });
  }
  searchText(true);
  drawSource();
  reveal();
  $('replaceInput').focus();
}

function replaceEvery() {
  const ta = src();
  const r = replaceAll(ta.value, $('findInput').value, $('replaceInput').value, find.opts);
  if (!r.count) return;
  // one edit, so one Ctrl+Z undoes it
  applyEdit({ text: r.text, start: r.first, end: r.first });
  status(`Replaced ${r.count.toLocaleString()} ${r.count === 1 ? 'match' : 'matches'}.`);
  $('replaceInput').focus();
}

function initFind() {
  const input = $('findInput');
  // every tooltip's shortcuts as on macOS, when on it (⌘B, not Ctrl+B: ⌃B moves the caret)
  for (const el of document.querySelectorAll('[title]')) el.title = shortcutText(el.title, IS_MAC);
  input.addEventListener('input', () => {
    searchText(true);
    drawSource();
    reveal();
  });
  for (const b of document.querySelectorAll('[data-find-opt]')) {
    b.addEventListener('click', () => {
      const o = b.dataset.findOpt;
      find.opts[o] = !find.opts[o];
      b.setAttribute('aria-pressed', String(find.opts[o]));
      searchText(true);
      drawSource();
      reveal();
    });
  }
  // the buttons leave the focus where it was (the find field, or the text)
  for (const b of $('findBar').querySelectorAll('button')) b.addEventListener('mousedown', (e) => e.preventDefault());
  $('findNext').addEventListener('click', () => step(1));
  $('findPrev').addEventListener('click', () => step(-1));
  $('findClose').addEventListener('click', closeFind);
  $('replaceToggle').addEventListener('click', () => {
    showReplace($('replaceRow').hidden);
    if (!$('replaceRow').hidden) $('replaceInput').focus();
  });
  $('replaceOne').addEventListener('click', replaceCurrent);
  $('replaceAll').addEventListener('click', replaceEvery);
  $('findOpen').addEventListener('click', () => openFind(false));
  $('findBar').addEventListener('keydown', (e) => {
    const mod = commandHeld(e, IS_MAC);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
      return;
    }
    const opt = findOptionKey(keyInfo(e), IS_MAC);
    if (opt) {
      e.preventDefault();
      $('findBar').querySelector(`[data-find-opt="${opt}"]`).click();
      return;
    }
    if (e.key !== 'Enter' || e.isComposing) return;
    if (e.target === input) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.target === $('replaceInput')) {
      e.preventDefault();
      if (mod) replaceEvery();
      else replaceCurrent();
    }
  });
}

// ---------------------------------------------------------------- pasted images
//
// An image pasted or dropped into the source goes next to the document (see images.js): its
// link is inserted at once, the preview shows it from an object URL, and it is committed with
// the document, in the same commit. Until then it is kept with the draft, in IndexedDB (local
// storage holds strings, and too few of them for images), under the draft's key. Images whose
// link is gone by the time of the commit are left out, and forgotten.

const IDB = { name: 'meditor', store: 'images' };
let idb = null;

function openIdb() {
  if (!idb) {
    idb = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB.store, { keyPath: 'id' }).createIndex('doc', 'doc');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    idb.catch(() => { idb = null; });
  }
  return idb;
}

/** Runs `fn(store)` in a transaction; resolves with the result of the request `fn` returned, once done. */
async function idbDo(mode, fn) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB.store, mode);
    const r = fn(tx.objectStore(IDB.store));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const imageId = (doc, path) => `${doc}\n${path}`;
const imagesOf = (doc) => idbDo('readonly', (s) => s.index('doc').getAll(doc)).catch(() => []);
/** Forgets the images kept for the draft `doc` (only those at `paths`, if given). */
const forgetImages = (doc, paths = null) => idbDo('readwrite', (s) => {
  const req = s.index('doc').openCursor(IDBKeyRange.only(doc));
  req.onsuccess = () => {
    const c = req.result;
    if (!c) return;
    if (!paths || paths.includes(c.value.path)) c.delete();
    c.continue();
  };
}).catch(() => {});

/** Lets go of the open document's pending images (they stay in IndexedDB). */
function clearPending() {
  for (const p of state.pending.values()) URL.revokeObjectURL(p.url);
  state.pending = new Map();
}

const pendingEntry = (blob, rel) => ({ blob, rel, url: URL.createObjectURL(blob) });

/** After opening a file: its images from an earlier visit, less those its text no longer links. */
async function loadPending(loc, draftText) {
  const doc = draftKey(loc);
  const recs = await imagesOf(doc);
  if (!state.loc || draftKey(state.loc) !== doc || !recs.length) return;
  const used = new Set([...referencedPaths(src().value, loc.path), ...referencedPaths(draftText || '', loc.path)]);
  const gone = [];
  for (const r of recs) {
    if (!used.has(r.path)) gone.push(r.path);
    else if (!state.pending.has(r.path)) state.pending.set(r.path, pendingEntry(r.blob, r.rel));
  }
  if (gone.length) forgetImages(doc, gone);
  if (state.pending.size) renderPreview(true);
}

/** The pending images the text still links to, in the order they were pasted. */
function imagesToCommit() {
  if (!state.loc || !state.pending.size) return [];
  const used = referencedPaths(src().value, state.loc.path);
  return [...state.pending].filter(([path]) => used.has(path)).map(([path, p]) => ({ path, ...p }));
}

function onPaste(e) {
  if (!isMdDoc()) return; // a picture means nothing in code: the browser does what it does
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  addImages(files);
}

function onDragOver(e) {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault(); // or the browser opens the file in place of the editor
  e.dataTransfer.dropEffect = 'copy';
}

function onDrop(e) {
  const all = [...(e.dataTransfer?.files || [])];
  if (!all.length) return;
  e.preventDefault();
  const files = all.filter((f) => f.type.startsWith('image/'));
  if (files.length && !isMdDoc()) toast('Images can be added to Markdown files only.');
  else if (files.length) addImages(files);
  else toast('Only images can be dropped into the text.');
}

function addImages(files) {
  const loc = state.loc;
  if (!loc) {
    toast('An image goes into a repository with the document that shows it: open a file from a repository first.');
    return;
  }
  if (state.repo && !state.repo.canPush) {
    toast(canFork()
      ? 'You cannot push to this repository: “fork and propose” will commit the image with the document in your fork.'
      : 'You cannot push to this repository, so the image cannot be committed with the document.');
  }
  const inTree = new Set((state.tree?.entries || []).map((e) => e.path.toLowerCase()));
  const taken = (p) => inTree.has(p.toLowerCase()) || [...state.pending.keys()].some((k) => k.toLowerCase() === p.toLowerCase());
  const doc = draftKey(loc);
  const rels = [];
  for (const f of files) {
    const { path, rel } = proposeImagePath(loc.path, f, taken);
    const blob = f.slice(0, f.size, f.type); // a Blob: IndexedDB need not keep the File's name
    state.pending.set(path, pendingEntry(blob, rel));
    rels.push(rel);
    idbDo('readwrite', (s) => s.put({ id: imageId(doc, path), doc, path, rel, blob, at: Date.now() }))
      .catch(() => status('This browser cannot keep the image for later (no IndexedDB): commit it before closing the page.', 'warn'));
  }
  const { text, start, end } = sel();
  const md = imageMarkdown(rels);
  applyEdit({ text: text.slice(0, start) + md + text.slice(end), start: start + md.length, end: start + md.length });
  renderPreview(true);
  status(`${rels.length === 1 ? rels[0] : `${rels.length} images`} will be committed with ${basename(loc.path)}.`);
}

/** A renamed document's images: re-keyed, and moved with it so that their links still hold. */
async function movePending(from, to) {
  const recs = await imagesOf(draftKey(from));
  if (!recs.length) return;
  const doc = draftKey(to);
  const moved = recs.map((r) => {
    const path = joinPath(dirname(to.path), r.rel);
    return { ...r, doc, path, id: imageId(doc, path) };
  });
  await forgetImages(draftKey(from));
  await idbDo('readwrite', (s) => { for (const r of moved) s.put(r); }).catch(() => {});
  if (state.loc && draftKey(state.loc) === doc) {
    clearPending();
    for (const r of moved) state.pending.set(r.path, pendingEntry(r.blob, r.rel));
    renderPreview(true);
  }
}

// ---------------------------------------------------------------- the preview

function resolveImage(url) {
  const loc = state.loc;
  if (!loc) return { src: url };
  const r = resolveRef(url, loc);
  if (r.kind !== 'repo') return { src: url };
  if (state.pending.has(r.path)) return { src: state.pending.get(r.path).url };
  if (state.repo && !state.repo.private) return { src: rawUrl(loc, r.path) };
  const key = `${loc.owner}/${loc.name}@${loc.ref}:${r.path}`;
  return { src: state.images.get(key) || PIXEL, path: r.path };
}

function resolveLink(url) {
  const loc = state.loc;
  if (!loc) return url;
  const r = resolveRef(url, loc);
  // above the repository's root: on github.com, never relative to the editor's page (#31)
  if (r.kind === 'outside') return r.url;
  if (r.kind !== 'repo') return url;
  // Markdown, and other text files of the repository, open here; the rest on GitHub
  if (MARKDOWN_EXT.test(r.path)) return formatFragment({ ...loc, path: r.path });
  const entry = state.tree?.entries.find((e) => e.path === r.path && e.type === 'file');
  if (entry && !notTextReason(r.path, entry.size, state.notText.get(notTextKey({ ...loc, path: r.path })))) {
    return formatFragment({ ...loc, path: r.path });
  }
  const isDir = state.tree?.entries.some((e) => e.type === 'dir' && e.path === r.path) || url.endsWith('/') || r.path === '';
  return githubUrl(loc, r.path, isDir ? 'tree' : 'blob') + (r.hash ? '#' + r.hash : '');
}

let renderSeq = 0;
async function renderPreview(now = false) {
  clearTimeout(renderTimer);
  const text = src().value;
  const out = $('preview');
  const seq = ++renderSeq;
  if (!isMdDoc()) {
    // nothing to render (and a repository's HTML is never shown as a page): the panel is hidden
    out.replaceChildren();
    out.dataset.rendered = '';
    $('renderNote').textContent = '';
    previewBlocks = null;
    return;
  }
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
  let html;
  try {
    html = renderMarkdown(text, { resolveImage, resolveLink });
  } catch (e) {
    // a renderer bug must not leave a stale preview looking current
    status(`meditor could not render this: ${e.message}`, 'warn');
    return;
  }
  out.innerHTML = html;
  out.dataset.rendered = text;
  for (const box of out.querySelectorAll('input.task-list-item-checkbox[data-line]')) box.disabled = false;
  for (const img of out.querySelectorAll('img')) img.addEventListener('error', () => img.classList.add('missing'), { once: true });
  fixRelative(out);
  previewBlocks = null;
}

/** Raw HTML in the document, and GitHub's renderer, leave relative links and images as written. */
function fixRelative(root) {
  for (const a of root.querySelectorAll('a[href]')) {
    let href = a.getAttribute('href');
    if (!/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href)) {
      href = resolveLink(href);
      a.setAttribute('href', href);
    }
    if (isExternalLink(href)) {
      // never navigate the editor away (or hand the new page a handle on it)
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
    }
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
  // "switch the renderer to GitHub (exact)" under a Mermaid diagram's source
  const sw = e.target.closest('button.mermaid-switch[data-renderer]');
  if (sw) {
    $('renderer').value = sw.dataset.renderer;
    $('renderer').dispatchEvent(new Event('change'));
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

/** Style the hidden copy of the textarea like it; returns the textarea's top padding. */
function prepareMirror() {
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
  return parseFloat(cs.paddingTop) || 0;
}

function measureLines() {
  if (lineTops) return lineTops;
  const ta = src();
  const pad = prepareMirror();
  const lines = ta.value.split('\n');
  const frag = document.createDocumentFragment();
  for (const l of lines) {
    const d = document.createElement('div');
    d.textContent = l || '​';
    frag.append(d);
  }
  mirror.replaceChildren(frag);
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
  // Top-level blocks and list items: only they carry data-line (checkboxes aside). Some sit
  // inside a raw HTML element (<div align="center">), and some are hidden (a closed <details>).
  previewBlocks = [...root.querySelectorAll('[data-line]:not(input)')]
    .filter((el) => el.getClientRects().length)
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
  const sizes = new Map();
  const files = [];
  for (const e of state.tree.entries) {
    if (e.type !== 'file' || (state.mdOnly && !MARKDOWN_EXT.test(e.path))) continue;
    files.push(e.path);
    sizes.set(e.path, e.size);
  }
  const loc = { owner: repo.owner, name: repo.name, ref: state.tree.ref };
  const notText = (path) => notTextReason(path, sizes.get(path), state.notText.get(notTextKey({ ...loc, path })));
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
    // a file that is not text opens on GitHub (a link, so it can open in a tab of its own)
    const why = notText(path);
    const md = MARKDOWN_EXT.test(path);
    const b = document.createElement(why ? 'a' : 'button');
    if (why) {
      b.href = githubUrl(loc, path);
      b.target = '_blank';
      b.rel = 'noopener';
      b.className = 'node bin';
      b.title = `${why} Opens on GitHub.`;
    } else {
      b.type = 'button';
      b.className = 'node' + (path === cur ? ' current' : '') + (md ? '' : ' txt');
      b.dataset.path = path;
      b.title = path;
      if (path === cur) b.setAttribute('aria-current', 'true');
    }
    const icon = why ? '<span class="ic" aria-hidden="true">◦</span>'
      : md ? '<span class="ic" aria-hidden="true">▤</span>' : '<span class="ic" aria-hidden="true">▢</span>';
    b.innerHTML = `${icon}<span class="nm">${escapeHtml(label)}</span>`
      + (why ? '<span class="ext" aria-hidden="true">↗</span><span class="sr-only">, not text: opens on GitHub</span>' : '')
      + (drafts.has(path) ? '<span class="draft" title="unsaved changes in this browser" aria-hidden="true">●</span><span class="sr-only">, unsaved changes</span>' : '');
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
  const none = state.mdOnly ? 'Markdown file' : 'file';
  if (filter) {
    const hits = files.filter((p) => p.toLowerCase().includes(filter)).sort();
    // a few hundred at most: a short filter in a large repository matches thousands
    const MAX_HITS = 500;
    for (const p of hits.slice(0, MAX_HITS)) ul.append(fileNode(p, p));
    if (hits.length > MAX_HITS) {
      const li = document.createElement('li');
      li.className = 'note';
      li.textContent = `and ${(hits.length - MAX_HITS).toLocaleString()} more: type more of the name`;
      ul.append(li);
    }
    if (!hits.length) ul.innerHTML = `<li class="note">no ${none} matches</li>`;
  } else {
    // a directory tree holding the files (the Markdown ones only, if so chosen)
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
        b.innerHTML = `<span class="ic" aria-hidden="true">${isOpen ? '▾' : '▸'}</span><span class="nm">${escapeHtml(d)}/</span>`;
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
    if (!files.length) ul.innerHTML = `<li class="note">no ${none}s on this branch</li>`;
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
  if (b.dataset.path) closeDrawer();
  // the file list's repository and branch, which are also the open file's (#31)
  if (b.dataset.path && state.repo && state.tree) go({ owner: state.repo.owner, name: state.repo.name, ref: state.tree.ref, path: b.dataset.path });
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
  closeDrawer();
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
  // any file (one that is not text says so); a directory opens its README
  go({ owner: p.owner, name: p.name, ref, path: path || undefined });
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
  const imgs = imagesToCommit();
  $('commitImages').hidden = !imgs.length;
  $('commitImages').replaceChildren(...imgs.map((i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="mono">＋ ${escapeHtml(i.path)}</span> <span class="help">${formatSize(i.blob.size)}</span>`;
    return li;
  }));
  $('commitWith').textContent = imgs.length ? ` and ${imgs.length === 1 ? 'an image' : `${imgs.length} images`}` : '';
  $('commitBranch').textContent = loc.ref;
  $('commitMsg').value = `${state.doc.isNew ? 'Create' : 'Update'} ${basename(loc.path)}`;
  $('commitBody').value = '';
  $('commitError').hidden = true;
  $('diff').hidden = true;
  $('commitProgress').hidden = true;
  const login = state.user.login.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const topic = `${basename(loc.path).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36).slice(-4)}`;
  $('prBranch').value = `${login}/${topic}`;
  // in the user's own fork the branch needs no name of theirs in front
  $('forkBranch').value = topic;
  const radio = (v) => document.querySelector(`input[name="target"][value="${v}"]`);
  const fork = canFork();
  radio('direct').closest('label').hidden = !repo.canPush;
  radio('pr').closest('label').hidden = !repo.canPush;
  $('forkChoice').hidden = !fork;
  radio(fork ? 'fork' : 'direct').checked = true;
  $('forkUser').textContent = state.user.login;
  $('forkBase').textContent = `${repo.full} @ ${loc.ref}`;
  $('commitGo').disabled = !repo.canPush && !fork;
  $('commitGo').textContent = fork ? 'fork and propose' : 'commit';
  $('commitNote').textContent = repo.canPush ? ''
    : !fork ? 'You cannot push to this repository. Download the file, or fork the repository on GitHub and open the fork here.'
      : `You cannot push to ${repo.full}. meditor forks it to your account (or uses the fork you have), commits the file to a new branch there and opens a pull request; you can then keep editing on that branch.`
        + (auth.kind === 'app' ? ' Signed in with GitHub, meditor needs to be installed on the fork as well; if it is not, it will say how.' : '');
  $('commitDlg').showModal();
  $('commitMsg').select();
}

function showDiff() {
  const pre = $('diff');
  if (!pre.hidden) { pre.hidden = true; return; }
  const d = lineDiff(state.doc.base, src().value);
  const imgs = imagesToCommit().map((i) => `<span class="file">new image ${escapeHtml(i.path)} (${formatSize(i.blob.size)})</span>`);
  if (imgs.length) imgs.push(`<span class="file">${escapeHtml(state.loc.path)}</span>`);
  pre.innerHTML = imgs.join('') + d.map(({ op, line }) => {
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
  const target = document.querySelector('input[name="target"]:checked').value;
  const pr = target === 'pr';
  const err = $('commitError');
  err.hidden = true;
  $('commitGo').disabled = true;
  try {
    // a file that was not UTF-8 is refused before anything (a branch, a fork) is made
    encodeFile(text, state.doc.format, loc.path);
    if (target === 'fork') {
      await propose({ text, title, body, message });
      return;
    }
    let branch = loc.ref;
    let made = null;
    if (pr) {
      branch = $('prBranch').value.trim();
      if (!branch) throw new Error('Name the new branch.');
      made = `${loc.owner}/${loc.name}@${loc.ref}:${branch}`;
      const resume = prBranchMade === made;
      await busy(`creating branch ${branch}`, () => state.gh.createBranch(loc.owner, loc.name, branch, loc.ref, { resume }));
      prBranchMade = made;
    }
    const format = state.doc.format;
    const imgs = imagesToCommit();
    let r;
    if (imgs.length) {
      // the document and its images in one commit; the document must still be as it was
      // opened (or still not exist), as putFile checks with `sha`
      const changes = [{ path: loc.path, text, format, expect: state.doc.isNew ? null : state.doc.sha }];
      for (const i of imgs) {
        changes.push({ path: i.path, blobBase64: bytesToBase64(new Uint8Array(await i.blob.arrayBuffer())), expect: null });
      }
      const c = await busy('committing', () => state.gh.commitChanges(loc.owner, loc.name, branch, { message, changes }));
      r = { sha: c.blobs[loc.path], commit: { sha: c.sha, html_url: c.html_url }, blobs: c.blobs };
    } else {
      r = await busy('committing', () => state.gh.putFile(loc.owner, loc.name, loc.path, { text, message, branch, sha: state.doc.sha, format }));
      r.blobs = { [loc.path]: r.sha };
    }
    if (made) prBranchMade = null;
    drafts.committed(draftKey(loc), text, r.sha);
    forgetImages(draftKey(loc));
    const committed = new Map(imgs.map((i) => [i.path, i]));
    for (const [path, p] of state.pending) if (!committed.has(path)) URL.revokeObjectURL(p.url);
    state.pending = new Map();
    state.doc = { base: text, sha: r.sha, isNew: false, format };
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
      drafts.rename(draftKey(next));
      rememberRecent(next);
      history.pushState(null, '', formatFragment(next));
      state.tree = { ...(await state.gh.tree(loc.owner, loc.name, branch)), ref: branch };
      renderBranches();
    } else if (state.tree?.ref === branch) {
      // the file list's shas are those a rename or delete checks against
      recordCommit(state.tree.entries, r.blobs);
    }
    // the images are in the repository now; a private one's are shown from what we have
    for (const [path, i] of committed) {
      const key = `${state.loc.owner}/${state.loc.name}@${state.loc.ref}:${path}`;
      if (state.repo?.private && !state.images.has(key)) state.images.set(key, i.url);
      else URL.revokeObjectURL(i.url);
    }
    status('');
    draftWarning();
    toast(note, 9000);
    showDoc();
  } catch (e) {
    $('commitProgress').hidden = true;
    err.textContent = e.message;
    err.hidden = false;
    // something to do on github.com first (install meditor, fork by hand, …), then retry
    for (const { url, label } of e.actions || []) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `${label} ↗`;
      err.append(' ', a);
    }
    // the file is not the version it was opened at (not a protected branch, nor a moved one)
    if (e.status === 409 && e.body?.conflict && (e.body.path || loc.path) === loc.path) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'load the latest version';
      btn.addEventListener('click', reloadKeepingText);
      err.append(' ', btn);
    }
    if (e.body?.protected && target === 'direct' && state.repo?.canPush) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'commit to a new branch instead';
      btn.addEventListener('click', () => {
        document.querySelector('input[name="target"][value="pr"]').checked = true;
        $('prBranch').focus();
      });
      err.append(' ', btn);
    }
  } finally {
    $('commitGo').disabled = !state.repo?.canPush && !canFork();
  }
}

// The branch a "fork and propose" created in the fork before failing later on (say, the
// file had changed upstream): trying again with the same name takes that branch over.
let forkBranchMade = null;
// The same for "commit to a new branch": the branch it created before the commit failed.
let prBranchMade = null;

/**
 * Forks the open repository (or finds the user's fork), commits there, and opens a pull
 * request. Afterwards the editor is on the fork's new branch, as after "commit to a new
 * branch" it is on that branch: further commits go to it, and so to the pull request.
 */
async function propose({ text, title, body, message }) {
  const loc = state.loc;
  const branch = $('forkBranch').value.trim();
  if (!branch) throw new Error('Name the new branch.');
  const key = `${loc.owner}/${loc.name}@${loc.ref}:${branch}`;
  const shown = $('commitProgress');
  const imgs = imagesToCommit();
  const images = [];
  for (const i of imgs) images.push({ path: i.path, blobBase64: bytesToBase64(new Uint8Array(await i.blob.arrayBuffer())) });
  const r = await busy('proposing the change', () => proposeChange(state.gh, {
    upstream: loc, login: state.user.login, branch, text, message, sha: state.doc.sha, title, body,
    installUrl: installUrl(), resume: forkBranchMade === key, images, format: state.doc.format,
  }, {
    progress: (t) => { shown.textContent = `${t}…`; shown.hidden = false; },
    created: () => { forkBranchMade = key; },
  }));
  forkBranchMade = null;
  drafts.committed(draftKey(loc), text, r.sha);
  forgetImages(draftKey(loc));
  // the images are in the fork now: shown from what we have if it is private, else from it
  const committed = new Map(imgs.map((i) => [i.path, i]));
  for (const [path, p] of state.pending) if (!committed.has(path)) URL.revokeObjectURL(p.url);
  state.pending = new Map();
  for (const [path, i] of committed) {
    const k = `${r.fork.owner}/${r.fork.name}@${branch}:${path}`;
    if (r.fork.private && !state.images.has(k)) state.images.set(k, i.url);
    else URL.revokeObjectURL(i.url);
  }
  state.doc = { base: text, sha: r.sha, isNew: false, format: state.doc.format };
  $('commitDlg').close();
  hideBanner();
  const link = (url, label) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
  let note = `Committed ${link(r.commit.html_url, r.commit.sha.slice(0, 7))} to ${escapeHtml(branch)} in your fork ${escapeHtml(r.fork.full)}.`;
  note += r.pull ? ` Opened ${link(r.pull.html_url, `pull request #${r.pull.number}`)} in ${escapeHtml(loc.owner)}/${escapeHtml(loc.name)}.`
    : ` ${link(r.compare, 'Open the pull request on GitHub')}.`;
  // Go on in the fork, on the new branch: its file list, its branches, and commits that go
  // to the pull request. The text is kept (state.loc is set first, so applyLocation does not read it again).
  const next = { owner: r.fork.owner, name: r.fork.name, ref: branch, path: loc.path };
  state.loc = next;
  drafts.rename(draftKey(next));
  rememberRecent(next);
  go(next);
  await routing;
  status('');
  draftWarning();
  showDoc();
  toast(note, 12000);
  const pull = r.pull;
  showBanner(`This is your fork ${r.fork.full}, on the branch ${branch}${pull ? ` of pull request #${pull.number}` : ''}: what you commit here goes to ${pull ? 'the pull request' : 'that branch'}.`,
    [[pull ? `pull request #${pull.number} ↗` : 'open the pull request ↗', () => window.open(pull ? pull.html_url : r.compare, '_blank', 'noopener')]]);
}

/** The file changed on GitHub: take its new version as the base, keep the text being edited. */
async function reloadKeepingText() {
  const loc = state.loc;
  const f = await busy('loading the latest version', () => state.gh.getFile(loc.owner, loc.name, loc.path, loc.ref));
  if (!f || f.text === null) {
    // (it may have become binary, or too large, on GitHub since)
    if (f) status(notTextReason(loc.path, f.size, f.tooLarge ? 'large' : f.notUtf8 ? 'encoding' : 'binary'), 'bad');
    return;
  }
  state.doc = { base: f.text, sha: f.sha, isNew: false, format: f.format };
  if (state.tree?.ref === loc.ref) recordCommit(state.tree.entries, { [loc.path]: f.sha });
  drafts.rebase(f.text, f.sha);
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
    // renames and deletes go straight to the branch: there is no pull request to offer here
    err.textContent = e.body?.protected
      ? `GitHub refused to change ${ref}, a protected branch: ${String(e.body.message).trim().replace(/\.$/, '')}. Rename or delete the file through a pull request on GitHub instead.`
      : e.message;
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
    movePending(loc, { ...loc, path: to });
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
    forgetImages(draftKey(loc));
    store.set(K.recent, removeRecent(store.get(K.recent, []), loc));
    if (entry) state.tree.entries = state.tree.entries.filter((e) => e !== entry);
  }

  const commit = r ? ` in <a href="${escapeHtml(r.html_url)}" target="_blank" rel="noopener">${r.sha.slice(0, 7)}</a>` : '';
  toast(act === 'move'
    ? `Moved ${escapeHtml(path)} to ${escapeHtml(to)}${commit}.`
    : `Deleted ${escapeHtml(path)}${commit}.`, 9000);
  status('');
  draftWarning();

  if (isOpen && act === 'move') {
    // the same text, under its new name: no need to read it again
    state.loc = { ...loc, path: to };
    rememberRecent(state.loc);
    history.replaceState(null, '', formatFragment(state.loc));
    drafts.rename(draftKey(state.loc));
    saveDraftNow();
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
  const typed = joinPath('', $('newPath').value.trim());
  if (!typed) return false;
  // any text file: as typed if it has an extension (or is a Makefile, a .gitignore…), else .md
  const r = newFilePath(typed);
  if (r.error) {
    $('newError').textContent = r.error;
    $('newError').hidden = false;
    return false;
  }
  const ref = state.tree?.ref || state.repo.defaultBranch;
  go({ owner: state.repo.owner, name: state.repo.name, ref, path: r.path });
  return true;
}

function download() {
  const name = state.loc ? basename(state.loc.path) : 'scratchpad.md';
  const blob = new Blob([src().value], { type: `${isMdDoc() ? 'text/markdown' : 'text/plain'};charset=utf-8` });
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

// A phone shows one panel at a time and does not offer "both"; what is chosen there is kept
// apart from the choice for wider screens, which the same browser may also have.
function setView(v) {
  if (!phone.matches) state.wideView = v;
  else if (v !== 'split') state.phoneView = v;
  savePrefs();
  applyView();
}

/** Shows the view chosen (or, for a file that is not Markdown, the source alone). */
function applyView() {
  let v = phone.matches ? state.phoneView : state.wideView;
  if (!isMdDoc()) v = 'edit';
  state.view = v;
  $('workspace').dataset.view = v;
  for (const b of document.querySelectorAll('[data-view]')) {
    if (b.tagName === 'BUTTON') b.setAttribute('aria-checked', String(b.dataset.view === v));
  }
  lineTops = null;
  previewBlocks = null;
  placeSplits();
}

// On narrow screens the file list is a drawer over the panels: opened for a moment, and not
// remembered.
function setFilesVisible(on) {
  $('workspace').classList.toggle('nofiles', !on);
  $('toggleFiles').setAttribute('aria-pressed', String(on));
  if (!narrow.matches) {
    state.filesPref = on;
    savePrefs();
  }
  lineTops = null;
  previewBlocks = null;
  placeSplits();
}

function closeDrawer() {
  if (narrow.matches && !$('workspace').classList.contains('nofiles')) setFilesVisible(false);
}

function savePrefs() {
  store.set(K.prefs, {
    view: state.wideView,
    phoneView: state.phoneView,
    files: state.filesPref,
    renderer: state.renderer,
    sync: state.sync,
    highlight: hl.on,
    mdOnly: state.mdOnly,
    theme,
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

// The on-screen keyboard. Chrome on Android shrinks the page for it (the viewport's
// interactive-widget), Safari only the part of it that is visible: there the page is fitted
// to the visual viewport (--vvh and --vvtop in app.css). Either way the caret is kept in
// sight, and while the keyboard is up, body.keyboard lets the narrow layout drop its masthead.
function initViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement.style;
  let width = 0;
  let tallest = 0;
  const fit = () => {
    if (vv.scale > 1.01) return; // zoomed in with two fingers: leave the layout alone
    if (innerWidth !== width) { // turned: the keyboard has another height now
      width = innerWidth;
      tallest = 0;
    }
    tallest = Math.max(tallest, vv.height);
    if (vv.height < innerHeight - 1) {
      root.setProperty('--vvh', `${Math.round(vv.height)}px`);
      root.setProperty('--vvtop', `${Math.round(vv.offsetTop)}px`);
    } else {
      root.removeProperty('--vvh');
      root.removeProperty('--vvtop');
    }
    const typing = !!document.activeElement?.matches('input, textarea, select');
    document.body.classList.toggle('keyboard', typing && vv.height < tallest * 0.75);
    requestAnimationFrame(keepCaretInView);
  };
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  addEventListener('focusout', () => setTimeout(fit, 100));
  fit();
}

/** Scroll the editor so that the caret is in sight, if it is not. */
function keepCaretInView() {
  const ta = src();
  if (document.activeElement !== ta) return;
  const pad = prepareMirror();
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  mirror.replaceChildren(document.createTextNode(ta.value.slice(0, ta.selectionEnd)), mark);
  const top = mark.offsetTop + pad;
  const bottom = top + mark.offsetHeight;
  mirror.replaceChildren();
  if (top < ta.scrollTop || bottom > ta.scrollTop + ta.clientHeight) {
    ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
  }
}

function initTheme() {
  $('theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    theme = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    savePrefs();
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
  initViewport();

  const prefs = store.get(K.prefs, {});
  state.renderer = prefs.renderer === 'github' ? 'github' : 'local';
  state.sync = prefs.sync !== false;
  $('renderer').value = state.renderer;
  $('syncScroll').checked = state.sync;
  hl.on = prefs.highlight !== false;
  $('highlight').checked = hl.on;
  state.mdOnly = prefs.mdOnly === true;
  $('mdOnly').setAttribute('aria-pressed', String(state.mdOnly));
  state.wideView = ['edit', 'split', 'preview'].includes(prefs.view) ? prefs.view : 'split';
  state.phoneView = prefs.phoneView === 'preview' ? 'preview' : 'edit';
  state.filesPref = prefs.files !== false;
  setView(phone.matches ? state.phoneView : state.wideView);
  setFilesVisible(state.filesPref && !narrow.matches);
  // a tablet turned, or a window resized across the breakpoints
  phone.addEventListener('change', () => setView(phone.matches ? state.phoneView : state.wideView));
  narrow.addEventListener('change', () => setFilesVisible(state.filesPref && !narrow.matches));

  // toolbar
  for (const b of document.querySelectorAll('[data-cmd]')) {
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
    b.addEventListener('click', () => command(b.dataset.cmd));
  }
  for (const b of document.querySelectorAll('button[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));
  $('toggleFiles').addEventListener('click', () => setFilesVisible($('workspace').classList.contains('nofiles')));
  $('scrim').addEventListener('click', closeDrawer);
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
  ta.addEventListener('input', () => { drafts.edit(); onTextChanged(); });
  ta.addEventListener('keydown', onKeyDown);
  ta.addEventListener('paste', onPaste);
  ta.addEventListener('dragover', onDragOver);
  ta.addEventListener('drop', onDrop);
  for (const ev of ['keyup', 'click', 'select']) ta.addEventListener(ev, updateStats);
  ta.addEventListener('scroll', () => {
    scrollHl();
    syncFrom('editor');
  }, { passive: true });
  new ResizeObserver(fitHl).observe(ta);
  $('highlight').addEventListener('change', (e) => {
    hl.on = e.target.checked;
    savePrefs();
    drawSource();
  });
  initFind();
  $('previewScroll').addEventListener('scroll', () => syncFrom('preview'), { passive: true });
  $('preview').addEventListener('click', onPreviewClick);
  // an image that loads (or is swapped in) or a <details> that opens moves the blocks below
  // it; neither event bubbles, so they are caught on the way down (#31)
  const moved = () => { previewBlocks = null; };
  $('preview').addEventListener('load', moved, true);
  $('preview').addEventListener('toggle', moved, true);
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
  $('mdOnly').addEventListener('click', () => {
    state.mdOnly = !state.mdOnly;
    $('mdOnly').setAttribute('aria-pressed', String(state.mdOnly));
    savePrefs();
    renderTree();
  });
  $('newFile').addEventListener('click', openNewDialog);
  $('refresh').addEventListener('click', async () => {
    if (!state.repo) return;
    const repo = state.repo;
    const ref = state.tree?.ref;
    let t;
    try {
      t = await busy('reading the file list', () => state.gh.tree(repo.owner, repo.name, ref));
    } catch {
      return; // busy said why
    }
    // the editor may have moved on to another repository or branch meanwhile (#31)
    if (state.repo !== repo || state.tree?.ref !== ref) return;
    state.tree = { ...t, ref };
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
  $('forkBranch').addEventListener('focus', () => { document.querySelector('input[name="target"][value="fork"]').checked = true; });

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
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) closeDrawer();
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'F3' && find.open && !mod && !e.altKey) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
      return;
    }
    // find and replace in the editor; elsewhere Ctrl+F stays the browser's own find
    const inEditor = e.target instanceof Element && e.target.closest('.editorpane');
    const findKey = inEditor && findShortcut(keyInfo(e), IS_MAC);
    if (findKey) {
      e.preventDefault();
      openFind(findKey === 'replace');
      return;
    }
    if (!commandHeld(e, IS_MAC) || e.altKey) return;
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
  // signing in or out in another tab (sessionStorage changes are not shared, so no event for them)
  auth.onchange = accountChanged;
  addEventListener('storage', (e) => { if (e.key === AUTH_KEY || e.key === null) auth.sync(); });
  addEventListener('hashchange', route);
  addEventListener('pagehide', saveDraftNow);
  addEventListener('beforeunload', (e) => {
    saveDraftNow();
    // edits storage refused (or held back by a conflicting draft) would be lost: ask first
    if (drafts.pending) e.preventDefault();
  });
  addEventListener('storage', onStorage);

  // tokens pasted before sign-in through GitHub existed
  const old = credStore.get(K.oldToken);
  if (old && !auth.creds) {
    try { credStore.remember = !!localStorage.getItem(K.oldToken); } catch { /* ignore */ }
    auth.usePat(old);
  }
  credStore.del(K.oldToken);

  // back from github.com, or signed in from before; then go wherever the address says
  await finishSignIn();
  if (auth.creds && !state.user) {
    try {
      await useCredentials();
    } catch (e) {
      if (!keepSignIn(e)) {
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
