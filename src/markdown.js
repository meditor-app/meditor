// A GitHub-flavoured Markdown renderer: Markdown source in, an HTML string out.
//
// Pure (no DOM), so it runs headless under `node --test`. It covers what README files and
// documentation actually use: ATX and setext headings, paragraphs, emphasis, strikethrough,
// code spans and blocks, block quotes (including GitHub's `> [!NOTE]` alerts), nested and
// task lists, tables, links and images (inline, reference, autolinks and bare URLs),
// footnotes, rules, hard breaks and raw HTML, which goes through `sanitizeHtml`. Like
// github.com it colours code blocks (`highlight.js`) and turns `:emoji:` shortcodes into
// emoji; math (`$…$`, `$$…$$`, ```` ```math ````) and Mermaid diagrams, which GitHub draws with
// scripts this page does not load, are shown as their source, set apart.
//
// Every top-level block carries `data-line` (its first source line, 0-based), which the
// page uses to keep the editor and the preview scrolled to the same place, and every task
// list checkbox carries the line of its `[ ]` so that clicking it can tick the source. Raw
// HTML blocks are emitted as written, not wrapped, so an element opened in one (<details>,
// <div align="center">) holds the Markdown blocks up to its closing tag, as on GitHub;
// their data-line goes on the block's first element, and the blocks inside keep theirs.
//
// It is not a full CommonMark implementation: the block structure is found line by line
// with a few simplifications (list item edge cases; reference definitions only at the top
// level), while the inline layer follows the CommonMark delimiter algorithm for emphasis
// faithfully. Every scan is kept (near) linear, since it runs on each keystroke, and
// nesting is capped (MAX_DEPTH), as browsers cap the depth of the elements they build.

import { highlight } from './highlight.js';
import { EMOJI } from './emoji.js';
import { ENTITIES } from './entities.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

const PUNCT = /[!-/:-@[-`{-~\p{P}\p{S}]/u;
const SPACE = /\s/u;

// ---------------------------------------------------------------- sanitising raw HTML

// Close to what GitHub keeps when it renders Markdown: structure and formatting, no
// scripts, no styles, no forms, no frames, no event handlers.
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code', 'col',
  'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p',
  'picture', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'source', 'span',
  'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'tt', 'u', 'ul', 'var', 'wbr', 'input', 'svg', 'path',
]);
const ALLOWED_ATTRS = new Set([
  'abbr', 'align', 'alt', 'border', 'cite', 'class', 'colspan', 'datetime', 'dir', 'height',
  'href', 'hreflang', 'id', 'lang', 'media', 'name', 'open', 'rowspan', 'scope', 'span',
  'src', 'srcset', 'start', 'summary', 'title', 'type', 'valign', 'width', 'checked',
  'disabled', 'reversed', 'viewbox', 'd', 'fill', 'aria-hidden', 'aria-label', 'role',
]);
// Classes a document may use: the ones GitHub's own renderer emits (and this one). Anything
// else could borrow the page's own styling, e.g. to pass a fake message off as meditor's.
const ALLOWED_CLASS = /^(?:pl-[a-z0-9-]+|highlight(?:-[\w+#.-]+)?|markdown-[a-z-]+|octicon(?:-[a-z0-9-]+)?|anchor|heading-element|task-list-item(?:-checkbox)?|contains-task-list|footnotes?|footnote-[a-z-]+|data-footnote-backref|sr-only|notranslate|language-[\w+#.-]+)$/;
/** Ids and names from documents get this prefix, as on GitHub, so they cannot collide with the page's own. */
export const ID_PREFIX = 'user-content-';
// Whole elements whose content is not text a reader should see.
const DROP_START = /<(script|style|iframe|object|embed|noscript|template|textarea|title)\b/gi;

// A tag as CommonMark defines one. Attribute names are strict ([a-zA-Z_:][a-zA-Z0-9_.:-]*),
// which also keeps the scan linear: a run of `<a<a<a…` fails at once instead of each `<`
// being tried against the rest of the text.
const ATTR_SRC = String.raw`\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?`;
const OPEN_TAG = String.raw`<[a-zA-Z][a-zA-Z0-9-]*(?:${ATTR_SRC})*\s*\/?>`;
const CLOSE_TAG = String.raw`<\/[a-zA-Z][a-zA-Z0-9-]*\s*>`;
const TAG_OR_BRACKET = new RegExp(`${OPEN_TAG}|${CLOSE_TAG}|<|>`, 'g');
const INLINE_TAG = new RegExp(`^(?:${OPEN_TAG}|${CLOSE_TAG})`);
const LONE_TAG = new RegExp(`^ {0,3}(?:${OPEN_TAG}|${CLOSE_TAG})[ \\t]*$`);

/**
 * Removes the elements in DROP_START with their content: `<script …>…</script>`. Linear:
 * once an element has no closing tag (or a `<` no `>`), later ones are not searched for it.
 */
function dropContent(html) {
  let out = '';
  let last = 0;
  let gt = -1;
  const unclosed = new Set();
  DROP_START.lastIndex = 0;
  for (let m; (m = DROP_START.exec(html));) {
    const name = m[1].toLowerCase();
    if (unclosed.has(name)) continue;
    if (gt < DROP_START.lastIndex) gt = html.indexOf('>', DROP_START.lastIndex);
    if (gt < 0) break;
    const close = new RegExp(`</${name}\\s*>`, 'gi');
    close.lastIndex = gt + 1;
    if (!close.exec(html)) { unclosed.add(name); continue; }
    out += html.slice(last, m.index);
    last = DROP_START.lastIndex = close.lastIndex;
  }
  return out + html.slice(last);
}

/** Whether a URL may appear in href/src: no javascript:, vbscript: or (non-image) data:. */
export function safeUrl(url, isImage = false) {
  const u = String(url).replace(/[\u0000- \u007f]/g, '').toLowerCase();
  if (/^(javascript|vbscript|file):/.test(u)) return false;
  if (u.startsWith('data:')) return isImage && /^data:image\/(png|gif|jpe?g|webp|avif|bmp)[;,]/.test(u);
  return true;
}

const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function sanitizeTag(tag) {
  const m = tag.match(/^<(\/?)([a-zA-Z][\w-]*)([\s\S]*?)(\/?)>$/);
  if (!m) return escapeHtml(tag);
  const [, close, rawName, rest, self] = m;
  const name = rawName.toLowerCase();
  if (!ALLOWED_TAGS.has(name)) return '';
  if (close) return `</${name}>`;
  const attrs = [];
  for (const a of rest.matchAll(ATTR)) {
    const key = a[1].toLowerCase();
    if (!ALLOWED_ATTRS.has(key)) continue;
    const raw = a[2] ?? a[3] ?? a[4];
    if (raw === undefined) { attrs.push(key); continue; }
    // Check the value the browser will see. It is written back entity-escaped, so an entity
    // decodeEntities does not know stays literal text and cannot turn into, say, a ':'.
    let value = decodeEntities(raw);
    if ((key === 'href' || key === 'src' || key === 'cite') && !safeUrl(value, name === 'img' || name === 'source')) continue;
    if (key === 'srcset' && !value.split(',').every((s) => safeUrl(s.trim(), true))) continue;
    if (name === 'input' && key === 'type' && value.trim().toLowerCase() !== 'checkbox') return '';
    if (key === 'class') {
      value = value.split(/\s+/).filter((c) => ALLOWED_CLASS.test(c)).join(' ');
      if (!value) continue;
    }
    if ((key === 'id' || key === 'name') && !value.startsWith(ID_PREFIX)) value = ID_PREFIX + value;
    attrs.push(`${key}="${escapeHtml(value)}"`);
  }
  if (name === 'input') attrs.push('disabled');
  return `<${name}${attrs.map((a) => ' ' + a).join('')}${self ? ' /' : ''}>`;
}

/**
 * Raw HTML from the document, reduced to an allowlist of tags and attributes. Text between
 * tags is kept (a stray `<` is escaped); comments vanish.
 */
export function sanitizeHtml(html) {
  return dropContent(String(html).replace(/<!--[\s\S]*?(?:-->|$)/g, ''))
    .replace(TAG_OR_BRACKET, (t) => (t === '<' ? '&lt;' : t === '>' ? '&gt;' : sanitizeTag(t)));
}

// ---------------------------------------------------------------- entities

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g;

export function decodeEntities(s) {
  return s.replace(ENTITY, (m, dec, hex, name) => {
    if (name) return ENTITIES.get(name) ?? m;
    const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
  });
}

// ---------------------------------------------------------------- headings

/** The anchor GitHub gives a heading with this text (before de-duplication). */
export function slugify(text) {
  return decodeEntities(text.replace(/<[^>]*>/g, ''))
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

// ---------------------------------------------------------------- block structure

const RE = {
  blank: /^[ \t]*$/,
  // the info string: a backtick fence's may not contain a backtick (see fenceStart)
  fence: /^( {0,3})(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$/,
  atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  quote: /^ {0,3}> ?/,
  bullet: /^( {0,3})([-+*])([ \t]+|$)(.*)$/,
  ordered: /^( {0,3})(\d{1,9})([.)])([ \t]+|$)(.*)$/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
  indented: /^(?: {4}|\t)/,
  tableDelim: /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/,
  refDef: /^ {0,3}\[((?:[^\]\\]|\\.){1,999})\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+("[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/,
  footDef: /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?(.*)$/,
  mathOpen: /^ {0,3}\$\$[ \t]*$/,
};

const ALERTS = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };

const normLabel = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

const expandTabs = (line) => {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) out += ch === '\t' ? ' '.repeat(4 - (out.length % 4)) : ch;
  return out;
};

const indentOf = (line) => line.match(/^ */)[0].length;

/** How deep block containers (quotes, list items) and links may nest; deeper markers are text. */
const MAX_DEPTH = 100;
const MAX_INLINE_DEPTH = 32;
// How many levels of containers nested in the one a Tail watches it follows: plenty for
// real documents, and it keeps deeply nested input from costing depth² per line.
const TAIL_LEVELS = 8;

/** The match of RE.fence if this line opens a code fence. */
function fenceStart(line) {
  const m = line.match(RE.fence);
  return m && !(m[2][0] === '`' && m[3].includes('`')) ? m : null;
}

/** The line that closes the fence opened by `m` (a fenceStart match). */
const fenceEnd = (m) => new RegExp(`^ {0,3}${m[2][0]}{${m[2].length},}[ \\t]*$`);

// CommonMark's HTML blocks, by kind (1–7): what starts each, and for 1–5 the text that ends
// it (on the same line or a later one, blank lines included); 6 and 7 end at a blank line.
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd '
  + 'details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head '
  + 'header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search '
  + 'section summary table tbody td tfoot th thead title tr track ul').split(' '));
const HTML_END = [null, /<\/(?:pre|script|style|textarea)>/i, /-->/, /\?>/, />/, /\]\]>/];

/** The kind of HTML block this line starts (1–7), or 0. Kind 7 cannot interrupt a paragraph. */
function htmlStart(line) {
  const m = line.match(/^ {0,3}(<.*)$/);
  if (!m) return 0;
  const t = m[1];
  if (/^<(?:pre|script|style|textarea)(?:[\s>]|$)/i.test(t)) return 1;
  if (t.startsWith('<!--')) return 2;
  if (t.startsWith('<?')) return 3;
  if (/^<![a-zA-Z]/.test(t)) return 4;
  if (t.startsWith('<![CDATA[')) return 5;
  const tag = t.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:[\s>]|\/>|$)/);
  if (tag && BLOCK_TAGS.has(tag[1].toLowerCase())) return 6;
  if (LONE_TAG.test(line) && !/^<\/?(?:pre|script|style|textarea)\b/i.test(t)) return 7;
  return 0;
}

/** Does this line start a block that interrupts a paragraph? */
function interrupts(line) {
  if (fenceStart(line) || RE.atx.test(line) || RE.hr.test(line) || RE.quote.test(line)) return true;
  const h = htmlStart(line);
  if (h && h < 7) return true;
  const b = line.match(RE.bullet);
  if (b && b[4].trim()) return true;
  const o = line.match(RE.ordered);
  if (o && o[2] === '1' && o[5].trim()) return true;
  return false;
}

function listMarker(line) {
  let m = line.match(RE.bullet);
  if (m) {
    if (RE.hr.test(line)) return null;
    return { ordered: false, char: m[2], indent: m[1].length, width: m[1].length + 1, pad: m[3].length, text: m[4] };
  }
  m = line.match(RE.ordered);
  if (m) {
    return {
      ordered: true, char: m[3], start: parseInt(m[2], 10), indent: m[1].length,
      width: m[1].length + m[2].length + 1, pad: m[4].length, text: m[5],
    };
  }
  return null;
}

/** Where a list item's content starts (its column), and its first line. */
function itemStart(lm) {
  const pad = lm.text === '' ? 1 : lm.pad > 4 ? 1 : lm.pad;
  return { content: lm.width + pad, first: lm.pad > 4 ? ' '.repeat(lm.pad - 1) + lm.text : lm.text };
}

/**
 * Follows the block structure of lines fed to it one by one, just far enough to answer what
 * the line-by-line parts of the parser need to know about the blocks so far: whether the
 * last one is a paragraph still open (only that may take a lazy continuation line, and a
 * link reference definition may not interrupt it), and whether a line after a blank one
 * still belongs to an open fence, HTML block or nested list (so the blank line does not
 * make the surrounding list loose).
 */
class Tail {
  constructor(levels = TAIL_LEVELS) {
    this.levels = levels; // how many more nested containers it follows
    this.state = null; // 'para' | 'table' | 'fence' | 'html' | 'other' (a closed block) | null
    this.end = null; // what closes the fence or HTML block
    this.child = null; // the open block quote or list item, itself a Tail
    this.last = '';
  }

  /** Is the innermost open block a paragraph? */
  get open() {
    return this.child ? this.child.open : this.state === 'para';
  }

  /** Is the line inside an open fence or HTML block, here or in a nested container? */
  get literal() {
    return this.state === 'fence' || this.state === 'html' || !!this.child?.literal;
  }

  push(line) {
    const blank = RE.blank.test(line);
    if (this.state === 'fence') {
      if (this.end.test(line)) this.state = 'other';
      return;
    }
    if (this.state === 'html') {
      if (this.end ? this.end.test(line) : blank) this.state = this.end ? 'other' : null;
      return;
    }
    const c = this.child;
    if (c) {
      if (c.quote ? RE.quote.test(line) : blank || indentOf(line) >= c.indent) {
        c.push(c.quote ? line.replace(RE.quote, '') : line.slice(c.indent));
        return;
      }
      if (!blank && c.open && !interrupts(line) && !listMarker(line)) { c.push(line); return; }
      this.child = null;
    }
    if (blank) { this.state = null; return; }
    if (this.state === 'para') {
      if (RE.setext.test(line)) { this.state = 'other'; return; }
      if (RE.tableDelim.test(line) && this.last.includes('|')) { this.state = 'table'; return; }
      if (!interrupts(line)) { this.last = line; return; }
    } else if (this.state === 'table' && !interrupts(line)) return;
    this.start(line);
  }

  start(line) {
    this.state = 'other';
    this.end = null;
    this.last = line;
    let m;
    if ((m = fenceStart(line))) { this.state = 'fence'; this.end = fenceEnd(m); return; }
    if (RE.atx.test(line) || RE.hr.test(line)) return;
    if (this.levels <= 0) { this.state = 'para'; return; } // too deep to follow: assume text
    if (RE.quote.test(line)) {
      this.child = new Tail(this.levels - 1);
      this.child.quote = true;
      this.child.push(line.replace(RE.quote, ''));
      return;
    }
    const lm = listMarker(line);
    if (lm) {
      const { content, first } = itemStart(lm);
      this.child = Object.assign(new Tail(this.levels - 1), { indent: content, ordered: lm.ordered, char: lm.char });
      if (first) this.child.push(first);
      return;
    }
    const h = htmlStart(line);
    if (h) {
      this.state = 'html';
      this.end = HTML_END[h] ?? null;
      if (this.end?.test(line)) this.state = 'other';
      return;
    }
    if (RE.indented.test(line)) return; // indented code
    this.state = 'para';
  }

  /** Would this line start a new block here (not continue one, not go into a nested one)? */
  free(line) {
    if (this.state && this.state !== 'other') return false;
    const c = this.child;
    if (!c) return true;
    if (c.quote ? RE.quote.test(line) : indentOf(line) >= c.indent) return false;
    return !c.open;
  }

  /** After a blank line: does this line continue an open fence, HTML block or nested list? */
  continues(line) {
    if (this.state === 'fence' || (this.state === 'html' && this.end)) return true;
    const c = this.child;
    if (!c || c.quote) return false;
    if (indentOf(line) >= c.indent) return true;
    const lm = listMarker(line);
    return !!lm && lm.ordered === c.ordered && lm.char === c.char;
  }

  reset() {
    this.state = null;
    this.child = null;
  }
}

class Renderer {
  constructor(opts) {
    this.opts = opts;
    this.refs = new Map();
    this.footnotes = new Map();
    this.footOrder = [];
    this.slugs = new Map();
    this.depth = 0; // of nested blocks() calls
    this.inlineDepth = 0; // of nested inline() calls (link text)
  }

  // Pull link reference and footnote definitions out of the document (outside code). A
  // reference definition may follow any block but a paragraph, which it cannot interrupt.
  collectDefs(lines) {
    const out = [];
    const tail = new Tail();
    let foot = null;
    for (const line of lines) {
      if (foot) {
        if (RE.blank.test(line) || /^ {2,}/.test(line)) {
          foot.push(line.replace(/^ {1,4}/, ''));
          out.push('');
          continue;
        }
        foot = null;
      }
      const fd = !tail.literal && line.match(RE.footDef);
      if (fd) {
        const key = normLabel(fd[1]);
        foot = [fd[2]];
        if (!this.footnotes.has(key)) this.footnotes.set(key, { label: fd[1], lines: foot });
        out.push('');
        tail.reset();
        continue;
      }
      const rd = tail.free(line) && line.match(RE.refDef);
      if (rd) {
        const key = normLabel(rd[1]);
        let url = rd[2];
        if (url.startsWith('<')) url = url.slice(1, -1);
        const title = rd[3] ? rd[3].slice(1, -1) : null;
        if (!this.refs.has(key)) this.refs.set(key, { url: unescapeMd(url), title: title && unescapeMd(title) });
        out.push('');
        tail.reset();
        continue;
      }
      tail.push(line);
      out.push(line);
    }
    return out;
  }

  /** A Tail for the blocks of a container at the current depth, fed these lines. */
  tail(lines = []) {
    const t = new Tail(Math.min(TAIL_LEVELS, MAX_DEPTH - this.depth));
    for (const l of lines) t.push(l);
    return t;
  }

  attrLine(line, top) {
    return top ? ` data-line="${line}"` : '';
  }

  /**
   * @param {string[]} lines
   * @param {number} base the source line of lines[0]; -1 when the lines are not
   *   contiguous in the source (they are, everywhere but in footnotes)
   * @param {boolean} top whether these are the document's top-level blocks
   * @param {boolean} tight whether paragraphs lose their <p> (tight list items)
   */
  blocks(lines, base, top, tight = false) {
    // Nested deeper than browsers (or GitHub) would show: the rest is plain text, which
    // also keeps the recursion off the stack limit.
    if (this.depth >= MAX_DEPTH) {
      const text = lines.map((l) => l.trim()).filter(Boolean).join('\n');
      return text ? `<p>${escapeHtml(text)}</p>` : '';
    }
    this.depth++;
    try {
      return this.blocksAt(lines, base, top, tight);
    } finally {
      this.depth--;
    }
  }

  blocksAt(lines, base, top, tight) {
    const out = [];
    const ln = (i) => (base < 0 ? -1 : base + i);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (RE.blank.test(line)) { i++; continue; }
      const at = this.attrLine(ln(i), top);
      let m;

      // fenced code
      if ((m = fenceStart(line))) {
        const indent = m[1].length;
        const close = fenceEnd(m);
        const body = [];
        i++;
        while (i < lines.length && !close.test(lines[i])) {
          body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
          i++;
        }
        i++;
        const lang = unescapeMd(decodeEntities(m[3].split(/\s+/)[0] || ''));
        const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
        const code = body.join('\n');
        if (lang.toLowerCase() === 'math') {
          out.push(mathBlock(code, at));
          continue;
        }
        const mermaid = lang.toLowerCase() === 'mermaid';
        const pre = `<pre${mermaid ? '' : at}${lang ? ` lang="${escapeHtml(lang)}"` : ''}><code${cls}>${highlight(code, lang) ?? escapeHtml(code)}${code ? '\n' : ''}</code></pre>`;
        out.push(mermaid ? mermaidBlock(pre, at) : pre);
        continue;
      }

      // display math: $$ on a line of its own, the TeX, and a line ending in $$
      if (RE.mathOpen.test(line)) {
        let j = i + 1;
        while (j < lines.length && !RE.blank.test(lines[j]) && !lines[j].trimEnd().endsWith('$$')) j++;
        if (j < lines.length && !RE.blank.test(lines[j])) {
          const tex = [...lines.slice(i + 1, j), lines[j].trimEnd().slice(0, -2)].join('\n').trim();
          out.push(mathBlock(tex, at));
          i = j + 1;
          continue;
        }
      }

      // ATX heading
      if ((m = line.match(RE.atx))) {
        out.push(this.heading(m[1].length, (m[2] || '').trim(), at));
        i++;
        continue;
      }

      // thematic break
      if (RE.hr.test(line)) {
        out.push(`<hr${at}>`);
        i++;
        continue;
      }

      // block quote
      if (RE.quote.test(line)) {
        const body = [];
        let tail = null; // made when a lazy line first needs it
        while (i < lines.length && !RE.blank.test(lines[i])) {
          let l = lines[i];
          if (RE.quote.test(l)) l = l.replace(RE.quote, '');
          // a lazy line continues an open paragraph only
          else if (interrupts(l) || !(tail ??= this.tail(body)).open) break;
          body.push(l);
          tail?.push(l);
          i++;
        }
        out.push(this.quote(body, base < 0 ? -1 : ln(i - body.length), at));
        continue;
      }

      // list
      const lm = listMarker(line);
      if (lm) {
        i = this.list(lines, i, base, top, out);
        continue;
      }

      // HTML block
      const kind = htmlStart(line);
      if (kind) {
        const body = [];
        if (kind <= 5) {
          while (i < lines.length) {
            body.push(lines[i++]);
            if (HTML_END[kind].test(body[body.length - 1])) break;
          }
        } else {
          while (i < lines.length && !RE.blank.test(lines[i])) body.push(lines[i++]);
        }
        // As written, not wrapped: an element may stay open over the Markdown blocks that
        // follow (<details>, <div align="center">), as on GitHub. The line goes on the
        // block's first element, if it starts with one.
        let html = sanitizeHtml(body.join('\n'));
        if (at) html = html.replace(/^(\s*<(?!input\b)[a-z][a-z0-9]*)(?=[\s/>])/, `$1${at}`);
        if (html.trim()) out.push(html);
        continue;
      }

      // indented code
      if (RE.indented.test(line)) {
        const body = [];
        while (i < lines.length && (RE.indented.test(lines[i]) || RE.blank.test(lines[i]))) {
          body.push(lines[i].replace(/^(?: {4}|\t)/, ''));
          i++;
        }
        while (body.length && RE.blank.test(body[body.length - 1])) body.pop();
        out.push(`<pre${at}><code>${escapeHtml(body.join('\n'))}\n</code></pre>`);
        continue;
      }

      // table
      if (line.includes('|') && i + 1 < lines.length && RE.tableDelim.test(lines[i + 1])) {
        const head = splitRow(line);
        const align = splitRow(lines[i + 1]).map((c) => {
          const l = c.startsWith(':');
          const r = c.endsWith(':');
          return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
        });
        if (head.length === align.length) {
          i += 2;
          const rows = [];
          while (i < lines.length && !RE.blank.test(lines[i]) && !interrupts(lines[i])) rows.push(splitRow(lines[i++]));
          out.push(this.table(head, align, rows, at));
          continue;
        }
      }

      // paragraph, or setext heading
      const para = [line];
      i++;
      let level = 0;
      while (i < lines.length && !RE.blank.test(lines[i])) {
        const s = lines[i].match(RE.setext);
        if (s) {
          level = s[1][0] === '=' ? 1 : 2;
          i++;
          break;
        }
        if (interrupts(lines[i])) break;
        if (lines[i].includes('|') && i + 1 < lines.length && RE.tableDelim.test(lines[i + 1])
          && splitRow(lines[i]).length === splitRow(lines[i + 1]).length) break;
        para.push(lines[i]);
        i++;
      }
      const text = para.map((l) => l.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '');
      if (level) out.push(this.heading(level, text, at));
      else if (tight) out.push(this.inline(text));
      else out.push(`<p${at}>${this.inline(text)}</p>`);
    }
    return out.join('\n');
  }

  heading(level, text, at) {
    const html = this.inline(text);
    let slug = slugify(html);
    const n = this.slugs.get(slug) ?? 0;
    this.slugs.set(slug, n + 1);
    if (n) slug = `${slug}-${n}`;
    return `<h${level}${at} id="${ID_PREFIX}${escapeHtml(slug)}"><a class="anchor" href="#${escapeHtml(slug)}" aria-hidden="true">#</a>${html}</h${level}>`;
  }

  quote(body, base, at) {
    const first = body.findIndex((l) => !RE.blank.test(l));
    const alert = first >= 0 && body[first].match(/^ {0,3}\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i);
    if (alert) {
      const kind = alert[1].toLowerCase();
      const rest = body.slice(first + 1);
      const inner = this.blocks(rest, base < 0 ? -1 : base + first + 1, false);
      return `<div class="alert alert-${kind}"${at}><p class="alert-title">${ALERTS[kind]}</p>\n${inner}</div>`;
    }
    return `<blockquote${at}>\n${this.blocks(body, base, false)}\n</blockquote>`;
  }

  table(head, align, rows, at) {
    const cell = (tag, text, k) => `<${tag}${align[k] ? ` align="${align[k]}"` : ''}>${this.inline(text)}</${tag}>`;
    const tr = (cells, tag) => `<tr>${align.map((_, k) => cell(tag, cells[k] ?? '', k)).join('')}</tr>`;
    const body = rows.length ? `\n<tbody>\n${rows.map((r) => tr(r, 'td')).join('\n')}\n</tbody>` : '';
    return `<table${at}>\n<thead>\n${tr(head, 'th')}\n</thead>${body}\n</table>`;
  }

  /** Parses the list starting at lines[i]; appends its HTML; returns the next line. */
  list(lines, i, base, top, out) {
    const first = listMarker(lines[i]);
    const items = [];
    let loose = false;
    let sawBlankBetween = false;
    while (i < lines.length) {
      const lm = listMarker(lines[i]);
      if (!lm || lm.ordered !== first.ordered || lm.char !== first.char || lm.indent >= first.width + first.pad) break;
      if (sawBlankBetween) loose = true;
      const { content, first: firstLine } = itemStart(lm);
      const start = i;
      const body = [firstLine];
      let tail = null; // made when a lazy line first needs it
      i++;
      let blankRun = 0;
      while (i < lines.length) {
        const l = lines[i];
        let add = null;
        if (RE.blank.test(l)) {
          blankRun++;
          add = '';
        } else if (indentOf(l) >= content) {
          add = l.slice(content);
          blankRun = 0;
        } else if (!blankRun && !listMarker(l) && !interrupts(l) && (tail ??= this.tail(body)).open) {
          add = l.trimStart(); // lazy continuation of the item's open paragraph
        } else break;
        body.push(add);
        tail?.push(add);
        i++;
      }
      // trailing blank lines separate this item from the next one (or end the list)
      let trailing = 0;
      while (body.length > 1 && RE.blank.test(body[body.length - 1])) { body.pop(); trailing++; }
      sawBlankBetween = trailing > 0;
      items.push({ body, line: base < 0 ? -1 : base + start });
      if (trailing && !(i < lines.length && listMarker(lines[i]))) {
        // the list may still continue after the blank lines with another item
        break;
      }
    }
    // A blank line between two of an item's own blocks also makes the list loose; not one
    // inside a fence, an HTML block or a nested list (which it may make loose instead).
    for (const it of items) {
      if (loose) break;
      if (!it.body.some((l, k) => k && RE.blank.test(l))) continue;
      const tail = this.tail();
      for (let k = 0; k < it.body.length; k++) {
        const l = it.body[k];
        if (k && RE.blank.test(it.body[k - 1]) && !RE.blank.test(l) && !tail.continues(l)) { loose = true; break; }
        tail.push(l);
      }
    }
    const tag = first.ordered ? 'ol' : 'ul';
    const start = first.ordered && first.start !== 1 ? ` start="${first.start}"` : '';
    const hasTasks = items.some((it) => /^\[[ xX]\](?:[ \t]|$)/.test(it.body[0]));
    const lis = items.map((it) => {
      let cls = '';
      let box = '';
      const t = it.body[0].match(/^\[([ xX])\](?:[ \t]+|$)/);
      if (t) {
        cls = ' class="task-list-item"';
        const checked = t[1] !== ' ' ? ' checked' : '';
        box = `<input type="checkbox" class="task-list-item-checkbox"${checked}${it.line >= 0 ? ` data-line="${it.line}"` : ''} disabled> `;
        it.body[0] = it.body[0].slice(t[0].length);
      }
      const inner = this.blocks(it.body, it.line, false, !loose);
      return `<li${cls}${top && it.line >= 0 ? ` data-line="${it.line}"` : ''}>${box}${inner}</li>`;
    });
    const at = this.attrLine(items[0].line, top);
    out.push(`<${tag}${at}${start}${hasTasks ? ' class="contains-task-list"' : ''}>\n${lis.join('\n')}\n</${tag}>`);
    return i;
  }

  // -------------------------------------------------------------- inline

  inline(text, noLinks = false) {
    this.inlineDepth++;
    try {
      return this.inlineAt(text, noLinks);
    } finally {
      this.inlineDepth--;
    }
  }

  inlineAt(text, noLinks) {
    const nodes = [];
    const push = (t, v) => {
      const last = nodes[nodes.length - 1];
      if (t === 'text' && last && last.t === 'text') last.v += v;
      else nodes.push({ t, v });
    };
    // Built when first needed, so that each look-ahead is quick instead of a scan to the
    // end of the text from every backtick or bracket (which made some inputs quadratic).
    let runs = null;
    let brackets = null;
    let commentEnd = -1;
    const codeEnd = (from, len) => (runs ??= codeRuns(text))(from, len);
    const ctx = { text, codeEnd, close: (p) => (brackets ??= matchBrackets(text, codeEnd))(p) };
    const nested = this.inlineDepth > MAX_INLINE_DEPTH;
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        const d = text[i + 1];
        if (d === '\n') { trimTrailing(nodes); push('html', '<br>\n'); i += 2; continue; }
        if (d && /[!-/:-@[-`{-~]/.test(d)) { push('text', escapeHtml(d)); i += 2; continue; }
        push('text', '\\');
        i++;
        continue;
      }
      if (c === '`') {
        const run = text.slice(i).match(/^`+/)[0];
        const end = codeEnd(i + run.length, run.length);
        if (end < 0) { push('text', run); i += run.length; continue; }
        let code = text.slice(i + run.length, end).replace(/\n/g, ' ');
        if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        push('html', `<code>${escapeHtml(code)}</code>`);
        i = end + run.length;
        continue;
      }
      if (c === '$') {
        // $`…`$: the code span's content is the TeX
        if (text[i + 1] === '`') {
          const run = text.slice(i + 1).match(/^`+/)[0];
          const end = codeEnd(i + 1 + run.length, run.length);
          if (end > i + 1 + run.length && text[end + run.length] === '$') {
            push('html', mathInline(text.slice(i + 1 + run.length, end)));
            i = end + run.length + 1;
            continue;
          }
        }
        const len = text[i + 1] === '$' ? 2 : 1;
        const end = text[i + len] === '$' ? -1 : findMathEnd(text, i, len);
        if (end > 0) {
          push('html', mathInline(text.slice(i + len, end)));
          i = end + len;
          continue;
        }
        push('text', text.slice(i, i + len));
        i += len;
        continue;
      }
      if (c === ':') {
        EMOJI_NAME.lastIndex = i;
        const m = EMOJI_NAME.exec(text);
        if (m && Object.hasOwn(EMOJI, m[1])) {
          push('text', EMOJI[m[1]]);
          i += m[0].length;
          continue;
        }
        push('text', ':');
        i++;
        continue;
      }
      if (c === '<') {
        const rest = text.slice(i);
        let m = rest.match(/^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/);
        if (m && !noLinks) {
          push('html', this.anchor(m[1], escapeHtml(m[1])));
          i += m[0].length;
          continue;
        }
        m = rest.match(/^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/);
        if (m && !noLinks) {
          push('html', `<a href="mailto:${escapeHtml(m[1])}">${escapeHtml(m[1])}</a>`);
          i += m[0].length;
          continue;
        }
        if (rest.startsWith('<!--')) {
          // a comment (hidden), up to the next -->; once there is none, none for later ones
          if (commentEnd !== -2 && commentEnd < i + 4) {
            commentEnd = text.indexOf('-->', i + 4);
            if (commentEnd < 0) commentEnd = -2;
          }
          if (commentEnd >= 0) {
            i = commentEnd + 3;
            continue;
          }
        }
        m = rest.match(INLINE_TAG);
        if (m) {
          push('html', sanitizeHtml(m[0]));
          i += m[0].length;
          continue;
        }
        push('text', '&lt;');
        i++;
        continue;
      }
      if (c === '&') {
        const m = text.slice(i).match(/^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/);
        if (m) {
          const dec = decodeEntities(m[0]);
          push('text', dec === m[0] ? '&amp;' + m[0].slice(1) : escapeHtml(dec));
          i += m[0].length;
          continue;
        }
        push('text', '&amp;');
        i++;
        continue;
      }
      if ((c === '[' || (c === '!' && text[i + 1] === '[')) && !(noLinks && c === '[')) {
        const r = nested ? null : this.link(ctx, i, c === '!');
        if (r) {
          push('html', r.html);
          i = r.end;
          continue;
        }
        push('text', c === '!' ? '![' : '[');
        i += c === '!' ? 2 : 1;
        continue;
      }
      if (c === '*' || c === '_' || c === '~') {
        const run = text.slice(i).match(c === '*' ? /^\*+/ : c === '_' ? /^_+/ : /^~+/)[0];
        const before = i > 0 ? text[i - 1] : ' ';
        const after = text[i + run.length] ?? ' ';
        const bs = SPACE.test(before);
        const as = SPACE.test(after);
        const bp = PUNCT.test(before);
        const ap = PUNCT.test(after);
        const left = !as && (!ap || bs || bp);
        const right = !bs && (!bp || as || ap);
        let open = left;
        let close = right;
        if (c === '_') {
          open = left && (!right || bp);
          close = right && (!left || ap);
        }
        if (c === '~' && run.length > 2) { open = false; close = false; }
        nodes.push({ t: 'delim', ch: c, n: run.length, orig: run.length, open, close });
        i += run.length;
        continue;
      }
      if (c === '\n') {
        const hard = trimTrailing(nodes) >= 2;
        push('html', hard ? '<br>\n' : '\n');
        i++;
        while (text[i] === ' ') i++;
        continue;
      }
      if (!noLinks && (c === 'h' || c === 'w') && (i === 0 || /[\s*_~(]/.test(text[i - 1]))) {
        const m = text.slice(i).match(/^(?:https?:\/\/|www\.)[^\s<]*/);
        if (m) {
          const url = trimAutolink(m[0]);
          if (url.length > (url.startsWith('www.') ? 4 : 8)) {
            push('html', this.anchor(url.startsWith('www.') ? 'http://' + url : url, escapeHtml(url)));
            i += url.length;
            continue;
          }
        }
      }
      // plain run of text
      let j = i + 1;
      while (j < n && !/[\\`<&[!*_~\nhw$:]/.test(text[j])) j++;
      push('text', escapeHtml(text.slice(i, j)));
      i = j;
    }
    emphasis(nodes);
    return nodes.map((nd) => (nd.t === 'delim' ? nd.before + nd.ch.repeat(nd.n) + nd.after : nd.v)).join('');
  }

  anchor(href, inner, title) {
    const url = this.opts.resolveLink ? this.opts.resolveLink(href) : href;
    if (!safeUrl(url)) return inner;
    const ext = /^https?:/i.test(url) ? ' rel="nofollow noopener" target="_blank"' : '';
    return `<a href="${escapeHtml(encodeUrl(url))}"${title ? ` title="${escapeHtml(title)}"` : ''}${ext}>${inner}</a>`;
  }

  image(src, alt, title) {
    if (!safeUrl(src, true)) return escapeHtml(alt);
    const resolved = this.opts.resolveImage ? this.opts.resolveImage(src) : { src };
    const extra = resolved.path ? ` data-path="${escapeHtml(resolved.path)}"` : '';
    return `<img src="${escapeHtml(encodeUrl(resolved.src))}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ''}${extra}>`;
  }

  link(ctx, i, isImage) {
    const { text } = ctx;
    const open = i + (isImage ? 2 : 1);
    const close = ctx.close(open - 1);
    if (close < 0) return null;
    const label = text.slice(open, close);

    // footnote reference
    if (!isImage && label.startsWith('^') && !/\s/.test(label)) {
      const key = normLabel(label.slice(1));
      const fn = this.footnotes.get(key);
      if (fn) {
        if (!fn.n) { fn.n = this.footOrder.length + 1; this.footOrder.push(key); }
        fn.refs = (fn.refs ?? 0) + 1;
        const id = `fnref-${fn.n}${fn.refs > 1 ? '-' + fn.refs : ''}`;
        return { html: `<sup><a href="#fn-${fn.n}" id="${ID_PREFIX}${id}" class="footnote-ref">${fn.n}</a></sup>`, end: close + 1 };
      }
    }

    let url = null;
    let title = null;
    let end = close + 1;
    if (text[end] === '(') {
      const d = parseDestination(text, end + 1);
      if (d) ({ url, title, end } = d);
    }
    if (url === null) {
      let key = null;
      const m = text.slice(end).match(/^\[((?:[^[\]\\]|\\.){0,999})\]/);
      if (m && m[1].trim()) { key = m[1]; end += m[0].length; } else {
        if (m) end += m[0].length;
        key = label;
      }
      const ref = this.refs.get(normLabel(key));
      if (!ref) return null;
      url = ref.url;
      title = ref.title;
    }
    if (isImage) {
      const alt = this.inline(label, true).replace(/<[^>]*>/g, '');
      return { html: this.image(url, decodeEntities(alt), title), end };
    }
    const inner = this.inline(label, true);
    return { html: this.anchor(url, inner, title), end };
  }

  footnoteSection() {
    if (!this.footOrder.length) return '';
    // Rendering a footnote can number another one, referenced only from footnotes: so the
    // loop re-reads footOrder's length, and the list is built once every body is rendered
    // (a body may also add a back reference to a footnote rendered before it).
    const bodies = [];
    for (let k = 0; k < this.footOrder.length; k++) {
      bodies.push(this.blocks(this.footnotes.get(this.footOrder[k]).lines, -1, false));
    }
    const items = this.footOrder.map((key, k) => {
      const fn = this.footnotes.get(key);
      const backs = Array.from({ length: fn.refs }, (_, r) => `<a href="#fnref-${fn.n}${r ? '-' + (r + 1) : ''}" class="footnote-backref" aria-label="back to reference">↩</a>`).join(' ');
      const body = bodies[k];
      return `<li id="${ID_PREFIX}fn-${fn.n}">${body.endsWith('</p>') ? body.slice(0, -4) + ` ${backs}</p>` : `${body} ${backs}`}</li>`;
    });
    return `<section class="footnotes"><h2 class="sr-only">Footnotes</h2><ol>\n${items.join('\n')}\n</ol></section>`;
  }
}

// ---------------------------------------------------------------- inline helpers

// GitHub typesets math with MathJax and draws Mermaid diagrams with a script of its own; this
// page loads neither, so it shows their source, set apart (and only GitHub's renderer draws
// them). The classes are the renderer's own: the sanitiser does not let documents use them.
const mathBlock = (tex, at) => `<div class="math math-display"${at}>${escapeHtml(tex)}</div>`;
const mathInline = (tex) => `<span class="math math-inline">${escapeHtml(tex)}</span>`;
const mermaidBlock = (pre, at) => `<div class="mermaid-source"${at}><p class="mermaid-note">Mermaid diagram — shown by GitHub; <button type="button" class="mermaid-switch" data-renderer="github">switch the renderer to GitHub (exact)</button> to see it</p>${pre}</div>`;

const isAlnum = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/**
 * Where inline math opened by the `$` run text[i..i+len) closes, or -1. As on GitHub: the
 * opener is not preceded by a letter or digit and is followed by a non-space; the closer is
 * the next run of `$`, which must be as long, preceded by a non-space (not by a backslash)
 * and not followed by a letter or digit. So "$5 and $10" stays prose, and so does "$a\$b$"
 * (write $`a\$b`$ for that).
 */
function findMathEnd(text, i, len) {
  if (isAlnum(text[i - 1]) || !text[i + len] || /\s/.test(text[i + len])) return -1;
  const k = text.indexOf('$', i + len + 1);
  if (k < 0) return -1;
  let e = k;
  while (text[e] === '$') e++;
  return e - k === len && !/\s/.test(text[k - 1]) && text[k - 1] !== '\\' && !isAlnum(text[e]) ? k : -1;
}

/** A table row's cells. As in GFM, every unescaped `|` ends a cell, inside a code span too. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function trimTrailing(nodes) {
  const last = nodes[nodes.length - 1];
  if (!last || last.t !== 'text') return 0;
  const m = last.v.match(/ *$/);
  last.v = last.v.slice(0, last.v.length - m[0].length);
  return m[0].length;
}

/**
 * The backtick runs of `text`, for finding where code spans close: returns a function
 * (from, len) → the start of the first run of exactly `len` backticks at or after `from`, or
 * -1. (`from` is always just past a run, so the runs found there are whole.)
 */
function codeRuns(text) {
  const runs = new Map(); // length → starts, ascending
  for (let k = text.indexOf('`'); k >= 0; k = text.indexOf('`', k)) {
    const s = k;
    while (text[k] === '`') k++;
    if (!runs.has(k - s)) runs.set(k - s, []);
    runs.get(k - s).push(s);
  }
  return (from, len) => {
    const a = runs.get(len);
    if (!a) return -1;
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] < from) lo = mid + 1; else hi = mid;
    }
    return lo < a.length ? a[lo] : -1;
  };
}

/**
 * Pairs the brackets of `text[from…]` in one pass, skipping escapes and code spans: a map
 * from each `[` the pass reaches to its `]` (-1 if none). A `[` reached gets the answer a
 * scan for its own `]` from just after it would give, as the pass is then in the same state.
 */
function scanBrackets(text, codeEnd, from) {
  const close = new Map();
  const stack = [];
  for (let k = from; k < text.length; k++) {
    const ch = text[k];
    if (ch === '\\') { k++; continue; }
    if (ch === '`') {
      let r = k;
      while (text[r] === '`') r++;
      const end = codeEnd(r, r - k);
      k = end >= 0 ? end + (r - k) - 1 : r - 1;
      continue;
    }
    if (ch === '[') { stack.push(k); close.set(k, -1); } else if (ch === ']' && stack.length) close.set(stack.pop(), k);
  }
  return close;
}

/**
 * `[`'s position → the position of the `]` that ends its link text, or -1. One pass over the
 * text answers for every bracket; a `[` it did not reach (one it took to be inside a code
 * span, which the inline scan saw differently, say inside an HTML tag) gets a pass from there.
 */
function matchBrackets(text, codeEnd) {
  const passes = [];
  return (p) => {
    if (!passes.length) passes.push(scanBrackets(text, codeEnd, 0));
    for (const m of passes) if (m.has(p)) return m.get(p);
    const m = scanBrackets(text, codeEnd, p);
    passes.push(m);
    return m.get(p);
  };
}

const MAX_PAREN_DEPTH = 32; // in a link destination, as in cmark

function parseDestination(text, k) {
  const n = text.length;
  while (k < n && /[ \t\n]/.test(text[k])) k++;
  let url = '';
  if (text[k] === '<') {
    // <…>: no line break and no unescaped < inside
    let e = k + 1;
    while (e < n && text[e] !== '>') {
      if (text[e] === '\n' || text[e] === '<') return null;
      e += text[e] === '\\' ? 2 : 1;
    }
    if (e >= n) return null;
    url = text.slice(k + 1, e);
    k = e + 1;
  } else {
    let depth = 0;
    const s = k;
    while (k < n) {
      const ch = text[k];
      if (ch === '\\' && k + 1 < n) { k += 2; continue; }
      if (/[\s\u0000-\u001f]/.test(ch)) break;
      if (ch === '(') { if (++depth > MAX_PAREN_DEPTH) return null; } else if (ch === ')') { if (!depth) break; depth--; }
      k++;
    }
    url = text.slice(s, k);
  }
  const ws = k;
  while (k < n && /[ \t\n]/.test(text[k])) k++;
  let title = null;
  if (k > ws && /["'(]/.test(text[k])) {
    const paren = text[k] === '(';
    const q = paren ? ')' : text[k];
    let e = k + 1;
    while (e < n && text[e] !== q) {
      if (paren && text[e] === '(') return null; // (…) titles may not contain an unescaped (
      if (text[e] === '\\') e++;
      e++;
    }
    if (e >= n) return null;
    title = unescapeMd(decodeEntities(text.slice(k + 1, e)));
    k = e + 1;
    while (k < n && /[ \t\n]/.test(text[k])) k++;
  }
  if (text[k] !== ')') return null;
  return { url: unescapeMd(decodeEntities(url)), title, end: k + 1 };
}

/** GFM's extended autolink end: no trailing punctuation, unbalanced `)` or entity. */
function trimAutolink(url) {
  let open = 0;
  let close = 0;
  for (const ch of url) {
    if (ch === '(') open++;
    else if (ch === ')') close++;
  }
  let e = url.length;
  while (e > 0) {
    const ch = url[e - 1];
    if ('?!.,:*_~\'"'.includes(ch)) { e--; continue; }
    if (ch === ')' && close > open) { close--; e--; continue; }
    if (ch === ';') {
      let s = e - 2;
      while (s >= 0 && /[a-zA-Z0-9]/.test(url[s])) s--;
      if (s >= 0 && s < e - 2 && url[s] === '&') { e = s; continue; }
    }
    break;
  }
  return url.slice(0, e);
}

const EMOJI_NAME = /:([a-z0-9_+-]+):/y;

const unescapeMd = (s) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');
const encodeUrl = (s) => s.replace(/[\s<>"`]/g, (c) => encodeURIComponent(c));

/**
 * CommonMark's "process emphasis", plus GFM strikethrough with `~` and `~~`. The delimiter
 * runs form a linked list (spent ones are unlinked) and, as in the spec, openers_bottom
 * remembers per kind of closer how far back a search already failed, which keeps it linear.
 * Tags go onto the delimiter nodes themselves (open after, close before their characters).
 */
function emphasis(nodes) {
  const delims = nodes.filter((nd) => nd.t === 'delim');
  delims.forEach((d, k) => {
    d.pos = k;
    d.prev = delims[k - 1] ?? null;
    d.next = delims[k + 1] ?? null;
    d.before = '';
    d.after = '';
  });
  const unlink = (d) => {
    if (d.prev) d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev;
  };
  const bottom = new Map();
  let closer = delims[0] ?? null;
  while (closer) {
    if (!closer.close) { closer = closer.next; continue; }
    const key = closer.ch === '~' ? `~${closer.n}` : `${closer.ch}${closer.open ? 1 : 0}${closer.orig % 3}`;
    const floor = bottom.get(key) ?? -1;
    let o = closer.prev;
    for (; o && o.pos > floor; o = o.prev) {
      if (o.ch !== closer.ch || !o.open) continue;
      if (closer.ch === '~') {
        if (o.n === closer.n) break;
        continue;
      }
      if ((o.close || closer.open) && (o.orig + closer.orig) % 3 === 0 && !(o.orig % 3 === 0 && closer.orig % 3 === 0)) continue;
      break;
    }
    if (!o || o.pos <= floor) {
      bottom.set(key, closer.prev ? closer.prev.pos : -1);
      const next = closer.next;
      if (!closer.open) unlink(closer);
      closer = next;
      continue;
    }
    let tag;
    let use;
    if (closer.ch === '~') { tag = 'del'; use = closer.n; } else {
      use = o.n >= 2 && closer.n >= 2 ? 2 : 1;
      tag = use === 2 ? 'strong' : 'em';
    }
    // delimiters strictly between them can no longer match anything outside
    for (let d = o.next; d !== closer; d = d.next) unlink(d);
    o.n -= use;
    closer.n -= use;
    o.after = `<${tag}>` + o.after;
    closer.before += `</${tag}>`;
    if (!o.n) unlink(o);
    if (!closer.n) {
      const next = closer.next;
      unlink(closer);
      closer = next;
    }
  }
}

// ---------------------------------------------------------------- entry point

/**
 * @param {string} source Markdown
 * @param {{resolveLink?: (url: string) => string,
 *          resolveImage?: (url: string) => {src: string, path?: string}}} [opts]
 *   resolveLink and resolveImage rewrite relative URLs, so that a document in a
 *   repository can link to its neighbours and show their pictures.
 * @returns {string} HTML
 */
export function renderMarkdown(source, opts = {}) {
  const r = new Renderer(opts);
  let lines = String(source).replace(/\r\n?/g, '\n').replace(/\u0000/g, '�').split('\n').map(expandTabs);
  // YAML front matter (Jekyll, static site generators) is shown as a table-ish block.
  let front = '';
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    const end2 = lines.indexOf('...', 1);
    const e = end < 0 ? end2 : end2 < 0 ? end : Math.min(end, end2);
    if (e > 0) {
      front = `<pre class="front-matter" data-line="0"><code>${escapeHtml(lines.slice(1, e).join('\n'))}\n</code></pre>\n`;
      lines = [...Array(e + 1).fill(''), ...lines.slice(e + 1)];
    }
  }
  lines = r.collectDefs(lines);
  const body = r.blocks(lines, 0, true);
  return front + body + r.footnoteSection();
}
