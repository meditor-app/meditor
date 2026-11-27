import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, findAll, matchFrom, matchBefore, expand, replaceOne, replaceAll, MAX_MATCHES,
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
