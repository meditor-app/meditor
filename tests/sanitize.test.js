import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, sanitizeHtml } from '../src/markdown.js';
import { VECTORS } from './xss-vectors.js';

// What the renderer may emit. Its output is canonical: every tag is rebuilt by the
// sanitiser or written by the renderer itself, so a strict tokenizer is enough to read it.
const TAGS = new Set(('a abbr b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt em '
  + 'figcaption figure h1 h2 h3 h4 h5 h6 hr i img input ins kbd li mark ol p picture pre q rp rt ruby s samp '
  + 'section small source span strike strong sub summary sup table tbody td tfoot th thead tr tt u ul var wbr '
  + 'svg path').split(' '));
const ATTRS = new Set(('abbr align alt border cite class colspan datetime dir height href hreflang id lang media '
  + 'name open rowspan scope span src srcset start summary title type valign width checked disabled reversed '
  + 'viewbox d fill aria-hidden aria-label role data-line data-path rel target').split(' '));
const TAG = /^<\/?([a-z][a-z0-9]*)((?:\s+[a-z-]+(?:="[^"<>]*")?)*)\s*\/?>/;
const ATTR = /\s+([a-z-]+)(?:="([^"]*)")?/g;

const unescape = (v) => v.replace(/&(amp|quot|lt|gt|#\d+|#x[0-9a-f]+);/gi, (_, e) => ({ amp: '&', quot: '"', lt: '<', gt: '>' })[e]
  ?? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));

/** Every problem with `html` as page content; [] when it is safe. */
function problems(html) {
  const out = [];
  for (let i = html.indexOf('<'); i >= 0; i = html.indexOf('<', i + 1)) {
    const m = html.slice(i).match(TAG);
    if (!m) { out.push(`stray "<" at ${i}: ${html.slice(i, i + 40)}`); continue; }
    if (!TAGS.has(m[1])) out.push(`tag <${m[1]}>`);
    for (const [, name, raw = ''] of m[2].matchAll(ATTR)) {
      if (!ATTRS.has(name)) out.push(`attribute ${name} on <${m[1]}>`);
      const value = unescape(raw);
      if (['href', 'src', 'cite'].includes(name) || name === 'srcset') {
        for (const url of name === 'srcset' ? value.split(',') : [value]) {
          const u = url.replace(/[\u0000- \u007f]/g, '').toLowerCase();
          if (/^(javascript|vbscript|file):/.test(u) || (u.startsWith('data:') && !/^data:image\/(png|gif|jpe?g|webp|avif|bmp)[;,]/.test(u))) {
            out.push(`${name}="${value}"`);
          }
        }
      }
    }
  }
  return out;
}

test('the checker itself notices unsafe output', () => {
  assert.notDeepEqual(problems('<img src="x" onerror="y">'), []);
  assert.notDeepEqual(problems('<a href="java&#9;script:x">'), []);
  assert.notDeepEqual(problems('<iframe>'), []);
  assert.notDeepEqual(problems('a <b'), []);
  assert.deepEqual(problems('<p class="x">a &lt; b</p>'), []);
});

for (const v of VECTORS) {
  test(`neutralised: ${JSON.stringify(v).slice(0, 70)}`, () => {
    assert.deepEqual(problems(renderMarkdown(v)), [], renderMarkdown(v));
    assert.deepEqual(problems(sanitizeHtml(v)), [], sanitizeHtml(v));
  });
}

test('ids cannot collide with the page, classes cannot borrow its look', () => {
  const out = sanitizeHtml('<div id="status" name="commit" class="toast dlg markdown-alert pl-k">x</div>');
  assert.equal(out, '<div id="user-content-status" name="user-content-commit" class="markdown-alert pl-k">x</div>');
  assert.equal(sanitizeHtml('<h2 id="user-content-x">'), '<h2 id="user-content-x">');
});
