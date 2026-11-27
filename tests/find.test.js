import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, findAll, matchFrom, matchBefore, expand, replaceOne, replaceAll, MAX_MATCHES,
  anchorAfter, findShortcut, findOptionKey, shortcutText, commandHeld,
} from '../src/find.js';

const spans = (text, r) => r.matches.map((m) => text.slice(m.start, m.end));

test('plain text: case, special characters, whole words', () => {
  const t = 'Cat cat CAT concatenate (cat) cat.';
  assert.deepEqual(spans(t, findAll(t, 'cat')), ['Cat', 'cat', 'CAT', 'cat', 'cat', 'cat']);
  assert.deepEqual(spans(t, findAll(t, 'cat', { caseSensitive: true })), ['cat', 'cat', 'cat', 'cat']);
  assert.equal(findAll(t, 'cat', { wholeWord: true }).matches.length, 5);
  assert.deepEqual(spans(t, findAll(t, '(cat)')), ['(cat)']);
  assert.deepEqual(spans(t, findAll(t, 'cat.')), ['cat.']);
  assert.deepEqual(findAll('a.b', '.', {}).matches, [{ start: 1, end: 2 }]);
  // whole words know non-ASCII letters
  assert.equal(findAll('čas časy', 'čas', { wholeWord: true }).matches.length, 1);
  assert.equal(findAll('xčas', 'čas', { wholeWord: true }).matches.length, 0);
  assert.deepEqual(findAll('abc', '').matches, []);
});

test('regular expressions, and invalid ones', () => {
  const t = 'a1 b22 c333';
  assert.deepEqual(spans(t, findAll(t, '\\d+', { regex: true })), ['1', '22', '333']);
  assert.deepEqual(spans(t, findAll(t, '^\\w', { regex: true })), ['a']);
  assert.deepEqual(spans('x\ny', findAll('x\ny', '^.$', { regex: true })), ['x', 'y']);
  const bad = findAll(t, '(a', { regex: true });
  assert.deepEqual(bad.matches, []);
  assert.match(bad.error, /group|parenthes/i);
  assert.equal(compile('[', { regex: true }).re, null);
  // valid only without the u flag: still accepted
  assert.deepEqual(spans('a-b', findAll('a-b', 'a\\-b', { regex: true })), ['a-b']);
});

test('empty matches neither loop nor skip', () => {
  const t = 'ab\n\ncd';
  const r = findAll(t, '^', { regex: true });
  assert.deepEqual(r.matches.map((m) => m.start), [0, 3, 4]);
  assert.deepEqual(findAll('aab', 'a*', { regex: true }).matches,
    [{ start: 0, end: 2 }, { start: 2, end: 2 }, { start: 3, end: 3 }]);
  // an astral character is not split in two
  assert.deepEqual(findAll('😀', '', { regex: true }).matches, []);
  assert.deepEqual(findAll('😀', '(?:)', { regex: true }).matches.map((m) => m.start), [0, 2]);
});

test('the number of matches is capped', () => {
  const r = findAll('a'.repeat(MAX_MATCHES + 5), 'a');
  assert.equal(r.matches.length, MAX_MATCHES);
  assert.equal(r.capped, true);
  assert.equal(findAll('aaa', 'a').capped, false);
});

test('next and previous match from a position, wrapping around', () => {
  const ms = [{ start: 2, end: 3 }, { start: 5, end: 6 }, { start: 9, end: 10 }];
  assert.equal(matchFrom(ms, 0), 0);
  assert.equal(matchFrom(ms, 2), 0);
  assert.equal(matchFrom(ms, 3), 1);
  assert.equal(matchFrom(ms, 10), 0);
  assert.equal(matchBefore(ms, 5), 0);
  assert.equal(matchBefore(ms, 6), 1);
  assert.equal(matchBefore(ms, 2), 2);
  assert.equal(matchBefore(ms, 100), 2);
  assert.equal(matchFrom([], 0), -1);
  assert.equal(matchBefore([], 0), -1);
});

test('replacement templates', () => {
  const m = /(\w+)@(?<host>\w+)/.exec('mail joe@example now');
  assert.equal(expand('$2 / $1', m), 'example / joe');
  assert.equal(expand('$<host>:$&', m), 'example:joe@example');
  assert.equal(expand('$$1 $0 $3', m), '$1 $0 $3');
  assert.equal(expand('$10', m), 'joe0');
  assert.equal(expand('[$`|$\']', m), '[mail | now]');
  assert.equal(expand('a\\nb\\tc\\\\d', m), 'a\nb\tc\\d');
});

test('replace one match', () => {
  const t = 'see [a](x) and [b](y)';
  const q = '\\[(\\w)\\]\\((\\w)\\)';
  const ms = findAll(t, q, { regex: true }).matches;
  const r = replaceOne(t, ms[1], q, '<$2|$1>', { regex: true });
  assert.equal(r.text, 'see [a](x) and <y|b>');
  assert.equal(r.text.slice(r.start, r.end), '<y|b>');
  // plain mode takes the replacement literally
  assert.equal(replaceOne('a.b', { start: 1, end: 2 }, '.', '$&', {}).text, 'a$&b');
  // the text changed under the match
  assert.equal(replaceOne('xxxx', { start: 0, end: 2 }, 'ab', 'c', { regex: true }), null);
  // lookbehind sees the text before the match
  const lb = findAll('xa ya', '(?<=y)a', { regex: true }).matches;
  assert.equal(replaceOne('xa ya', lb[0], '(?<=y)a', 'b', { regex: true }).text, 'xa yb');
});

test('replace all', () => {
  assert.deepEqual(replaceAll('a-a-A', 'a', 'b'), { text: 'b-b-b', count: 3, first: 0, error: '' });
  assert.equal(replaceAll('a-a-A', 'a', 'b', { caseSensitive: true }).text, 'b-b-A');
  assert.equal(replaceAll('x1 y2', '(\\w)(\\d)', '$2$1', { regex: true }).text, '1x 2y');
  assert.equal(replaceAll('one\ntwo', '^', '> ', { regex: true }).text, '> one\n> two');
  assert.equal(replaceAll('a b', ' ', '\\n', { regex: true }).text, 'a\nb');
  assert.equal(replaceAll('a b', ' ', '\\n').text, 'a\\nb');
  assert.equal(replaceAll('aab', 'a*', 'X', { regex: true }).text, 'aab'.replace(/a*/g, 'X'));
  assert.deepEqual(replaceAll('abc', 'z', 'y'), { text: 'abc', count: 0, first: -1, error: '' });
  assert.equal(replaceAll('abc', '(', 'y', { regex: true }).count, 0);
  assert.ok(replaceAll('abc', '(', 'y', { regex: true }).error);
  assert.equal(replaceAll('a cat concat', 'cat', 'dog', { wholeWord: true }).text, 'a dog concat');
});

test('replacing one match after another walks through them all, empty matches too', () => {
  // what the page does: replace the current match, then find again from the anchor
  const walk = (text, query, template, opts, presses) => {
    let { matches } = findAll(text, query, opts);
    let cur = 0;
    const seen = [];
    for (let k = 0; k < presses && matches.length; k++) {
      const m = matches[cur];
      seen.push(m.start);
      const r = replaceOne(text, m, query, template, opts);
      const anchor = anchorAfter(r, m);
      text = r.text;
      matches = findAll(text, query, opts).matches;
      cur = matchFrom(matches, anchor);
    }
    return { text, seen };
  };
  const re = { regex: true };
  // '^' replaced with nothing: on to the next line each time, then round again
  assert.deepEqual(walk('a\nb\nc', '^', '', re, 4), { text: 'a\nb\nc', seen: [0, 2, 4, 0] });
  assert.deepEqual(walk('ab', 'x*', '', re, 3).seen, [0, 1, 2]);
  // with something in its place, still on, not again before the same character
  assert.deepEqual(walk('ab', 'x*', '-', re, 2), { text: '-a-b', seen: [0, 2] });
  assert.deepEqual(walk('a\nb', '^', '> ', re, 2), { text: '> a\n> b', seen: [0, 4] });
  // a match that is not empty: from right after the replacement
  assert.deepEqual(walk('aaa', 'a', 'b', {}, 3), { text: 'bbb', seen: [0, 1, 2] });
  // not into the middle of a surrogate pair
  assert.equal(anchorAfter({ text: '😀x', start: 0, end: 0 }, { start: 0, end: 0 }), 2);
  // nor without the u flag (\\: is invalid with it): findAll leaves that place out as well
  assert.deepEqual(findAll('😀a', '\\:?', re).matches.map((m) => m.start), [0, 2, 3]);
  assert.deepEqual(walk('😀a', '\\:?', '', re, 3).seen, [0, 2, 3]);
  assert.equal(replaceAll('😀', '\\:?', '-', re).text, '-😀-');
});

test('find shortcuts: AltGr and Option characters are typed, not taken', () => {
  const k = (key, code, mods = {}) => ({
    key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods,
  });
  const ctrl = { ctrlKey: true };
  const cmd = { metaKey: true };
  // Windows and Linux
  assert.equal(findShortcut(k('f', 'KeyF', ctrl), false), 'find');
  assert.equal(findShortcut(k('F', 'KeyF', ctrl), false), 'find'); // Caps Lock
  assert.equal(findShortcut(k('h', 'KeyH', ctrl), false), 'replace');
  assert.equal(findShortcut(k('f', 'KeyF', { ctrlKey: true, altKey: true }), false), 'replace');
  assert.equal(findShortcut(k('f', 'KeyF', { ctrlKey: true, shiftKey: true }), false), null);
  assert.equal(findShortcut(k('f', 'KeyF'), false), null);
  assert.equal(findShortcut(k('f', 'KeyF', cmd), false), null);
  // Czech AltGr+F is '[' (Windows says Ctrl+Alt), and with AltGraph known
  assert.equal(findShortcut(k('[', 'KeyF', { ctrlKey: true, altKey: true }), false), null);
  assert.equal(findShortcut(k('f', 'KeyF', { ctrlKey: true, altKey: true, altGraph: true }), false), null);
  // a Dvorak Ctrl+F is where the letter is, not where KeyF is
  assert.equal(findShortcut(k('f', 'KeyY', ctrl), false), 'find');
  assert.equal(findShortcut(k('u', 'KeyF', ctrl), false), null);
  // macOS: ⌘F finds, ⌥⌘F replaces (Option makes the key 'ƒ'); Ctrl+H deletes backward
  assert.equal(findShortcut(k('f', 'KeyF', cmd), true), 'find');
  assert.equal(findShortcut(k('ƒ', 'KeyF', { metaKey: true, altKey: true }), true), 'replace');
  assert.equal(findShortcut(k('h', 'KeyH', ctrl), true), null);
  assert.equal(findShortcut(k('f', 'KeyF', ctrl), true), null);
  assert.equal(findShortcut(k('h', 'KeyH', cmd), true), null);
  // Dvorak ⌥⌘: Option gives 'ƒ' on the key printed F; the key at KeyF (U) is a dead key
  assert.equal(findShortcut(k('ƒ', 'KeyY', { metaKey: true, altKey: true }), true), 'replace');
  assert.equal(findShortcut(k('Dead', 'KeyF', { metaKey: true, altKey: true }), true), null);
  assert.equal(findShortcut(k('¨', 'KeyF', { metaKey: true, altKey: true }), true), null);
  // a layout without Latin letters (Russian): the place of the key, as on master
  assert.equal(findShortcut(k('а', 'KeyF', { ctrlKey: true, altKey: true }), false), 'replace');
  assert.equal(findShortcut(k('а', 'KeyF', ctrl), false), 'find');
  assert.equal(findShortcut(k('р', 'KeyH', ctrl), false), 'replace');
  assert.equal(findShortcut(k('α', 'KeyA', ctrl), false), null);
  // but a Latin letter AltGr makes is typed (Polish AltGr+A is 'ą', not Ctrl+Alt+F's place)
  assert.equal(findShortcut(k('ą', 'KeyF', { ctrlKey: true, altKey: true }), false), null);

  // the options in the find bar
  const alt = { altKey: true };
  assert.equal(findOptionKey(k('c', 'KeyC', alt), false), 'caseSensitive');
  assert.equal(findOptionKey(k('W', 'KeyW', { altKey: true, shiftKey: true }), false), 'wholeWord');
  assert.equal(findOptionKey(k('r', 'KeyR', alt), false), 'regex');
  assert.equal(findOptionKey(k('c', 'KeyC'), false), null);
  // Polish AltGr+C is 'ć', Windows or not
  assert.equal(findOptionKey(k('ć', 'KeyC', { ctrlKey: true, altKey: true }), false), null);
  assert.equal(findOptionKey(k('ć', 'KeyC', { altKey: true, altGraph: true }), false), null);
  // Russian, Greek: Alt+С where C is
  assert.equal(findOptionKey(k('с', 'KeyC', alt), false), 'caseSensitive');
  assert.equal(findOptionKey(k('ς', 'KeyW', alt), false), 'wholeWord');
  assert.equal(findOptionKey(k('к', 'KeyR', alt), false), 'regex');
  // macOS, Polish Pro: Option+C types 'ć'; ⌃⌥C toggles (and ⌥⌘C, if the browser lets it)
  assert.equal(findOptionKey(k('ć', 'KeyC', alt), true), null);
  assert.equal(findOptionKey(k('ç', 'KeyC', alt), true), null);
  assert.equal(findOptionKey(k('ç', 'KeyC', { altKey: true, ctrlKey: true }), true), 'caseSensitive');
  assert.equal(findOptionKey(k('c', 'KeyC', { altKey: true, ctrlKey: true }), true), 'caseSensitive');
  assert.equal(findOptionKey(k('ć', 'KeyC', { altKey: true, ctrlKey: true }), true), 'caseSensitive');
  assert.equal(findOptionKey(k('®', 'KeyR', { altKey: true, ctrlKey: true }), true), 'regex');
  assert.equal(findOptionKey(k('ç', 'KeyC', { altKey: true, ctrlKey: true, metaKey: true }), true), null);
  // Dvorak: by the letter, not by the place
  assert.equal(findOptionKey(k('∆', 'KeyC', { altKey: true, ctrlKey: true }), true), null);
  assert.equal(findOptionKey(k('ç', 'KeyI', { altKey: true, ctrlKey: true }), true), 'caseSensitive');
  assert.equal(findOptionKey(k('ç', 'KeyC', { altKey: true, metaKey: true }), true), 'caseSensitive');
  assert.equal(findOptionKey(k('∑', 'KeyW', { altKey: true, metaKey: true }), true), 'wholeWord');
  assert.equal(findOptionKey(k('c', 'KeyC', { altKey: true, metaKey: true }), false), null);
});

test('the command modifier is ⌘ on macOS, where Ctrl+letter belongs to the text field', () => {
  assert.equal(commandHeld({ key: 'e', ctrlKey: true }, false), true);
  assert.equal(commandHeld({ key: 'e', ctrlKey: true }, true), false); // ⌃E: end of line
  assert.equal(commandHeld({ key: 'o', ctrlKey: true }, true), false); // ⌃O: open a line
  assert.equal(commandHeld({ key: 'e', metaKey: true }, true), true);
  assert.equal(commandHeld({ key: 'e', metaKey: true }, false), false);
  assert.equal(commandHeld({ key: 'e', metaKey: true, ctrlKey: true }, true), false);
});

test('tooltips name the shortcuts of the platform', () => {
  const t = 'find and replace in the source (Ctrl+F, Ctrl+H)';
  assert.equal(shortcutText(t, false), t);
  assert.equal(shortcutText(t, true), 'find and replace in the source (⌘F, ⌥⌘F)');
  assert.equal(shortcutText('replace (Ctrl+H, Ctrl+Alt+F)', true), 'replace (⌥⌘F)');
  assert.equal(shortcutText('match case (Alt+C)', true), 'match case (⌃⌥C)');
  assert.equal(shortcutText('every match; Ctrl+Z undoes it (Ctrl+Enter)', true), 'every match; ⌘Z undoes it (⌘Enter)');
});
