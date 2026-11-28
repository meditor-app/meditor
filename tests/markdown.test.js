import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, sanitizeHtml, slugify, isExternalLink } from '../src/markdown.js';
import { toggleTask } from '../src/edit.js';

test('links to other sites open in a new tab, protocol-relative ones too (#32)', () => {
  // `//host` used to replace the editor in its own tab
  assert.equal(renderMarkdown('[a](//evil.example/login) [b](https://x.y)'),
    '<p data-line="0"><a href="//evil.example/login" rel="nofollow noopener" target="_blank">a</a> <a href="https://x.y" rel="nofollow noopener" target="_blank">b</a></p>');
  // raw and GitHub-rendered HTML get target and rel from ui.js fixRelative, by the same test
  for (const href of ['//evil.example', '/\\evil.example', '\\\\evil.example', 'https://x.y', 'HTTP://x.y', 'http:x.y', ' //evil.example', '/\t/evil.example']) {
    assert.ok(isExternalLink(href), href);
  }
  for (const href of ['#x', '#repo=a/b&path=c.md', 'x.md', '/x.md', '../x.md', 'mailto:a@b.c', 'tel:1']) {
    assert.ok(!isExternalLink(href), href);
  }
});

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
    '<pre lang="js"><code class="language-js"><span class="pl-k">if</span> (a &lt; b) **x**\n</code></pre>');
  assert.equal(md('```klingon\nif x\n```'), '<pre lang="klingon"><code class="language-klingon">if x\n</code></pre>');
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
    '<details><summary>s</summary>\n<p>body</p>\n</details>');
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

test('fenced code is coloured with GitHub\'s classes, unknown languages stay plain', () => {
  assert.equal(md('```Python\nx = "a" # c\n```'),
    '<pre lang="Python"><code class="language-Python">x = <span class="pl-s">&quot;a&quot;</span> <span class="pl-c"># c</span>\n</code></pre>');
  assert.equal(md('```\nconst x = 1\n```'), '<pre><code>const x = 1\n</code></pre>');
  assert.equal(md('    const x = 1'), '<pre><code>const x = 1\n</code></pre>');
  assert.equal(md('`const x`'), '<p><code>const x</code></p>');
});

test('a 5,000-line code block renders quickly', () => {
  const js = Array.from({ length: 5000 }, (_, i) => `  const v${i} = f("s${i}", ${i} * 2.5); // note ${i}`).join('\n');
  renderMarkdown('```js\nlet a = 1;\n```'); // compile the code paths once, as typing does
  // Wall-clock time on a shared CI machine varies a lot (about 50 ms here, 100 ms on
  // GitHub's runners), so take the best of three and allow plenty: the point is to catch
  // a slow (say quadratic) highlighter, which would take seconds.
  let ms = Infinity, out;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    out = renderMarkdown('```js\n' + js + '\n```');
    ms = Math.min(ms, performance.now() - t);
  }
  assert.equal((out.match(/<span class="pl-c">/g) || []).length, 5000);
  assert.ok(ms < 300, `took ${ms.toFixed(1)} ms`);
});

test('inline math follows GitHub\'s rules for what counts as a delimiter', () => {
  const m = (tex) => `<span class="math math-inline">${tex}</span>`;
  assert.equal(md('Euler: $e^{i\\pi} + 1 = 0$.'), `<p>Euler: ${m('e^{i\\pi} + 1 = 0')}.</p>`);
  assert.equal(md('$$a$$ and $`b < c`$'), `<p>${m('a')} and ${m('b &lt; c')}</p>`);
  assert.equal(md('$`a\\$b`$'), `<p>${m('a\\$b')}</p>`);
  // what stays prose
  assert.equal(md('It costs $5 and $10.'), '<p>It costs $5 and $10.</p>');
  assert.equal(md('$ a$ $b $ $c$5 $d$e x$f$'), '<p>$ a$ $b $ $c$5 $d$e x$f$</p>');
  assert.equal(md('\\$a$ and $b\\$c$'), '<p>$a$ and $b$c$</p>');
  assert.equal(md('`$a$`'), '<p><code>$a$</code></p>');
  // the TeX is kept as written: no emphasis, no entities, no emoji
  assert.equal(md('$a_1 *b* c_2 :tada: &amp;$'), `<p>${m('a_1 *b* c_2 :tada: &amp;amp;')}</p>`);
  assert.equal(md('*$x$*'), `<p><em>${m('x')}</em></p>`);
});

test('display math: $$ blocks and math fences, set apart', () => {
  assert.equal(md('$$\n\\sum_i x_i < 1\n$$'), '<div class="math math-display">\\sum_i x_i &lt; 1</div>');
  assert.equal(md('```math\na^2 + b^2\n```'), '<div class="math math-display">a^2 + b^2</div>');
  assert.equal(md('$$\na\nb$$\n\nnext'), '<div class="math math-display">a\nb</div>\n<p>next</p>');
  assert.equal(md('> $$\n> x\n> $$'), '<blockquote>\n<div class="math math-display">x</div>\n</blockquote>');
  // unclosed, or broken by a blank line: a paragraph, as on GitHub
  assert.equal(md('$$\nx\n\ny'), '<p>$$\nx</p>\n<p>y</p>');
  assert.match(renderMarkdown('$$\nx\n$$\n\ntext'), /^<div class="math math-display" data-line="0">x<\/div>\n<p data-line="4">/);
});

test('Mermaid diagrams show their source and point to GitHub\'s renderer', () => {
  const out = renderMarkdown('```mermaid\ngraph TD; A-->B\n```');
  assert.match(out, /^<div class="mermaid-source" data-line="0"><p class="mermaid-note">Mermaid diagram — shown by GitHub; <button type="button" class="mermaid-switch" data-renderer="github">switch the renderer to GitHub \(exact\)<\/button> to see it<\/p>/);
  assert.match(out, /<pre lang="mermaid"><code class="language-mermaid">graph TD; A--&gt;B\n<\/code><\/pre><\/div>$/);
  // documents cannot dress raw HTML up as these
  assert.equal(md('a <span class="math math-inline mermaid-note">x</span><button data-renderer="github">b</button>'),
    '<p>a <span>x</span>b</p>');
});

test('emoji shortcodes become emoji, outside code; unknown ones stay as written', () => {
  assert.equal(md(':tada: :+1: :warning: :-1: :t-rex:'), '<p>🎉 👍 ⚠️ 👎 🦖</p>');
  assert.equal(md('done:white_check_mark:!'), '<p>done✅!</p>');
  assert.equal(md(':nope: :constructor: :toString: :TADA: 10:30:00 ::'), '<p>:nope: :constructor: :toString: :TADA: 10:30:00 ::</p>');
  assert.equal(md('`:tada:`\n\n    :tada:'), '<p><code>:tada:</code></p>\n<pre><code>:tada:\n</code></pre>');
  assert.equal(md('[:rocket: go](x.md) https://x.org/:tada:'),
    '<p><a href="x.md">🚀 go</a> <a href="https://x.org/:tada" rel="nofollow noopener" target="_blank">https://x.org/:tada</a>:</p>');
  assert.match(md('# :sparkles: New'), /<\/a>✨ New<\/h1>$/);
});

test('every task box the renderer emits can be ticked by toggleTask', () => {
  const docs = [
    '- [ ] a\n- [x] b',
    '---\ntitle: x\n---\n- [ ] after front matter',
    '- a\n  - [ ] nested\n    1. [x] deeper',
    '- [ ] lazy\ncontinuation\n- [ ] next',
    '- item\n\n  ```\n  - [ ] not a task\n  ```\n- [ ] task',
    '> - [ ] in quote\n> > 1) [x] in nested quote',
    '- > - [ ] in quote in list',
    '1. > * [x] in quote in numbered item',
    '- [ ] crlf\r\n- [x] crlf',
  ];
  for (const doc of docs) {
    const lines = [...renderMarkdown(doc).matchAll(/class="task-list-item-checkbox"[^>]*data-line="(\d+)"/g)];
    assert.ok(lines.length > 0, doc);
    for (const [, line] of lines) assert.notEqual(toggleTask(doc, +line), doc, `${JSON.stringify(doc)} line ${line}`);
  }
});
