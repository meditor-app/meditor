// Where the local renderer differed from GitHub (#28), and inputs that made it slow or throw
// (#29). Each test is the issue's minimal example.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, sanitizeHtml } from '../src/markdown.js';
import { highlight } from '../src/highlight.js';

const md = (s, o) => renderMarkdown(s, o).replace(/ data-line="\d+"/g, '').trim();
const lines = (out) => [...out.matchAll(/<(\w+) data-line="(\d+)"/g)].map((m) => `${m[1]}:${m[2]}`);
const ext = 'rel="nofollow noopener" target="_blank"';

// ---------------------------------------------------------------- #28

test('an HTML element may span Markdown blocks: <details>, <div align>', () => {
  assert.equal(md('<details><summary>s</summary>\n\nbody\n\n</details>'),
    '<details><summary>s</summary>\n<p>body</p>\n</details>');
  const centred = renderMarkdown('<div align="center">\n\n# Title\n\n</div>');
  assert.match(centred, /^<div data-line="0" align="center">\n<h1 data-line="2" id="user-content-title">.*<\/h1>\n<\/div>$/);
  assert.doesNotMatch(centred, /html-block/);
  // the line goes on the block's first element (none when it starts with text or a close tag)
  assert.deepEqual(lines(renderMarkdown('<p align="center">\n<img src="a.png">\n</p>\n\ntext\n\n</div>')), ['p:0', 'p:4']);
});

test('only block-level tags, or a tag alone on its line, start an HTML block', () => {
  assert.equal(md('<kbd>Ctrl</kbd>+<kbd>C</kbd> **copies**'), '<p><kbd>Ctrl</kbd>+<kbd>C</kbd> <strong>copies</strong></p>');
  assert.equal(md('<img src=logo.png> **Fast**'), '<p><img src="logo.png"> <strong>Fast</strong></p>');
  assert.equal(md('Some text\n<span>x</span> more'), '<p>Some text\n<span>x</span> more</p>');
  // a lone tag starts one (kind 7) but cannot interrupt a paragraph; block tags (kind 6) can
  assert.equal(md('<span>\n*a*\n</span>'), '<span>\n*a*\n</span>');
  assert.equal(md('text\n<span>'), '<p>text\n<span></p>');
  assert.equal(md('text\n<div>x</div>'), '<p>text</p>\n<div>x</div>');
});

test('a lazy line continues an open paragraph only, not a fence, heading or table', () => {
  assert.equal(md('1. Run:\n   ```\n   npm i\n   ```\nThen do X'),
    '<ol>\n<li>Run:\n<pre><code>npm i\n</code></pre></li>\n</ol>\n<p>Then do X</p>');
  assert.equal(md('> ```\n> code\n> ```\nAfter the quote'),
    '<blockquote>\n<pre><code>code\n</code></pre>\n</blockquote>\n<p>After the quote</p>');
  assert.match(md('> ## Title\nNot quoted'), /<\/h2>\n<\/blockquote>\n<p>Not quoted<\/p>$/);
  assert.match(md('- item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\nafter'), /<\/table><\/li>\n<\/ul>\n<p>after<\/p>$/);
  // the prose after the list is a top-level block of its own
  assert.deepEqual(lines(renderMarkdown('1. Run:\n   ```\n   npm i\n   ```\nThen do X')), ['ol:0', 'li:0', 'p:4']);
  // lazy lines that do continue a paragraph
  assert.equal(md('> a\nb'), '<blockquote>\n<p>a\nb</p>\n</blockquote>');
  assert.equal(md('> - a\nb'), '<blockquote>\n<ul>\n<li>a\nb</li>\n</ul>\n</blockquote>');
  assert.equal(md('- a\n  > b\nc'), '<ul>\n<li>a\n<blockquote>\n<p>b\nc</p>\n</blockquote></li>\n</ul>');
});

test('a link reference definition may follow any block but a paragraph', () => {
  assert.equal(md('## Links\n[a]: http://x.com\n\nsee [a]').replace(/^<h2.*<\/h2>\n/, ''),
    `<p>see <a href="http://x.com" ${ext}>a</a></p>`);
  assert.equal(md('```\nx\n```\n[a]: http://x\n\n[a]'), `<pre><code>x\n</code></pre>\n<p><a href="http://x" ${ext}>a</a></p>`);
  assert.equal(md('***\n[a]: /x\n- i\n\n[b]: /y\n\n[a] [b]'),
    '<hr>\n<ul>\n<li>i</li>\n</ul>\n<p><a href="/x">a</a> <a href="/y">b</a></p>');
  // inside a paragraph it is text, and so is the next line that looks like one
  assert.equal(md('text\n[a]: /x\n[b]: /y\n\n[b]'), '<p>text\n[a]: /x\n[b]: /y</p>\n<p>[b]</p>');
});

test('a blank line inside a nested list does not make the outer list loose', () => {
  assert.equal(md('- a\n  - b\n\n  - c\n- d'),
    '<ul>\n<li>a\n<ul>\n<li><p>b</p></li>\n<li><p>c</p></li>\n</ul></li>\n<li>d</li>\n</ul>');
  assert.equal(md('- a\n  - b\n\n    more\n- d'),
    '<ul>\n<li>a\n<ul>\n<li><p>b</p>\n<p>more</p></li>\n</ul></li>\n<li>d</li>\n</ul>');
  // between the item's own blocks it does
  assert.equal(md('- a\n\n  - b\n- d'), '<ul>\n<li><p>a</p>\n<ul>\n<li>b</li>\n</ul></li>\n<li><p>d</p></li>\n</ul>');
  assert.equal(md('- a\n  > b\n\n  c'), '<ul>\n<li><p>a</p>\n<blockquote>\n<p>b</p>\n</blockquote>\n<p>c</p></li>\n</ul>');
});

test('HTML named entities: Latin letters and symbols decode, in text and anchors', () => {
  assert.equal(md('caf&eacute; &ouml; &szlig; &auml;'), '<p>café ö ß ä</p>');
  assert.match(md('# Caf&eacute; &amp; cr&egrave;me'), /^<h1 id="user-content-café--crème">/);
  assert.equal(md('&Ccaron;esk&yacute; &rarr; &frac12; &bogus;'), '<p>Český → ½ &amp;bogus;</p>');
});

test('a raw <pre> (and <script>, <style>, <textarea>) block runs to its closing tag', () => {
  assert.equal(md('<pre>\nline1\n\nline2\n</pre>\n\nafter'), '<pre>\nline1\n\nline2\n</pre>\n<p>after</p>');
  assert.equal(md('<script>\na\n\nb\n</script>\nafter'), '<p>after</p>');
  assert.equal(md('<!-- a\n\nb -->\nafter'), '<p>after</p>');
});

test('a footnote referenced only from another footnote is listed', () => {
  const out = md('Text[^a]\n\n[^a]: See[^b]\n[^b]: inner');
  assert.match(out, /<li id="user-content-fn-1"><p>See<sup><a href="#fn-2" id="user-content-fnref-2"/);
  assert.match(out, /<li id="user-content-fn-2"><p>inner <a href="#fnref-2" class="footnote-backref"/);
  // and a footnote referenced again from a later one gets both back references
  assert.match(md('x[^a]\n\n[^a]: A[^b]\n[^b]: B[^a]'), /<li id="user-content-fn-1"><p>A<sup>.*<\/sup> <a href="#fnref-1"[^>]*>↩<\/a> <a href="#fnref-1-2"/);
});

test('a tilde fence may have a backtick in its info string; a backtick fence may not', () => {
  assert.equal(md('~~~ js `x`\ncode\n~~~'), '<pre lang="js"><code class="language-js">code\n</code></pre>');
  assert.equal(md('``` js `x`\ncode'), '<p>``` js <code>x</code>\ncode</p>');
});

test('an unescaped pipe splits a table cell even inside a code span', () => {
  assert.equal(md('| a | b |\n|---|---|\n| `x|y` | z |'),
    '<table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n<tbody>\n<tr><td>`x</td><td>y`</td></tr>\n</tbody>\n</table>');
  assert.match(md('| a |\n|---|\n| `x\\|y` |'), /<td><code>x\|y<\/code><\/td>/);
});

// ---------------------------------------------------------------- #29

/** The best of three runs, in ms: CI machines are slow and noisy. */
function time(f) {
  f();
  let ms = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    f();
    ms = Math.min(ms, performance.now() - t);
  }
  return ms;
}

test('no input makes rendering slow (each took seconds when quadratic)', () => {
  const inputs = {
    'unclosed link destinations': '[a]('.repeat(10000),
    'emphasis openers, then closers': '*a '.repeat(10000) + ' b*'.repeat(10000),
    'underscores, the same': '_a '.repeat(10000) + ' b_'.repeat(10000),
    'tag-like runs': '<a\t'.repeat(10000),
    'tildes that only close': 'a~ '.repeat(20000),
    'unmatched brackets': '['.repeat(20000),
    'brackets after a backtick in a tag': 'a <b title="`">' + '['.repeat(20000) + '`',
    'unclosed <destinations': '[a](<'.repeat(10000),
    'unclosed (titles': '[a](x ('.repeat(10000),
    'reference-like links': '[a]['.repeat(10000),
    'unclosed comments': 'x ' + '<!--'.repeat(10000),
    'unclosed <script> in a block': '<p>' + '<script '.repeat(10000),
    'autolink with trailing junk': 'http://a' + '.)'.repeat(20000),
    'backtick runs of every length': Array.from({ length: 300 }, (_, k) => '`'.repeat(k + 1)).join(' a '),
    'lazy quote lines': '> a\nb\n'.repeat(5000),
    'deep nested lists': '- '.repeat(5000) + 'x',
  };
  for (const [name, s] of Object.entries(inputs)) {
    const ms = time(() => renderMarkdown(s));
    assert.ok(ms < 500, `${name}: ${ms.toFixed(1)} ms`);
  }
  // the faster bracket matching still sees a backtick inside a tag as the tag's
  assert.equal(md('a <b title="`">[x](/u)</b> `'), '<p>a <b title="`"><a href="/u">x</a></b> `</p>');
  const ms = time(() => sanitizeHtml('<a\t'.repeat(10000) + '<script>'.repeat(10000)));
  assert.ok(ms < 500, `sanitizeHtml: ${ms.toFixed(1)} ms`);
});

test('unclosed ${ in shell code is highlighted in linear time', () => {
  for (const s of ['${'.repeat(30000), '"' + '${'.repeat(30000) + '"']) {
    const ms = time(() => highlight(s, 'shell'));
    assert.ok(ms < 500, `${ms.toFixed(1)} ms`);
  }
  assert.equal(highlight('a ${b} "${c}" ${d', 'sh'),
    'a <span class="pl-smi">${b}</span> <span class="pl-s">&quot;<span class="pl-smi">${c}</span>&quot;</span> ${d');
});

test('deep nesting renders (capped) instead of overflowing the stack', () => {
  for (const s of ['>'.repeat(5000) + ' x', '- '.repeat(5000) + 'x', '> - '.repeat(3000) + 'x', '1. '.repeat(5000) + 'x']) {
    assert.match(renderMarkdown(s), /x/);
  }
  for (const s of ['!['.repeat(5000) + 'x' + '](u)'.repeat(5000), '['.repeat(5000) + 'x' + '](u)'.repeat(5000)]) {
    assert.match(renderMarkdown(s), /^<p data-line="0">/);
  }
  const out = renderMarkdown('>'.repeat(200) + ' deep');
  assert.equal((out.match(/<blockquote>/g) || []).length, 99); // 100 levels, the first with data-line
  assert.match(out, /<p>(?:&gt;)+ deep<\/p>/);
  // ordinary nesting is untouched
  assert.equal(md('> > > a'), '<blockquote>\n<blockquote>\n<blockquote>\n<p>a</p>\n</blockquote>\n</blockquote>\n</blockquote>');
});
