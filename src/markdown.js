// A GitHub-flavoured Markdown renderer: Markdown source in, an HTML string out.
//
// Pure (no DOM), so it runs headless under `node --test`. It covers what README files and
// documentation actually use: ATX and setext headings, paragraphs, emphasis, strikethrough,
// code spans and blocks, block quotes (including GitHub's `> [!NOTE]` alerts), nested and
// task lists, tables, links and images (inline, reference, autolinks and bare URLs),
// footnotes, rules, hard breaks and raw HTML, which goes through `sanitizeHtml`.
//
// Every top-level block carries `data-line` (its first source line, 0-based), which the
// page uses to keep the editor and the preview scrolled to the same place, and every task
// list checkbox carries the line of its `[ ]` so that clicking it can tick the source.
//
// It is not a full CommonMark implementation: the block structure is found line by line
// with a few simplifications (lazy continuation lines, list item edge cases), while the
// inline layer follows the CommonMark delimiter algorithm for emphasis faithfully.

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
  'disabled', 'reversed', 'viewbox', 'd', 'fill', 'data-line', 'data-path', 'aria-hidden',
  'aria-label', 'role',
]);
// Whole elements whose content is not text a reader should see.
const DROP_CONTENT = /<(script|style|iframe|object|embed|noscript|template|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

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
    const value = a[2] ?? a[3] ?? a[4];
    if (value === undefined) { attrs.push(key); continue; }
    if ((key === 'href' || key === 'src' || key === 'cite') && !safeUrl(value, name === 'img' || name === 'source')) continue;
    if (key === 'srcset' && !value.split(',').every((s) => safeUrl(s.trim(), true))) continue;
    if (name === 'input' && key === 'type' && value.toLowerCase() !== 'checkbox') return '';
    attrs.push(`${key}="${escapeHtml(decodeEntities(value))}"`);
  }
  if (name === 'input') attrs.push('disabled');
  return `<${name}${attrs.map((a) => ' ' + a).join('')}${self ? ' /' : ''}>`;
}

/**
 * Raw HTML from the document, reduced to an allowlist of tags and attributes. Text between
 * tags is kept (a stray `<` is escaped); comments vanish.
 */
export function sanitizeHtml(html) {
  return String(html)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(DROP_CONTENT, '')
    .replace(/<\/?[a-zA-Z][\w-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<|>/g,
      (t) => (t === '<' ? '&lt;' : t === '>' ? '&gt;' : sanitizeTag(t)));
}

// ---------------------------------------------------------------- entities

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', middot: '·',
  times: '×', divide: '÷', deg: '°', plusmn: '±', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  harr: '↔', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', euro: '€', pound: '£',
  sect: '§', para: '¶', shy: '­', zwj: '‍', zwnj: '‌', ensp: ' ',
  emsp: ' ', thinsp: ' ', check: '✓', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
  epsilon: 'ε', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', phi: 'φ', omega: 'ω', infin: '∞',
  ne: '≠', le: '≤', ge: '≥', hearts: '♥', star: '☆',
};
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g;

export function decodeEntities(s) {
  return s.replace(ENTITY, (m, dec, hex, name) => {
    if (name) return NAMED[name] ?? m;
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
  fence: /^( {0,3})(`{3,}|~{3,})[ \t]*([^`]*?)[ \t]*$/,
  atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  quote: /^ {0,3}> ?/,
  bullet: /^( {0,3})([-+*])([ \t]+|$)(.*)$/,
  ordered: /^( {0,3})(\d{1,9})([.)])([ \t]+|$)(.*)$/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
  html: /^ {0,3}(?:<(?:[a-zA-Z][\w-]*)(?:[\s/>]|$)|<\/[a-zA-Z][\w-]*\s*>|<!--)/,
  indented: /^(?: {4}|\t)/,
  tableDelim: /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/,
  refDef: /^ {0,3}\[((?:[^\]\\]|\\.){1,999})\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+("[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/,
  footDef: /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?(.*)$/,
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

/** Does this line start a block that interrupts a paragraph? */
function interrupts(line) {
  if (RE.fence.test(line) || RE.atx.test(line) || RE.hr.test(line) || RE.quote.test(line)) return true;
  if (RE.html.test(line)) return true;
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

class Renderer {
  constructor(opts) {
    this.opts = opts;
    this.refs = new Map();
    this.footnotes = new Map();
    this.footOrder = [];
    this.slugs = new Map();
  }

  // Pull link reference and footnote definitions out of the document (outside code).
  collectDefs(lines) {
    const out = [];
    let fence = null;
    let foot = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (fence) {
        if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
        out.push(line);
        continue;
      }
      const f = line.match(RE.fence);
      if (f && !(f[2][0] === '`' && f[3].includes('`'))) {
        fence = f[2];
        foot = null;
        out.push(line);
        continue;
      }
      if (foot) {
        if (RE.blank.test(line) || /^ {2,}/.test(line)) {
          foot.push(line.replace(/^ {1,4}/, ''));
          out.push('');
          continue;
        }
        foot = null;
      }
      const fd = line.match(RE.footDef);
      if (fd) {
        const key = normLabel(fd[1]);
        foot = [fd[2]];
        if (!this.footnotes.has(key)) this.footnotes.set(key, { label: fd[1], lines: foot });
        out.push('');
        continue;
      }
      const prevBlank = i === 0 || RE.blank.test(lines[i - 1]) || RE.refDef.test(lines[i - 1]);
      const rd = prevBlank && line.match(RE.refDef);
      if (rd) {
        const key = normLabel(rd[1]);
        let url = rd[2];
        if (url.startsWith('<')) url = url.slice(1, -1);
        const title = rd[3] ? rd[3].slice(1, -1) : null;
        if (!this.refs.has(key)) this.refs.set(key, { url: unescapeMd(url), title: title && unescapeMd(title) });
        out.push('');
        continue;
      }
      out.push(line);
    }
    return out;
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
    const out = [];
    const ln = (i) => (base < 0 ? -1 : base + i);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (RE.blank.test(line)) { i++; continue; }
      const at = this.attrLine(ln(i), top);
      let m;

      // fenced code
      if ((m = line.match(RE.fence)) && !(m[2][0] === '`' && m[3].includes('`'))) {
        const indent = m[1].length;
        const fence = m[2];
        const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
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
        out.push(`<pre${at}${lang ? ` lang="${escapeHtml(lang)}"` : ''}><code${cls}>${escapeHtml(code)}${code ? '\n' : ''}</code></pre>`);
        continue;
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
        while (i < lines.length && !RE.blank.test(lines[i])) {
          if (RE.quote.test(lines[i])) body.push(lines[i].replace(RE.quote, ''));
          else if (body.length && !RE.blank.test(body[body.length - 1]) && !interrupts(lines[i])) body.push(lines[i]);
          else break;
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
      if (RE.html.test(line)) {
        const body = [];
        if (/^ {0,3}<!--/.test(line)) {
          while (i < lines.length) {
            body.push(lines[i]);
            i++;
            if (lines[i - 1].includes('-->')) break;
          }
        } else {
          while (i < lines.length && !RE.blank.test(lines[i])) body.push(lines[i++]);
        }
        const html = sanitizeHtml(body.join('\n'));
        if (html.trim()) out.push(top ? `<div class="html-block"${at}>${html}</div>` : html);
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
    return `<h${level}${at} id="${escapeHtml(slug)}"><a class="anchor" href="#${escapeHtml(slug)}" aria-hidden="true">#</a>${html}</h${level}>`;
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
      const pad = lm.text === '' ? 1 : lm.pad > 4 ? 1 : lm.pad;
      const content = lm.width + pad;
      const start = i;
      const body = [lm.pad > 4 ? ' '.repeat(lm.pad - 1) + lm.text : lm.text];
      i++;
      let blankRun = 0;
      while (i < lines.length) {
        const l = lines[i];
        if (RE.blank.test(l)) {
          blankRun++;
          body.push('');
          i++;
          continue;
        }
        const ind = indentOf(l);
        if (ind >= content) {
          body.push(l.slice(content));
          blankRun = 0;
          i++;
          continue;
        }
        // lazy continuation of the item's last paragraph
        if (!blankRun && !listMarker(l) && !interrupts(l) && !RE.blank.test(body[body.length - 1])
          && !RE.fence.test(body[0])) {
          body.push(l.trimStart());
          i++;
          continue;
        }
        break;
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
    // a blank line inside an item, between two of its blocks, also makes the list loose
    for (const it of items) {
      for (let k = 1; k < it.body.length - 1; k++) {
        if (RE.blank.test(it.body[k]) && it.body.slice(k + 1).some((b) => !RE.blank.test(b))) {
          if (!isInsideFence(it.body, k)) loose = true;
        }
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
    const nodes = [];
    const push = (t, v) => {
      const last = nodes[nodes.length - 1];
      if (t === 'text' && last && last.t === 'text') last.v += v;
      else nodes.push({ t, v });
    };
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
        const end = findCodeEnd(text, i + run.length, run.length);
        if (end < 0) { push('text', run); i += run.length; continue; }
        let code = text.slice(i + run.length, end).replace(/\n/g, ' ');
        if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        push('html', `<code>${escapeHtml(code)}</code>`);
        i = end + run.length;
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
        m = rest.match(/^(?:<\/?[a-zA-Z][\w-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<!--[\s\S]*?-->)/);
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
        const r = this.link(text, i, c === '!');
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
      while (j < n && !/[\\`<&[!*_~\nhw]/.test(text[j])) j++;
      push('text', escapeHtml(text.slice(i, j)));
      i = j;
    }
    emphasis(nodes);
    return nodes.map((nd) => (nd.t === 'delim' ? nd.ch.repeat(nd.n) : nd.v)).join('');
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

  link(text, i, isImage) {
    const open = i + (isImage ? 2 : 1);
    const close = findBracketEnd(text, open);
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
        return { html: `<sup><a href="#fn-${fn.n}" id="${id}" class="footnote-ref">${fn.n}</a></sup>`, end: close + 1 };
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
      const m = text.slice(end).match(/^\[((?:[^\]\\]|\\.)*)\]/);
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
    const items = this.footOrder.map((key) => {
      const fn = this.footnotes.get(key);
      const backs = Array.from({ length: fn.refs }, (_, k) => `<a href="#fnref-${fn.n}${k ? '-' + (k + 1) : ''}" class="footnote-backref" aria-label="back to reference">↩</a>`).join(' ');
      let body = this.blocks(fn.lines, -1, false);
      body = body.endsWith('</p>') ? body.slice(0, -4) + ` ${backs}</p>` : `${body} ${backs}`;
      return `<li id="fn-${fn.n}">${body}</li>`;
    });
    return `<section class="footnotes"><h2 class="sr-only">Footnotes</h2><ol>\n${items.join('\n')}\n</ol></section>`;
  }
}

// ---------------------------------------------------------------- inline helpers

function isInsideFence(body, k) {
  let open = false;
  for (let j = 0; j < k; j++) if (RE.fence.test(body[j])) open = !open;
  return open;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let code = 0;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (ch === '`') code ^= 1;
    if (ch === '|' && !code) { cells.push(cur.trim()); cur = ''; continue; }
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

function findCodeEnd(text, from, len) {
  let k = from;
  while (k < text.length) {
    const j = text.indexOf('`', k);
    if (j < 0) return -1;
    const run = text.slice(j).match(/^`+/)[0];
    if (run.length === len) return j;
    k = j + run.length;
  }
  return -1;
}

function findBracketEnd(text, from) {
  let depth = 0;
  for (let k = from; k < text.length; k++) {
    const ch = text[k];
    if (ch === '\\') { k++; continue; }
    if (ch === '`') {
      const run = text.slice(k).match(/^`+/)[0];
      const end = findCodeEnd(text, k + run.length, run.length);
      if (end >= 0) { k = end + run.length - 1; continue; }
      k += run.length - 1;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      if (!depth) return k;
      depth--;
    }
  }
  return -1;
}

function parseDestination(text, k) {
  const n = text.length;
  while (k < n && /[ \t\n]/.test(text[k])) k++;
  let url = '';
  if (text[k] === '<') {
    const e = text.indexOf('>', k);
    if (e < 0 || text.slice(k, e).includes('\n')) return null;
    url = text.slice(k + 1, e);
    k = e + 1;
  } else {
    let depth = 0;
    const s = k;
    while (k < n) {
      const ch = text[k];
      if (ch === '\\' && k + 1 < n) { k += 2; continue; }
      if (/[\s\u0000-\u001f]/.test(ch)) break;
      if (ch === '(') depth++;
      else if (ch === ')') { if (!depth) break; depth--; }
      k++;
    }
    url = text.slice(s, k);
  }
  const ws = k;
  while (k < n && /[ \t\n]/.test(text[k])) k++;
  let title = null;
  if (k > ws && /["'(]/.test(text[k])) {
    const q = text[k] === '(' ? ')' : text[k];
    let e = k + 1;
    while (e < n && text[e] !== q) { if (text[e] === '\\') e++; e++; }
    if (e >= n) return null;
    title = unescapeMd(decodeEntities(text.slice(k + 1, e)));
    k = e + 1;
    while (k < n && /[ \t\n]/.test(text[k])) k++;
  }
  if (text[k] !== ')') return null;
  return { url: unescapeMd(decodeEntities(url)), title, end: k + 1 };
}

function trimAutolink(url) {
  let u = url;
  for (;;) {
    const before = u;
    u = u.replace(/[?!.,:*_~'"]+$/, '');
    if (u.endsWith(')')) {
      const open = (u.match(/\(/g) || []).length;
      const close = (u.match(/\)/g) || []).length;
      if (close > open) u = u.slice(0, -1);
    }
    if (/&[a-zA-Z0-9]+;$/.test(u)) u = u.replace(/&[a-zA-Z0-9]+;$/, '');
    if (u === before) return u;
  }
}

const unescapeMd = (s) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');
const encodeUrl = (s) => s.replace(/[\s<>"`]/g, (c) => encodeURIComponent(c));

/** CommonMark's "process emphasis", plus GFM strikethrough with `~` and `~~`. */
function emphasis(nodes) {
  for (let ci = 0; ci < nodes.length; ci++) {
    const closer = nodes[ci];
    if (closer.t !== 'delim' || !closer.close || !closer.n) continue;
    let oi = ci - 1;
    for (; oi >= 0; oi--) {
      const o = nodes[oi];
      if (o.t !== 'delim' || o.ch !== closer.ch || !o.open || !o.n) continue;
      if (closer.ch === '~') {
        if (o.n === closer.n) break;
        continue;
      }
      if ((o.close || closer.open) && (o.orig + closer.orig) % 3 === 0 && !(o.orig % 3 === 0 && closer.orig % 3 === 0)) continue;
      break;
    }
    if (oi < 0) continue;
    const opener = nodes[oi];
    let tag;
    let use;
    if (closer.ch === '~') { tag = 'del'; use = closer.n; } else {
      use = opener.n >= 2 && closer.n >= 2 ? 2 : 1;
      tag = use === 2 ? 'strong' : 'em';
    }
    // delimiters strictly between them can no longer match anything outside
    for (let k = oi + 1; k < ci; k++) {
      if (nodes[k].t === 'delim') nodes[k] = { t: 'text', v: nodes[k].ch.repeat(nodes[k].n) };
    }
    opener.n -= use;
    closer.n -= use;
    nodes.splice(ci, 0, { t: 'html', v: `</${tag}>` });
    nodes.splice(oi + 1, 0, { t: 'html', v: `<${tag}>` });
    ci = oi + 1; // continue scanning from after the new opening tag; the closer may have more
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
