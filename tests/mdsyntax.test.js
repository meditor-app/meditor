import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenizeLine, tokenizeAll, retokenize, START, stateKey, rangesByLine, lineHtml, LONG_LINE,
} from '../src/mdsyntax.js';

// The tokens of each line of `text`, as "class:text" strings.
function tok(text) {
  const lines = text.split('\n');
  let st = START;
  return lines.map((l, i) => {
    const r = tokenizeLine(l, st, lines[i + 1]);
    st = r.state;
    for (let k = 1; k < r.tokens.length; k++) assert.ok(r.tokens[k][0] >= r.tokens[k - 1][1], `overlap in ${l}`);
    return r.tokens.map(([a, b, c]) => `${c}:${l.slice(a, b)}`);
  });
}
const one = (line) => tok(line)[0];

test('headings, ATX and setext', () => {
  assert.deepEqual(one('## Title'), ['hd mk:##', 'hd: Title']);
  assert.deepEqual(one('# A #'), ['hd mk:#', 'hd: A', 'hd mk: #']);
  assert.deepEqual(one('#hashtag'), []);
  assert.deepEqual(tok('Title\n====='), [['hd:Title'], ['hd mk:=====']]);
  assert.deepEqual(tok('Title\n---'), [['hd:Title'], ['hd mk:---']]);
  // after a blank line, --- is a rule
  assert.deepEqual(tok('text\n\n---')[2], ['mk:---']);
  assert.deepEqual(tok('- item\n---')[1], ['mk:---']);
});

test('emphasis, strong, strikethrough, escapes', () => {
  assert.deepEqual(one('a *b* c'), ['mk:*', 'em:b', 'mk:*']);
  assert.deepEqual(one('**bold _both_**'), ['mk:**', 'strong:bold ', 'strong mk:_', 'strong em:both', 'strong mk:_', 'mk:**']);
  assert.deepEqual(one('***x***'), ['mk:***', 'strong em:x', 'mk:***']);
  assert.deepEqual(one('~~gone~~'), ['mk:~~', 'del:gone', 'mk:~~']);
  assert.deepEqual(one('snake_case_name'), []);
  assert.deepEqual(one('2 * 3 * 4'), []);
  assert.deepEqual(one('\\*not\\*'), ['mk:\\*', 'mk:\\*']);
  assert.deepEqual(one('*a `*` b*'), ['mk:*', 'em:a ', 'em code:`*`', 'em: b', 'mk:*']);
});

test('code spans and fenced blocks', () => {
  assert.deepEqual(one('use `x` or ``a ` b``'), ['code:`x`', 'code:``a ` b``']);
  assert.deepEqual(one('unclosed `x'), []);
  assert.deepEqual(tok('```js\nlet *a* = 1\n```\n*b*'), [
    ['fence:```js'], ['code:let *a* = 1'], ['fence:```'], ['mk:*', 'em:b', 'mk:*']]);
  // a shorter fence does not close a longer one; a tilde one does not close backticks
  assert.deepEqual(tok('````\n```\n~~~~\n````').map((l) => l[0]), ['fence:````', 'code:```', 'code:~~~~', 'fence:````']);
  // a fence in a quote ends with the quote
  assert.deepEqual(tok('> ```\n> x\n\n*y*'), [['qt:> ', 'fence:```'], ['qt:> ', 'code:x'], [], ['mk:*', 'em:y', 'mk:*']]);
  // indented in a list item
  assert.deepEqual(tok('- a\n  ```\n  b\n  ```').map((l) => l.at(-1)), ['li:-', 'fence:  ```', 'code:  b', 'fence:  ```']);
});

test('a fence indented 4 columns or more is one only in a list item', () => {
  // an indented code block at the top level, or a paragraph carrying on
  assert.deepEqual(tok('a\n\n    ```\nb'), [[], [], [], []]);
  assert.deepEqual(tok('a\n    ```\n*b*')[2], ['mk:*', 'em:b', 'mk:*']);
  assert.deepEqual(tok('\t```\n*b*')[1], ['mk:*', 'em:b', 'mk:*']);
  assert.deepEqual(tok('   ```\nb\n   ```\nc'), [['fence:   ```'], ['code:b'], ['fence:   ```'], []]);
  // as GitHub renders it: the fence belongs to the item
  assert.deepEqual(tok('- item\n\n    ```js\n    x\n    ```\n*y*'),
    [['li:-'], [], ['fence:    ```js'], ['code:    x'], ['fence:    ```'], ['mk:*', 'em:y', 'mk:*']]);
  assert.deepEqual(tok('1. a\n   lazy\n\n      ```\n      x')[4], ['code:      x']);
  // inside a top-level block, an indented fence does not close it
  assert.deepEqual(tok('```\n    ```\nb\n```'), [['fence:```'], ['code:    ```'], ['code:b'], ['fence:```']]);
  // a line at the margin after a blank line ends the list
  assert.deepEqual(tok('- a\n\nb\n\n    ```\nc')[5], []);
  // so does one indented less than the item's content (3 columns after '1. ')
  assert.deepEqual(tok('1. a\n\n  b\n\n    ```\n*c*')[5], ['mk:*', 'em:c', 'mk:*']);
  // 4 columns past the item's content are an indented code block in it
  assert.deepEqual(tok('- a\n\n      ```\n*b*').slice(2), [[], ['mk:*', 'em:b', 'mk:*']]);
  assert.deepEqual(tok('-     a\n\n      ```\n*b*').slice(2), [[], ['mk:*', 'em:b', 'mk:*']]);
  // nested items: the inner one's content, or after a blank line the outer one's
  assert.deepEqual(tok('- a\n  - b\n\n      ```\n      x\n      ```\n*c*').slice(3).map((l) => l.at(-1)),
    ['fence:      ```', 'code:      x', 'fence:      ```', 'mk:*']);
  assert.deepEqual(tok('- a\n  - b\n\n    ```\n    x\n    ```\n*c*').slice(3).map((l) => l.at(-1)),
    ['fence:    ```', 'code:    x', 'fence:    ```', 'mk:*']);
  // a list in a quote ends with the quote, and a lazy line carries on its paragraph
  assert.deepEqual(tok('> - a\n\n    ```\n*b*').slice(2), [[], ['mk:*', 'em:b', 'mk:*']]);
  assert.deepEqual(tok('> - a\n    ```\n*b*').slice(1), [[], ['mk:*', 'em:b', 'mk:*']]);
  // but holds on in it, over a quoted blank line
  assert.deepEqual(tok('> - a\n>\n>     ```\n>     x\n>     ```\n*c*').slice(2).map((l) => l.at(-1)),
    ['fence:    ```', 'code:    x', 'fence:    ```', 'mk:*']);
  // a fence at the margin under an item is no part of it, and opens all the same
  assert.deepEqual(tok('- a\n```\nx\n```\n*c*').slice(1).map((l) => l.at(-1)), ['fence:```', 'code:x', 'fence:```', 'mk:*']);
});

test('a quote marker alone is a blank line in the quote', () => {
  // no setext heading under it, as GitHub has it
  assert.deepEqual(tok('>\n> ---')[1], ['qt:> ', 'mk:---']);
});

test('links, images, autolinks, definitions', () => {
  assert.deepEqual(one('[a *b*](u "t")'), ['ln mk:[', 'ln:a ', 'ln mk:*', 'ln em:b', 'ln mk:*', 'ln mk:](', 'url:u "t"', 'ln mk:)']);
  assert.deepEqual(one('![alt](i.png)'), ['ln mk:![', 'ln:alt', 'ln mk:](', 'url:i.png', 'ln mk:)']);
  assert.deepEqual(one('[x][ref]'), ['ln mk:[', 'ln:x', 'ln mk:][', 'ln:ref', 'ln mk:]']);
  assert.deepEqual(one('[a [b]](c(d))'), ['ln mk:[', 'ln:a [b]', 'ln mk:](', 'url:c(d)', 'ln mk:)']);
  assert.deepEqual(one('just [brackets]'), []);
  assert.deepEqual(one('<https://x.org> and https://y.org/a.'), ['url:<https://x.org>', 'url:https://y.org/a']);
  assert.deepEqual(one('[id]: https://x.org "T"'), ['ln:[id]:', 'url:https://x.org']);
});

test('lists, tasks, quotes, tables', () => {
  assert.deepEqual(one('- [x] done'), ['li:-', 'tk:[x]']);
  assert.deepEqual(one('  12. twelve'), ['li:12.']);
  assert.deepEqual(one('> > deep *q*'), ['qt:> > ', 'mk:*', 'em:q', 'mk:*']);
  assert.deepEqual(one('> # quoted heading'), ['qt:> ', 'hd mk:#', 'hd: quoted heading']);
  assert.deepEqual(tok('| a | b |\n| --- | :-: |')[1], ['mk:| --- | :-: |']);
});

test('HTML, comments over several lines, front matter', () => {
  assert.deepEqual(one('a <span class="x">b</span>'), ['html:<span class="x">', 'html:</span>']);
  assert.deepEqual(one('1 < 2 > 0'), []);
  assert.deepEqual(tok('x <!-- a\nb *c*\n--> *d*'), [['html:<!-- a'], ['html:b *c*'], ['html:-->', 'mk:*', 'em:d', 'mk:*']]);
  assert.deepEqual(tok('---\ntitle: *x*\n---\n# H'), [['fm mk:---'], ['fm:title: *x*'], ['fm mk:---'], ['hd mk:#', 'hd: H']]);
  // only on the first line
  assert.deepEqual(tok('x\n\n---\ny: z')[3], []);
});

test('very long lines stay plain, except in code blocks', () => {
  const long = '*a* '.repeat(LONG_LINE);
  assert.deepEqual(tokenizeLine(long).tokens, []);
  assert.deepEqual(tok('```\n' + long)[1], [`code:${long}`]);
  assert.equal(tokenizeLine('*a* '.repeat(10)).tokens.length, 30);
});

test('the state after a line tells whether the next lines change', () => {
  const after = (text) => text.split('\n').reduce((st, l) => tokenizeLine(l, st).state, START);
  assert.equal(stateKey(after('a\nb')), stateKey(after('c\nd')));
  assert.notEqual(stateKey(after('```')), stateKey(after('x')));
  assert.notEqual(stateKey(after('a <!--')), stateKey(after('a')));
  assert.notEqual(stateKey(after('a')), stateKey(after('')));
});

test('ranges split by line', () => {
  const lines = ['abc', 'de', '', 'fgh'];
  // offsets: abc 0-3, de 4-6, '' 7, fgh 8-11
  const by = rangesByLine(lines, [{ start: 1, end: 2 }, { start: 2, end: 5 }, { start: 9, end: 9 }, { start: 9, end: 11 }],
    (k) => `m${k}`);
  assert.deepEqual([...by], [[0, [[1, 2, 'm0'], [2, 3, 'm1']]], [1, [[0, 1, 'm1']]], [3, [[1, 3, 'm3']]]]);
});

test('lines as HTML: escaped, tokens and marks combined', () => {
  assert.equal(lineHtml('a<b>&'), 'a&lt;b&gt;&amp;');
  assert.equal(lineHtml('a <b> c', [[2, 5, 'html']], [[0, 3, 'hit']]),
    '<span class="hit">a </span><span class="html hit">&lt;</span><span class="html">b&gt;</span> c');
  assert.equal(lineHtml('', [], []), '');
});

// A small deterministic random number generator, so that a failure can be repeated.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return (n) => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x % n;
  };
}

test('tokenizing again after an edit gives what tokenizing everything does', () => {
  const docs = [
    'a\n\n```\nb\nc',
    '---\ntitle: x\n---\n# H\n\ntext *em*\n===\n\n```js\ncode\n```\n\n- a\n\n    ```\n    x\n    ```\n',
    'x <!-- a\nb\n-->\n> ```\n> q\n\n~~~\n```\n~~~\nTitle\n---\n<!-- one -->\n- [x] t\n  lazy',
  ];
  // the lines edits are made of: fences, comments, front matter, setext underlines, lists
  const pieces = ['```', '~~~', '````', '<!--', '-->', '---', '...', '===', '', 'text', '- item', '    ```',
    '> ```', '> x', '# h', '*a*', 'a <!-- b', 'c --> d', '  ```js', '\t```', '> - a', '>', '1. a', '  b',
    '      ```', '  - b', '>     ```'];
  for (let d = 0; d < docs.length; d++) {
    const rand = rng(d + 7);
    let lines = docs[d].split('\n');
    let { tokens, states } = tokenizeAll(lines);
    for (let step = 0; step < 400; step++) {
      // replace lines [a, a + del) with `ins` new ones (deleting, inserting or both)
      const a = rand(lines.length + 1);
      const del = Math.min(rand(4), lines.length - a);
      const ins = Array.from({ length: rand(4) }, () => pieces[rand(pieces.length)]);
      if (!del && !ins.length) continue;
      const next = [...lines.slice(0, a), ...ins, ...lines.slice(a + del)];
      if (!next.length) next.push('');
      // the changed range as the page finds it: common lines at the start and at the end
      let s = 0;
      while (s < next.length && s < lines.length && next[s] === lines[s]) s++;
      let e = 0;
      while (e < next.length - s && e < lines.length - s && next[next.length - 1 - e] === lines[lines.length - 1 - e]) e++;
      const end = retokenize(next, tokens, states, s, lines.length - e, next.length - e);
      const full = tokenizeAll(next);
      const what = `doc ${d}, step ${step}: ${JSON.stringify(next.join('\n'))}`;
      assert.ok(end >= next.length - e, what);
      assert.deepEqual(tokens, full.tokens, what);
      assert.deepEqual(states.map(stateKey), full.states.map(stateKey), what);
      lines = next;
    }
  }
  // the case that went wrong: deleting a fence line, newline and all
  const lines = 'a\n\n```\nb\nc'.split('\n');
  const { tokens, states } = tokenizeAll(lines);
  lines.splice(2, 1);
  retokenize(lines, tokens, states, 2, 3, 2);
  assert.deepEqual(tokens, [[], [], [], []]);
});

test('a keystroke tokenizes only a few lines again; a fence opened far up, all or give up', () => {
  const lines = Array.from({ length: 20000 }, (_, i) => (i % 10 ? `line *${i}* text` : ''));
  const { tokens, states } = tokenizeAll(lines);
  lines[5000] += 'x';
  assert.ok(retokenize(lines, tokens, states, 5000, 5001, 5001) <= 5002);
  lines[10] = '```';
  assert.equal(retokenize(lines, tokens, states, 10, 11, 11, 300), -1);
});
