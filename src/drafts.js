// Unsaved text kept in this browser so that it survives a reload or a closed tab: a draft
// per file (and branch), and the scratchpad. Pure apart from the store it is handed (local
// storage in the page, a Map in the tests); ui.js shows what it decides.
//
// Every tab of the site, and the installed app beside them, share that one storage, so a tab
// writes or deletes a draft only when the user changed the text in that tab since it was
// opened or last saved, and never deletes a draft newer than the one it opened or wrote:
// another tab wrote it. A draft made before the file changed on GitHub stays until the user
// restores it, discards it or commits. What storage refuses (it is full) is kept in memory,
// and the tab asks before it is closed for as long as anything is.

import { basename } from './links.js';
import { isMarkdown } from './filetypes.js';

/** @typedef {{text: string, sha?: string|null, at?: number}} Draft */
/** @typedef {{get(k: string): any, set(k: string, v: any): boolean, del(k: string): void}} Store */

/** What a new file starts with: a heading made of its name if it is Markdown, else nothing. */
export function newFileText(path) {
  if (!isMarkdown(path)) return '';
  const title = basename(path).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  return `# ${title.charAt(0).toUpperCase()}${title.slice(1)}\n\n`;
}

/**
 * Opening a file (`base` and `sha` as on GitHub; `sha` null for a new file): the text to show,
 * and whether it is a draft restored ('restored') or one made before the file changed on
 * GitHub ('conflict', the file's text shown). `drop`: the draft says nothing (it is the
 * file's text, or the heading a new file starts with, left by older versions) and can go.
 */
export function draftOnOpen(draft, { base, sha, isNew }, template = '') {
  if (draft && draft.text !== base && !(isNew && draft.text === template)) {
    return draft.sha === sha ? { text: draft.text, kind: 'restored', drop: false } : { text: base, kind: 'conflict', drop: false };
  }
  return { text: isNew ? template : base, kind: null, drop: !!draft };
}

/**
 * What saving does to the stored draft: 'set' it to the text, 'del' it, or 'keep' it.
 * `base` is null for the scratchpad (always kept), `seen` when the draft this tab opened or
 * last wrote was written, `conflict` while a draft made before the file changed on GitHub
 * waits for the user.
 */
export function draftAction({ stored, text, base, edited, conflict, seen }) {
  if (!edited) return 'keep'; // nothing changed here: what is stored is as fresh, or another tab's
  if (conflict) return 'keep';
  if (base === null || text !== base) return 'set';
  return stored && (stored.at || 0) > seen ? 'keep' : 'del';
}

/** A stored value as a draft: the scratchpad was a bare string before drafts had a time. */
const asDraft = (v) => (typeof v === 'string' ? { text: v, at: 0 } : v && typeof v.text === 'string' ? v : null);

/** The drafts as one tab sees them: the open document's, and what it has not managed to store. */
export class Drafts {
  /** @param {Store} store */
  constructor(store, now = () => Date.now()) {
    this.store = store;
    this.now = now;
    // key -> draft that storage refused, or held back by a conflict; `older`: the draft it
    // waits on, when that one is only here too
    this.memory = new Map();
    this.key = null;
    this.base = null;
    this.sha = null;
    this.edited = false; // the user changed the text since it was opened or last saved
    this.conflict = false;
    this.seen = 0;
  }

  #open(key, base, sha, stored) {
    this.key = key;
    this.base = base;
    this.sha = sha;
    this.edited = false;
    this.conflict = false;
    this.seen = stored?.at || 0;
  }

  /** Opens the scratchpad kept under `key`; returns its text. */
  openScratch(key, welcome) {
    const stored = asDraft(this.store.get(key));
    this.#open(key, null, null, stored);
    const mem = this.memory.get(key);
    if (mem) {
      this.edited = true;
      return mem.text;
    }
    return stored ? stored.text : welcome;
  }

  /**
   * Opens a file; returns what draftOnOpen says, the stored draft (`draft`), and `unsaved`
   * when the text shown is one this tab could not store before.
   */
  openFile(key, doc, template = '') {
    const stored = asDraft(this.store.get(key));
    const mem = this.memory.get(key);
    // what this tab could not store is newer than what is stored; made before the file
    // changed on GitHub, it is offered as a stored one would be
    const older = mem && (mem.sha !== doc.sha ? mem : mem.older);
    const draft = older ? { text: older.text, sha: older.sha, at: older.at } : stored;
    const r = draftOnOpen(draft, doc, template);
    if (r.drop && !older) this.store.del(key);
    else if (r.drop && older === mem) this.memory.delete(key);
    else if (r.drop) delete mem.older;
    this.#open(key, doc.base, doc.sha, stored);
    this.conflict = r.kind === 'conflict';
    if (mem && mem.sha === doc.sha) {
      this.edited = true;
      return { ...r, text: mem.text, kind: this.conflict ? 'conflict' : null, draft, unsaved: true };
    }
    return { ...r, draft, unsaved: !!older && !r.drop };
  }

  /** The user changed the text. */
  edit() { this.edited = true; }

  /** Saves the text if this tab changed it. `ok` is false when storage refused it. */
  save(text) {
    if (!this.key) return { action: 'keep', ok: true };
    const stored = asDraft(this.store.get(this.key));
    const action = draftAction({ stored, text, base: this.base, edited: this.edited, conflict: this.conflict, seen: this.seen });
    const draft = this.base === null ? { text, at: this.now() } : { text, sha: this.sha, at: this.now() };
    if (action === 'set') {
      if (this.store.set(this.key, draft) === false) {
        this.memory.set(this.key, draft);
        return { action, ok: false };
      }
      this.seen = draft.at;
    } else if (action === 'del') {
      this.store.del(this.key);
    } else {
      // held back by a conflict: the edits stay in this tab, and in memory if it opens another
      // (with the draft they wait on, if that is only in memory)
      if (!this.edited) return { action, ok: true };
      const mem = this.memory.get(this.key);
      const older = mem && (mem.sha !== this.sha ? mem : mem.older);
      this.memory.set(this.key, older ? { ...draft, older: { text: older.text, sha: older.sha, at: older.at } } : draft);
      return { action, ok: false };
    }
    this.memory.delete(this.key);
    this.edited = false;
    return { action, ok: true };
  }

  /** Edits this tab has not stored, of any document (to ask before the page is left). */
  get pending() { return this.edited || this.memory.size > 0; }

  /**
   * Why text is only in this tab: 'held' (the open document's edits wait on an older draft),
   * 'full' (storage refused it), 'other' (another document's), or null.
   */
  get unstored() {
    const mine = this.memory.get(this.key);
    if (mine) return this.conflict && mine.sha === this.sha ? 'held' : 'full';
    return this.memory.size ? 'other' : null;
  }

  /** The user restored the draft made before the file changed on GitHub (and edits it now). */
  resolve() {
    this.conflict = false;
    delete this.memory.get(this.key)?.older;
  }

  /** The user discarded the draft. */
  discard() {
    if (!this.key) return;
    this.store.del(this.key);
    this.memory.delete(this.key);
    this.conflict = false;
    this.edited = false;
  }

  /** The file's latest version became the base; the draft must name it, so it is saved again. */
  rebase(base, sha) {
    this.base = base;
    this.sha = sha;
    this.edited = true;
  }

  /** The text under `key` was committed as `sha`: its draft goes, unless another tab wrote a newer one. */
  committed(key, base, sha) {
    const stored = asDraft(this.store.get(key));
    if (key !== this.key || !stored || (stored.at || 0) <= this.seen) this.store.del(key);
    this.memory.delete(key);
    if (key !== this.key) return;
    this.base = base;
    this.sha = sha;
    this.conflict = false;
    this.edited = false;
  }

  /** The open document is now kept under `key` (it was moved, or committed to a fork). */
  rename(key) {
    const mem = this.memory.get(this.key);
    if (mem) {
      this.memory.delete(this.key);
      this.memory.set(key, mem);
    }
    this.key = key;
  }

  /**
   * Another tab stored `value` under `key` (a 'storage' event): the draft to offer when it is
   * the open document's, newer than this tab's and not what it shows already; else null.
   * `stale`: it was made on another version of the file than this tab has (before it changed
   * on GitHub, or after), so taking it, then committing, would undo that change.
   */
  incoming(key, value, text) {
    const d = asDraft(value);
    if (key !== this.key || !d || (d.at || 0) <= this.seen || d.text === text) return null;
    return { ...d, stale: this.base !== null && (d.sha ?? null) !== this.sha };
  }

  /** This tab now shows the other tab's draft `d`, as stored. */
  take(d) {
    this.seen = d.at || 0;
    this.edited = false;
    this.conflict = false;
    this.memory.delete(this.key);
  }

  /** The user keeps this tab's text over the other tab's draft `d`: it is saved over it. */
  keepMine(d) {
    this.seen = d.at || 0;
    this.edited = true;
    this.conflict = false;
  }
}
