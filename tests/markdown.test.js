import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, sanitizeHtml, slugify } from '../src/markdown.js';

// Compare without the data-line attributes, which only the page cares about.
const md = (s, o) => renderMarkdown(s, o).replace(/ data-line="\d+"/g, '').trim();

test('headings get GitHub anchors, de-duplicated', () => {
  assert.equal(md('# Hello *World*'),
    '<h1 id="user-content-hello-world"><a class="anchor" href="#hello-world" aria-hidden="true">#</a>Hello <em>World</em></h1>');
  const h = md('## A\n\n## A');
  assert.match(h, /id="user-content-a"/);
  assert.match(h, /id="user-content-a-1"/);
  assert.equal(slugify('What’s new in v2.0?'), 'whats-new-in-v20');
  assert.match(md('Title\n====='), /^<h1 id="user-content-title">/);
  assert.match(md('Sub\n---'), /^<h2 id="user-content-sub">/);
});

test('emphasis follows the CommonMark rules', () => {
  assert.equal(md('*a* **b** ***c*** _d_ __e__'),
    '<p><em>a</em> <strong>b</strong> <em><strong>c</strong></em> <em>d</em> <strong>e</strong></p>');
  assert.equal(md('snake_case_name and 2*3*4'), '<p>snake_case_name and 2<em>3</em>4</p>');
  assert.equal(md('*a **b** c*'), '<p><em>a <strong>b</strong> c</em></p>');
  assert.equal(md('**unclosed'), '<p>**unclosed</p>');
  assert.equal(md('~~gone~~ ~one~'), '<p><del>gone</del> <del>one</del></p>');
  assert.equal(md('\\*literal\\*'), '<p>*literal*</p>');
});

test('code spans and blocks keep their content verbatim', () => {
  assert.equal(md('`a <b> *c*`'), '<p><code>a &lt;b&gt; *c*</code></p>');
  assert.equal(md('`` a ` b ``'), '<p><code>a ` b</code></p>');
  assert.equal(md('```js\nif (a < b) **x**\n```'),
    '<pre lang="js"><code class="language-js">if (a &lt; b) **x**\n</code></pre>');
  assert.equal(md('    indented\n    code'), '<pre><code>indented\ncode\n</code></pre>');
  assert.equal(md('~~~\n```\n~~~'), '<pre><code>```\n</code></pre>');
});

test('links, references, autolinks and images', () => {
  assert.equal(md('[a](http://x.org "T")'),
    '<p><a href="http://x.org" title="T" rel="nofollow noopener" target="_blank">a</a></p>');
  assert.equal(md('[a][r] [r]\n\n[r]: ./doc.md'), '<p><a href="./doc.md">a</a> <a href="./doc.md">r</a></p>');
  assert.equal(md('see https://example.com/x).'),
    '<p>see <a href="https://example.com/x" rel="nofollow noopener" target="_blank">https://example.com/x</a>).</p>');
  assert.equal(md('<https://a.b>'), '<p><a href="https://a.b" rel="nofollow noopener" target="_blank">https://a.b</a></p>');
  assert.equal(md('![alt *x*](p.png)'), '<p><img src="p.png" alt="alt x"></p>');
  assert.equal(md('[x](javascript:alert(1))'), '<p>x</p>');
  assert.equal(md('[not a link]'), '<p>[not a link]</p>');
  assert.equal(md('[a](<b c.md>)'), '<p><a href="b%20c.md">a</a></p>');
});

test('relative links and images are resolved by the caller', () => {
  const out = md('[n](other.md) ![i](img/a.png)', {
    resolveLink: (u) => `#path=${u}`,
    resolveImage: (u) => ({ src: `https://raw/${u}`, path: u }),
  });
  assert.equal(out, '<p><a href="#path=other.md">n</a> <img src="https://raw/img/a.png" alt="i" data-path="img/a.png"></p>');
});

test('lists: tight, loose, nested, ordered, tasks', () => {
  assert.equal(md('- a\n- b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
  assert.equal(md('- a\n\n- b'), '<ul>\n<li><p>a</p></li>\n<li><p>b</p></li>\n</ul>');
  assert.equal(md('1. a\n   - b\n2. c'), '<ol>\n<li>a\n<ul>\n<li>b</li>\n</ul></li>\n<li>c</li>\n</ol>');
  assert.equal(md('3) x'), '<ol start="3">\n<li>x</li>\n</ol>');
  const t = renderMarkdown('- [ ] todo\n- [x] done');
  assert.match(t, /<input type="checkbox" class="task-list-item-checkbox" data-line="0" disabled> todo/);
  assert.match(t, /<input type="checkbox" class="task-list-item-checkbox" checked data-line="1" disabled> done/);
  assert.equal(md('- a\nlazy'), '<ul>\n<li>a\nlazy</li>\n</ul>');
  assert.equal(md('- a\n* b'), '<ul>\n<li>a</li>\n</ul>\n<ul>\n<li>b</li>\n</ul>');
  assert.equal(md('- ```\n  x\n\n  y\n  ```'), '<ul>\n<li><pre><code>x\n\ny\n</code></pre></li>\n</ul>');
});

test('block quotes and GitHub alerts', () => {
  assert.equal(md('> a\n> b'), '<blockquote>\n<p>a\nb</p>\n</blockquote>');
  assert.equal(md('> [!WARNING]\n> careful'),
    '<div class="alert alert-warning"><p class="alert-title">Warning</p>\n<p>careful</p></div>');
});

test('tables with alignment and escaped pipes', () => {
  assert.equal(md('| a | b |\n|:-|-:|\n| 1 | x\\|y |'),
    '<table>\n<thead>\n<tr><th align="left">a</th><th align="right">b</th></tr>\n</thead>\n<tbody>\n'
    + '<tr><td align="left">1</td><td align="right">x|y</td></tr>\n</tbody>\n</table>');
  assert.match(md('text\n| a |\n| - |'), /<p>text<\/p>\n<table>/);
});

test('footnotes, rules, breaks, entities, front matter', () => {
  const f = md('x[^n]\n\n[^n]: note');
  assert.match(f, /<sup><a href="#fn-1" id="user-content-fnref-1" class="footnote-ref">1<\/a><\/sup>/);
  assert.match(f, /<li id="user-content-fn-1"><p>note <a href="#fnref-1"/);
  assert.equal(md('***'), '<hr>');
  assert.equal(md('a  \nb\\\nc'), '<p>a<br>\nb<br>\nc</p>');
  assert.equal(md('&copy; &amp; & &bogus;'), '<p>© &amp; &amp; &amp;bogus;</p>');
  assert.match(renderMarkdown('---\ntitle: x\n---\n# T'), /^<pre class="front-matter" data-line="0"><code>title: x\n<\/code><\/pre>\n<h1 data-line="3"/);
});

test('raw HTML is kept but sanitised', () => {
  assert.equal(md('<details><summary>s</summary>\n\nbody\n\n</details>'),
    '<div class="html-block"><details><summary>s</summary></div>\n<p>body</p>\n<div class="html-block"></details></div>');
  assert.equal(sanitizeHtml('<img src=x onerror="alert(1)"><script>alert(2)</script>'), '<img src="x">');
  assert.equal(sanitizeHtml('<a href="javascript:x" title=t>k</a>'), '<a title="t">k</a>');
  assert.equal(sanitizeHtml('<iframe src="x"></iframe><b style="x">b</b>'), '<b>b</b>');
  assert.equal(sanitizeHtml('a < b > c'), 'a &lt; b &gt; c');
  assert.equal(md('a <kbd>Ctrl</kbd> <span onclick="x">s</span>'), '<p>a <kbd>Ctrl</kbd> <span>s</span></p>');
  assert.equal(md('<!-- hidden -->'), '');
});

test('top-level blocks carry their source line', () => {
  const out = renderMarkdown('# a\n\ntext\nmore\n\n- x\n- y\n\n```\ncode\n```');
  assert.deepEqual([...out.matchAll(/<(\w+) data-line="(\d+)"/g)].map((m) => `${m[1]}:${m[2]}`),
    ['h1:0', 'p:2', 'ul:5', 'li:5', 'li:6', 'pre:8']);
});
