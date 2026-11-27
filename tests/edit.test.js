import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrap, togglePrefix, orderedList, taskList, heading, link, table, indent, continueList, toggleTask, countWords,
} from '../src/edit.js';
import { lineDiff } from '../src/diff.js';

// "|" marks the cursor, "[...]" the selection.
const S = (s) => {
  const start = s.indexOf('[') >= 0 ? s.indexOf('[') : s.indexOf('|');
  const text = s.replace(/[[\]|]/g, '');
  const end = s.indexOf(']') >= 0 ? s.indexOf(']') - 1 : start;
  return { text, start, end };
};
const show = ({ text, start, end }) => (start === end
  ? text.slice(0, start) + '|' + text.slice(start)
  : text.slice(0, start) + '[' + text.slice(start, end) + ']' + text.slice(end));

test('wrap toggles markers around the selection', () => {
  assert.equal(show(wrap(S('a [word] b'), '**')), 'a **[word]** b');
  assert.equal(show(wrap(S('a **[word]** b'), '**')), 'a [word] b');
  assert.equal(show(wrap(S('a [**word**] b'), '**')), 'a [word] b');
  assert.equal(show(wrap(S('a [word ]b'), '_')), 'a _[word]_ b');
  assert.equal(show(wrap(S('a | b'), '**', '**', 'bold')), 'a **[bold]** b');
});

test('line prefixes, lists, headings', () => {
  assert.equal(show(togglePrefix(S('[a\nb]'), '- ')), '[- a\n- b]');
  assert.equal(show(togglePrefix(S('[- a\n- b]'), '- ')), '[a\nb]');
  assert.equal(show(togglePrefix(S('[1. a]'), '- ')), '[- a]');
  assert.equal(show(orderedList(S('[a\nb\nc]'))), '[1. a\n2. b\n3. c]');
  assert.equal(show(taskList(S('[- a]'))), '[- [ ] a]');
  assert.equal(show(heading(S('ti|tle'), 2)), '## ti|tle');
  assert.equal(show(heading(S('## ti|tle'), 2)), 'ti|tle');
  assert.equal(show(heading(S('# ti|tle'), 3)), '### ti|tle');
});

test('links select the URL to type over', () => {
  assert.equal(show(link(S('see [docs] now'))), 'see [docs]([url]) now'.replace('[docs]([url])', '[docs]([url])'));
  const r = link(S('see [docs] now'));
  assert.equal(r.text, 'see [docs](url) now');
  assert.equal(r.text.slice(r.start, r.end), 'url');
  const u = link(S('[https://x.org]'));
  assert.equal(u.text, '[text](https://x.org)'.replace('text', 'https://x.org'));
});

test('Tab indents list items, Shift-Tab outdents', () => {
  assert.equal(show(indent(S('- a|'))), '  - a|');
  assert.equal(show(indent(S('  - a|'), true)), '- a|');
  assert.equal(show(indent(S('word|'))), 'word  |');
});

test('Enter continues lists and quotes', () => {
  assert.equal(show(continueList(S('- a|'))), '- a\n- |');
  assert.equal(show(continueList(S('1. a|'))), '1. a\n2. |');
  const t = '  - [x] a';
  assert.equal(continueList({ text: t, start: t.length, end: t.length }).text, '  - [x] a\n  - [ ] ');
  assert.equal(show(continueList(S('- a\n- |'))), '- a\n|');
  assert.equal(show(continueList(S('> q|'))), '> q\n> |');
  assert.equal(continueList(S('plain|')), null);
});

test('task boxes tick in the source', () => {
  assert.equal(toggleTask('x\n- [ ] a\n- [x] b', 1), 'x\n- [x] a\n- [x] b');
  assert.equal(toggleTask('x\n- [ ] a\n- [x] b', 2), 'x\n- [ ] a\n- [ ] b');
  assert.equal(toggleTask('> 1. [ ] q', 0), '> 1. [x] q');
  assert.equal(toggleTask('no box', 0), 'no box');
});

test('word count skips code blocks', () => {
  assert.equal(countWords("It's two-words here\n```\nnot counted\n```\nčeský text"), 5);
});

// #30: formatting buttons, Enter and word count on lists, quotes, tables and words
const all = (text) => ({ text, start: 0, end: text.length });

test('list, numbered, task and quote buttons start one on an empty line', () => {
  assert.equal(show(togglePrefix(S('para\n|\nnext'), '- ')), 'para\n- |\nnext');
  assert.equal(show(togglePrefix(S('para\n|\nnext'), '> ')), 'para\n> |\nnext');
  assert.equal(show(orderedList(S('para\n|\nnext'))), 'para\n1. |\nnext');
  assert.equal(show(taskList(S('para\n|\nnext'))), 'para\n- [ ] |\nnext');
  assert.equal(show(togglePrefix(S('|'), '- ')), '- |');
  assert.equal(show(orderedList(S('|'))), '1. |');
  assert.equal(show(heading(S('para\n|\nnext'), 1)), 'para\n# |\nnext');
});

test('the quote button unquotes a quote with blank ">" lines, and quotes paragraphs as one', () => {
  assert.equal(togglePrefix(all('> a\n>\n> b'), '> ').text, 'a\n\nb');
  assert.equal(togglePrefix(all('a\n\nb'), '> ').text, '> a\n>\n> b');
  assert.equal(togglePrefix(all('> a\n>\n> b'), '> ').text, togglePrefix(all('> a\n>\n> b'), '> ').text);
  assert.equal(togglePrefix(all('\na\n'), '> ').text, '\n> a\n');
});

test('list buttons keep nested lists nested and quotes quoted', () => {
  assert.equal(orderedList(all('- a\n  - b\n- c')).text, '1. a\n   1. b\n2. c');
  assert.equal(orderedList(all('- a\n  - b\n  - c\n- d\n  - e')).text, '1. a\n   1. b\n   2. c\n2. d\n   1. e');
  assert.equal(taskList(all('- a\n  - b')).text, '- [ ] a\n  - [ ] b');
  assert.equal(togglePrefix(all('1. a\n   1. b'), '- ').text, '- a\n  - b');
  assert.equal(orderedList(all('> - a\n> - b')).text, '> 1. a\n> 2. b');
  assert.equal(togglePrefix(all('> 1. a\n>    1. b'), '- ').text, '> - a\n>   - b');
  assert.equal(orderedList(all('> 1. a\n> 2. b')).text, '> a\n> b');
  assert.equal(orderedList(all('- a\n\n  more\n- b')).text, '1. a\n\n   more\n2. b');
  assert.equal(orderedList(all('- [ ] a\n  - [ ] b\n- [x] c')).text, '1. a\n   1. b\n2. c');
});

test('a table inserted before text leaves a blank line after it', () => {
  const t = '| Column | Column |\n| ------ | ------ |\n| cell   | cell   |\n';
  assert.equal(table(S('abc|def')).text, `abc\n\n${t}\ndef`);
  assert.equal(table(S('para\n\n|foo')).text, `para\n\n${t}\nfoo`);
  assert.equal(table(S('para\n\n|')).text, `para\n\n${t}`);
  assert.equal(table(S('para\n\n|\nfoo')).text, `para\n\n${t}\nfoo`);
});

test('the bullet button turns a task list into bullets', () => {
  assert.equal(togglePrefix(all('- [ ] a\n- [ ] b'), '- ').text, '- a\n- b');
  assert.equal(togglePrefix(all('- a\n- b'), '- ').text, 'a\nb');
});

test('italic with "*" works inside a word and leaves bold alone', () => {
  assert.equal(show(wrap(S('un[beli]evable'), '*')), 'un*[beli]*evable');
  assert.equal(show(wrap(S('un*[beli]*evable'), '*')), 'un[beli]evable');
  assert.equal(show(wrap(S('a **[word]** b'), '*')), 'a ***[word]*** b');
  assert.equal(show(wrap(S('a ***[word]*** b'), '*')), 'a **[word]** b');
  assert.equal(show(wrap(S('a ***[word]*** b'), '**')), 'a *[word]* b');
  assert.equal(show(wrap(S('a [*word*] b'), '*')), 'a [word] b');
  assert.equal(show(wrap(S('a [**word**] b'), '*')), 'a *[**word**]* b');
  assert.equal(show(wrap(S('snake_[case]_name'), '*')), 'snake_*[case]*_name');
});

test('the heading button on several lines makes them all headings, or none', () => {
  assert.equal(heading(all('# a\nb'), 1).text, '# a\n# b');
  assert.equal(heading(all('# a\n# b'), 1).text, 'a\nb');
  assert.equal(heading(all('# a\n\n## b'), 1).text, '# a\n\n# b');
});

test('Enter after a thematic break does not start a list', () => {
  assert.equal(continueList(S('* * *|')), null);
  assert.equal(continueList(S('- - -|')), null);
  assert.equal(continueList(S('> * * *|')), null);
  assert.equal(show(continueList(S('* a|'))), '* a\n* |');
});

test('a task in a quote inside a list item ticks', () => {
  assert.equal(toggleTask('- > - [ ] x', 0), '- > - [x] x');
  assert.equal(toggleTask('1. > * [x] x', 0), '1. > * [ ] x');
  assert.equal(toggleTask('- [ ] a [ ] b', 0), '- [x] a [ ] b');
});

test('word count skips markup', () => {
  assert.equal(countWords('[docs](https://example.com/path/to/page.html)'), 1);
  assert.equal(countWords('![a cat](cat.png "A cat") sits'), 3);
  assert.equal(countWords('1. apple\n2. pear'), 2);
  assert.equal(countWords('> 1. apple'), 1);
  assert.equal(countWords('<details><summary>Hi</summary></details>'), 1);
  assert.equal(countWords('a <!-- hidden note --> b'), 2);
  assert.equal(countWords('~~~\nfoo bar baz\n~~~'), 0);
  assert.equal(countWords('````\n```\nx\n````\ny'), 1);
  assert.equal(countWords('---\ntitle: x y\n---\nhello'), 1);
  assert.equal(countWords('[r]: https://example.com/a/b\nword'), 1);
  assert.equal(countWords('2024 was 1 year'), 4);
});

test('line diff shows changes with context', () => {
  const d = lineDiff('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nD\ne\nf\ng', 1);
  assert.deepEqual(d, [
    { op: '…', line: '' }, { op: ' ', line: 'c' }, { op: '-', line: 'd' }, { op: '+', line: 'D' },
    { op: ' ', line: 'e' }, { op: '…', line: '' },
  ]);
  assert.deepEqual(lineDiff('x', 'x'), [{ op: '…', line: '' }]);
});
