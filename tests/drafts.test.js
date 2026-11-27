import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Drafts, draftAction, draftOnOpen, newFileText } from '../src/drafts.js';

// local storage as the tabs of one browser share it; `full` makes it refuse writes
function storage() {
  const m = new Map();
  return {
    m,
    full: false,
    get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    set(k, v) {
      if (this.full) return false;
      m.set(k, JSON.stringify(v));
      return true;
    },
    del(k) { m.delete(k); },
  };
}
let clock = 1000;
const now = () => ++clock;

// a tab: the drafts and the editor's text, as ui.js drives them
function tab(store) {
  const d = new Drafts(store, now);
  const t = {
    d,
    text: '',
    scratch() { t.text = d.openScratch('scratch', 'WELCOME'); return t; },
    open(key, doc, template) { const r = d.openFile(key, doc, template); t.text = r.text; return r; },
    type(s) { t.text = s; d.edit(); return d.save(t.text); },
    close() { return d.save(t.text); },
  };
  return t;
}

const X = 'meditor:draft:o/r@main:X.md';
const fileX = { base: 'base\n', sha: 's1', isNew: false };

test('a tab that never edited the scratchpad leaves what another tab saved', () => {
  const s = storage();
  const a = tab(s).scratch();
  const b = tab(s).scratch();
  a.type('important notes');
  a.close();
  b.close();
  assert.equal(tab(s).scratch().text, 'important notes');
});

test('a tab that never edited a file does not delete another tab\'s draft of it', () => {
  const s = storage();
  const a = tab(s);
  const b = tab(s);
  a.open(X, fileX);
  b.open(X, fileX);
  a.type('mine\n');
  a.close();
  b.close(); // or opens another file, which saves first
  assert.equal(s.get(X).text, 'mine\n');
  const c = tab(s).open(X, fileX);
  assert.equal(c.kind, 'restored');
  assert.equal(c.text, 'mine\n');
});

test('a tab that edits back to the file\'s text keeps a newer draft from another tab', () => {
  const s = storage();
  const a = tab(s);
  const b = tab(s);
  a.open(X, fileX);
  b.open(X, fileX);
  b.type('x');
  a.type('mine\n');
  b.type('base\n'); // undone in b: back to the file's text, but a's draft is newer
  b.close();
  assert.equal(s.get(X).text, 'mine\n');
  // what b itself wrote, it may delete
  const c = tab(s);
  c.open(X, fileX);
  c.type('base\n');
  assert.equal(s.get(X), null);
});

test('another tab\'s draft of the open document is offered, then taken or overridden', () => {
  const s = storage();
  const a = tab(s);
  const b = tab(s);
  a.open(X, fileX);
  b.open(X, fileX);
  a.type('from a\n');
  const offer = b.d.incoming(X, s.get(X), b.text);
  assert.equal(offer.text, 'from a\n');
  assert.equal(b.d.incoming('meditor:draft:o/r@main:Y.md', s.get(X), b.text), null);
  assert.equal(a.d.incoming(X, s.get(X), a.text), null); // its own write
  b.d.take(offer);
  b.text = offer.text;
  b.close();
  assert.equal(s.get(X).text, 'from a\n');
  b.d.keepMine(offer);
  b.text = 'base\n';
  b.close(); // the user chose b's text, the file's own: the draft goes
  assert.equal(s.get(X), null);
});

test('a draft that conflicts with GitHub stays until it is restored or discarded', () => {
  const s = storage();
  s.set(X, { text: 'my edit\n', sha: 's1', at: 1 });
  const changed = { base: 'theirs\n', sha: 's2', isNew: false };
  const a = tab(s);
  const r = a.open(X, changed);
  assert.equal(r.kind, 'conflict');
  assert.equal(r.text, 'theirs\n');
  assert.equal(r.draft.text, 'my edit\n');
  a.close(); // the timer 0.4 s after opening, a reload, another file
  assert.equal(s.get(X).text, 'my edit\n');
  assert.equal(tab(s).open(X, changed).kind, 'conflict');
  // edits while it waits are not stored over it, but kept by the tab and reported
  const res = a.type('theirs, edited\n');
  assert.deepEqual(res, { action: 'keep', ok: false });
  assert.equal(a.d.pending, true);
  assert.equal(s.get(X).text, 'my edit\n');
  const again = a.open(X, changed); // away and back, in the same tab
  assert.equal(again.text, 'theirs, edited\n');
  assert.equal(again.kind, 'conflict');
  // restore my version
  a.d.resolve();
  a.type(r.draft.text);
  assert.deepEqual({ ...s.get(X), at: 0 }, { text: 'my edit\n', sha: 's2', at: 0 });
  assert.equal(tab(s).open(X, changed).kind, 'restored');
  // discard it
  s.set(X, { text: 'my edit\n', sha: 's1', at: 1 });
  const b = tab(s);
  b.open(X, changed);
  b.d.discard();
  b.type('theirs\n');
  assert.equal(s.get(X), null);
});

test('the decision itself', () => {
  const stored = { text: 'old', sha: 's1', at: 5 };
  // the issue's case: a conflicting draft, the text still the file's
  assert.equal(draftAction({ stored, text: 'b', base: 'b', edited: true, conflict: true, seen: 5 }), 'keep');
  assert.equal(draftAction({ stored, text: 'b', base: 'b', edited: false, conflict: false, seen: 5 }), 'keep');
  assert.equal(draftAction({ stored, text: 'b', base: 'b', edited: true, conflict: false, seen: 5 }), 'del');
  assert.equal(draftAction({ stored, text: 'b', base: 'b', edited: true, conflict: false, seen: 4 }), 'keep');
  assert.equal(draftAction({ stored, text: 'c', base: 'b', edited: true, conflict: false, seen: 4 }), 'set');
  assert.equal(draftAction({ stored: null, text: 'b', base: null, edited: true, conflict: false, seen: 0 }), 'set');
  // a draft equal to the file's text is dropped, one with the file's sha restored
  assert.deepEqual(draftOnOpen({ text: 'b', sha: 's1' }, { base: 'b', sha: 's1' }), { text: 'b', kind: null, drop: true });
  assert.deepEqual(draftOnOpen({ text: 'c', sha: 's1' }, { base: 'b', sha: 's1' }), { text: 'c', kind: 'restored', drop: false });
  assert.deepEqual(draftOnOpen({ text: 'c', sha: 's1' }, { base: 'b', sha: 's2' }), { text: 'b', kind: 'conflict', drop: false });
  assert.deepEqual(draftOnOpen(null, { base: 'b', sha: 's1' }), { text: 'b', kind: null, drop: false });
});

test('opening a path that does not exist stores nothing until the user types', () => {
  const s = storage();
  const key = 'meditor:draft:o/r@gh-pages:README.md';
  const doc = { base: '', sha: null, isNew: true };
  const tpl = newFileText('README.md');
  assert.equal(tpl, '# README\n\n');
  assert.equal(newFileText('docs/how-to_use.markdown'), '# How to use\n\n');
  const a = tab(s);
  const r = a.open(key, doc, tpl);
  assert.equal(r.text, '# README\n\n');
  assert.equal(r.kind, null);
  a.close();
  assert.equal(s.get(key), null);
  // a phantom left by older versions goes too
  s.set(key, { text: '# README\n\n', sha: null, at: 1 });
  assert.equal(tab(s).open(key, doc, tpl).kind, null);
  assert.equal(s.get(key), null);
  // typed: kept
  a.type('# README\n\nhello\n');
  assert.equal(s.get(key).text, '# README\n\nhello\n');
  assert.equal(tab(s).open(key, doc, tpl).kind, 'restored');
});

test('when storage is full the text is reported unsaved and kept in memory', () => {
  const s = storage();
  const a = tab(s);
  a.open(X, fileX);
  s.full = true;
  assert.deepEqual(a.type('big edit\n'), { action: 'set', ok: false });
  assert.equal(a.d.pending, true); // ui.js asks before the page is left
  a.open('meditor:draft:o/r@main:Y.md', { base: 'y', sha: 'sy', isNew: false });
  const back = a.open(X, fileX);
  assert.equal(back.text, 'big edit\n');
  assert.equal(back.unsaved, true);
  assert.equal(a.d.pending, true);
  s.full = false;
  assert.deepEqual(a.close(), { action: 'set', ok: true });
  assert.equal(a.d.pending, false);
  assert.equal(s.get(X).text, 'big edit\n');
  // the scratchpad too
  s.full = true;
  a.scratch();
  assert.equal(a.type('notes').ok, false);
  assert.equal(a.scratch().text, 'notes');
});

test('the scratchpad stored as a bare string by earlier versions still opens', () => {
  const s = storage();
  s.m.set('scratch', JSON.stringify('old notes'));
  assert.equal(tab(s).scratch().text, 'old notes');
  assert.equal(tab(storage()).scratch().text, 'WELCOME');
});

test('commit, move and a newer base', () => {
  const s = storage();
  const a = tab(s);
  a.open(X, fileX);
  a.type('changed\n');
  a.d.committed(X, 'changed\n', 's2');
  assert.equal(s.get(X), null);
  assert.equal(a.close().action, 'keep');
  a.type('more\n');
  assert.equal(s.get(X).sha, 's2');
  const Z = 'meditor:draft:o/r@main:Z.md';
  s.set(Z, s.get(X)); // ui.js moves the stored draft
  s.del(X);
  a.d.rename(Z);
  a.type('more, moved\n');
  assert.equal(s.get(Z).text, 'more, moved\n');
  assert.equal(s.get(X), null);
  a.d.rebase('newer\n', 's3');
  a.close();
  assert.equal(s.get(Z).sha, 's3');
});

test('text only in memory keeps the tab asking after another document is opened', () => {
  const s = storage();
  const Y = 'meditor:draft:o/r@main:Y.md';
  const fileY = { base: 'y', sha: 'sy', isNew: false };
  const a = tab(s);
  a.open(X, fileX);
  s.full = true;
  a.type('big edit\n');
  assert.equal(a.d.unstored, 'full');
  a.open(Y, fileY);
  assert.equal(a.d.pending, true); // ui.js asks before the page is left
  assert.equal(a.d.unstored, 'other'); // and keeps the warning up
  a.scratch();
  assert.equal(a.d.pending, true);
  // edits held back by a conflict, then another document
  const s2 = storage();
  s2.set(X, { text: 'my edit\n', sha: 's0', at: 1 });
  const b = tab(s2);
  b.open(X, fileX);
  b.type('base, edited\n');
  assert.equal(b.d.unstored, 'held');
  b.open(Y, fileY);
  assert.equal(b.d.pending, true);
  assert.equal(b.d.unstored, 'other');
  // stored at last: nothing is pending
  s.full = false;
  a.open(X, fileX);
  a.close();
  assert.equal(a.d.pending, false);
  assert.equal(a.d.unstored, null);
});

test('text only in memory, made before the file changed on GitHub, is offered as a conflict', () => {
  const s = storage();
  const a = tab(s);
  const c1 = { base: 'c', sha: 'c1', isNew: false };
  const c2 = { base: 'c2', sha: 'c2', isNew: false };
  a.open(X, c1);
  s.full = true;
  a.type('c work');
  s.full = false;
  a.open('meditor:draft:o/r@main:Y.md', { base: 'y', sha: 'sy', isNew: false });
  const r = a.open(X, c2);
  assert.equal(r.kind, 'conflict');
  assert.equal(r.text, 'c2');
  assert.equal(r.draft.text, 'c work');
  assert.equal(r.unsaved, true);
  assert.equal(a.d.unstored, 'full');
  // edits while it waits do not replace it
  a.type('c2, edited');
  a.open('meditor:draft:o/r@main:Y.md', { base: 'y', sha: 'sy', isNew: false });
  const back = a.open(X, c2);
  assert.equal(back.kind, 'conflict');
  assert.equal(back.text, 'c2, edited');
  assert.equal(back.draft.text, 'c work');
  // restore my version: stored, with the file's sha now
  a.d.resolve();
  a.type(back.draft.text);
  assert.equal(s.get(X).text, 'c work');
  assert.equal(s.get(X).sha, 'c2');
  assert.equal(a.d.pending, false);
});

test('committing in one tab leaves a newer draft another tab wrote', () => {
  const s = storage();
  const a = tab(s);
  const b = tab(s);
  a.open(X, fileX);
  b.open(X, fileX);
  a.type('A work\n');
  b.type('B work\n');
  a.d.committed(X, 'A work\n', 's2');
  assert.equal(s.get(X).text, 'B work\n');
  assert.equal(tab(s).open(X, { base: 'A work\n', sha: 's2', isNew: false }).kind, 'conflict');
  // its own draft goes
  a.type('A more\n');
  a.d.committed(X, 'A more\n', 's3');
  assert.equal(s.get(X), null);
});

test('another tab\'s draft made on another version of the file is offered as such', () => {
  const s = storage();
  const a = tab(s);
  const b = tab(s);
  a.open(X, { base: 'old', sha: 's1', isNew: false });
  b.open(X, { base: 'new', sha: 's2', isNew: false });
  const c = tab(s);
  c.open(X, { base: 'old', sha: 's1', isNew: false });
  a.type('old + A edits');
  assert.equal(b.d.incoming(X, s.get(X), b.text).stale, true);
  assert.equal(c.d.incoming(X, s.get(X), c.text).stale, false);
  const d = tab(s).scratch();
  tab(s).scratch().type('notes');
  assert.equal(d.d.incoming('scratch', s.get('scratch'), d.text).stale, false);
});
