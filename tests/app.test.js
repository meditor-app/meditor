import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

test('the service worker keeps every module and stylesheet the page loads', () => {
  const sw = read('sw.js');
  for (const f of readdirSync(new URL('src/', root))) {
    assert.ok(sw.includes(`'src/${f}'`), `sw.js SHELL is missing src/${f}`);
  }
});

test('the manifest is valid and its icons exist', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(existsSync(new URL(i.src, root)), i.src);
});

test('Pages publishes everything the page refers to', () => {
  const wf = read('.github/workflows/pages.yml');
  for (const f of ['index.html', 'manifest.webmanifest', 'sw.js', 'icons', 'src', 'meditor']) assert.match(wf, new RegExp(`cp -r .*\\b${f.replace('.', '\\.')}\\b`));
});

test('the Content Security Policy allows what the page needs and nothing inline', async () => {
  const html = read('index.html');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const dir = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(dir['script-src'], ["'self'"]);
  assert.deepEqual(dir['style-src'], ["'self'"]);
  assert.deepEqual(dir['object-src'], ["'none'"]);
  const { GITHUB_APP } = await import('../src/config.js');
  for (const origin of ['https://api.github.com', new URL(GITHUB_APP.relay).origin]) {
    assert.ok(dir['connect-src'].includes(origin), `connect-src lacks ${origin}`);
  }
  // nothing inline for the policy to block
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'inline <script>');
  assert.doesNotMatch(html, /\son[a-z]+=|\sstyle=|<style/i, 'inline handler or style');
});

test('whatever lays out the source text is set on its highlighted copy too', () => {
  // the coloured copy lies under the textarea and must place every character alike (ui.js,
  // "highlighting"), also where a media query changes the textarea, as on phones
  const css = read('src/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const layout = /(^|;|\{)\s*(font(-size|-family)?|line-height|padding(-\w+)?|letter-spacing|word-spacing|tab-size|white-space|overflow-wrap|word-break)\s*:/;
  let checked = 0;
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = selectors.split(',').map((s) => s.trim());
    if (!list.includes('#src') || !layout.test(body)) continue;
    assert.ok(list.includes('#srcHlText'), `"${list.join(', ')}" lays out #src but not #srcHlText`);
    checked++;
  }
  assert.ok(checked >= 3, `found only ${checked} rules`);
});

// ---- accessibility (#33)

/** The colour tokens of one rule of app.css, by its exact selector. */
function tokens(css, selector) {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `no rule ${selector}`);
  const body = css.slice(at, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(([, k, v]) => [k, v.toLowerCase()]));
}

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the contrast formula gives the known ratios', () => {
  assert.equal(contrast('#000000', '#ffffff'), 21);
  assert.equal(contrast('#777777', '#777777'), 1);
  assert.equal(contrast('#767676', '#ffffff').toFixed(2), '4.54'); // the classic lightest AA grey
});

test('every text colour reaches WCAG AA (4.5:1) on the grounds it is used on, in both themes', () => {
  const css = read('src/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const light = tokens(css, ':root');
  const dark = tokens(css, ':root[data-theme="dark"]');
  // the dark theme is written twice: chosen with ◐, and the system's when none is chosen
  assert.deepEqual(tokens(css, ':root:not([data-theme="light"])'), dark);

  // text token → the backgrounds it is written on (see app.css): --paper the page and status
  // bar, --panel the file list, pane heads and dialogs, --plate the panes, lists and inputs,
  // --code-bg code in the preview, --accent-soft the open file and hovered rows
  const everywhere = ['paper', 'panel', 'plate', 'code-bg', 'accent-soft'];
  const content = ['panel', 'plate', 'code-bg']; // the preview, the highlighted source, dialogs
  const used = {
    'ink': everywhere,
    'ink-soft': everywhere,
    'ink-faint': everywhere,
    'link': ['paper', 'panel', 'plate'],
    'accent': ['paper', 'panel', 'plate'],
    'bad': ['paper', ...content],
    'good': content,
    'note': content,
    'tip': content,
    'important': content,
    'warning': content,
    'caution': content,
  };
  const failures = [];
  for (const [name, theme] of [['light', light], ['dark', dark]]) {
    for (const [fg, grounds] of Object.entries(used)) {
      for (const bg of grounds) {
        assert.ok(theme[fg] && theme[bg], `${name}: --${fg} or --${bg} missing`);
        const r = contrast(theme[fg], theme[bg]);
        if (r < 4.5) failures.push(`${name}: --${fg} ${theme[fg]} on --${bg} ${theme[bg]} is ${r.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('a chosen theme is remembered, set before boot, and draws native controls in it too', () => {
  const css = read('src/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light\s*;/);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark\s*;/);
  const ui = read('src/ui.js');
  const at = ui.indexOf('function savePrefs()');
  assert.match(ui.slice(at, ui.indexOf('\n}\n', at)), /\btheme\b/, 'savePrefs does not keep the theme');
  // read back and applied at the top level of the module, not in boot() or later
  const top = ui.slice(0, ui.indexOf('\nfunction '));
  assert.match(top, /store\.get\(K\.prefs[^)]*\)\?\.theme/);
  assert.match(top, /^if \(theme\) document\.documentElement\.dataset\.theme = theme;$/m);
  // and the module is fetched from <head>, not after the body has been read
  const html = read('index.html');
  assert.ok(html.indexOf('src="src/main.js"') < html.indexOf('</head>'));
});

/** A small HTML parser, enough for index.html: elements with attributes, children and text. */
function parseHtml(html) {
  const VOID = new Set(['meta', 'link', 'input', 'img', 'br', 'hr', 'source', 'wbr']);
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  const decode = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  for (const m of html.matchAll(/<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>|[^<]+/gi)) {
    if (m[0].startsWith('<!')) continue;
    if (!m[2]) { cur.children.push({ text: decode(m[0]) }); continue; }
    const tag = m[2].toLowerCase();
    if (m[1]) {
      let n = cur;
      while (n !== root && n.tag !== tag) n = n.parent;
      assert.ok(n !== root, `unmatched </${tag}>`);
      cur = n.parent;
      continue;
    }
    const attrs = Object.fromEntries([...m[3].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(([, k, v]) => [k.toLowerCase(), decode(v ?? '')]));
    const el = { tag, attrs, children: [], parent: cur };
    cur.children.push(el);
    if (!VOID.has(tag)) cur = el;
  }
  return root;
}

function* walk(n) {
  for (const c of n.children || []) { yield c; yield* walk(c); }
}
/** The text a screen reader reads from an element's content (aria-hidden parts left out). */
const textOf = (n) => (n.text ?? (n.attrs['aria-hidden'] === 'true' ? '' : n.children.map(textOf).join(''))).replace(/\s+/g, ' ');
/** Words, not just symbols such as ◐ ↻ ☐ or "1.", which are read by their Unicode names. */
const words = (t) => /\p{L}{2,}/u.test(t);
const labelable = (n) => ['button', 'select', 'textarea', 'meter', 'output', 'progress'].includes(n.tag)
  || (n.tag === 'input' && n.attrs.type !== 'hidden');

test('every button, input and select in index.html has a spoken name', () => {
  const doc = parseHtml(read('index.html'));
  const all = [...walk(doc)].filter((n) => n.tag);
  const byFor = new Map(all.filter((n) => n.tag === 'label' && n.attrs.for).map((n) => [n.attrs.for, n]));
  const nameOf = (el) => {
    if (el.attrs['aria-label']?.trim()) return el.attrs['aria-label'];
    if (el.attrs['aria-labelledby']) return el.attrs['aria-labelledby'];
    if (el.tag === 'button' && words(textOf(el))) return textOf(el);
    // a <label for> it, or the <label> around it if it is the first control in there (a label
    // labels only that one): the label's own text, without the controls in it
    let label = el.attrs.id && byFor.get(el.attrs.id);
    for (let p = el.parent; !label && p; p = p.parent) {
      if (p.tag === 'label') {
        if ([...walk(p)].find((n) => n.tag && labelable(n)) === el) label = p;
        break;
      }
    }
    const own = (n) => (n.text ?? (labelable(n) ? '' : n.children.map(own).join('')));
    if (label && words(own(label))) return own(label);
    // a tooltip names a control only when nothing else does: not a button showing a symbol
    if (el.attrs.title && !(el.tag === 'button' && textOf(el).trim())) return el.attrs.title;
    return '';
  };
  const controls = all.filter(labelable);
  assert.ok(controls.length > 50, `found only ${controls.length} controls`);
  const unnamed = controls.filter((n) => !words(nameOf(n)))
    .map((n) => `<${n.tag}${n.attrs.id ? ` id="${n.attrs.id}"` : ''}${n.attrs['data-cmd'] ? ` data-cmd="${n.attrs['data-cmd']}"` : ''}>${textOf(n).trim()}`);
  assert.deepEqual(unnamed, []);
});

test('the file list does not claim to be a tree that it is not', () => {
  // role="tree" promises treeitems, groups and arrow keys; the list is plain buttons instead
  const ui = read('src/ui.js');
  const html = read('index.html');
  if (/role="tree"/.test(html)) assert.match(ui, /treeitem/);
  assert.match(html, /<nav id="tree" class="tree" aria-label="[^"]+">/);
  // its glyphs (▤ ▸ ▾ ●) are not read out, and the rename and delete buttons say what they do
  assert.match(ui, /<span class="ic" aria-hidden="true">▤<\/span>/);
  assert.match(ui, /<span class="ic" aria-hidden="true">\$\{isOpen/);
  assert.match(ui, /a\.setAttribute\('aria-label', a\.title\)/);
  assert.match(ui, /forget\.setAttribute\('aria-label'/);
});
