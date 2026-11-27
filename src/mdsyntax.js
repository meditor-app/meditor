// Light Markdown highlighting for the source panel: which parts of each line are markup —
// heading, list and quote markers, emphasis, code, links, HTML, front matter.
//
// Line by line, carrying a small state from one line to the next (inside a fenced block,
// front matter or an HTML comment; whether the line above was paragraph text; the list items
// it is in, where a fence may be indented more), so that the
// page re-tokenizes only the lines an edit touched and the few after it whose state
// changed. A line also looks at the next one, for setext headings (text over === or ---).
//
// It only ever colours: the layer it feeds lies exactly under the textarea's own
// (transparent) text, so nothing here may change the width of a character.

/**
 * @typedef {{first: boolean, fence: string, fq: boolean, front: boolean, comment: boolean, para: boolean,
 *   list: number[], lq: number}} LineState  list: the content columns of the list items the
 *   line may be in, outermost first (never changed in place); lq: how many quotes they are in
 * @typedef {[number, number, string]} Token  [from, to, classes] within the line
 */

/** Lines longer than this are not coloured (but still marked when in a code block). */
export const LONG_LINE = 5000;

/** The state before the first line. */
export const START = Object.freeze({ first: true, fence: '', fq: false, front: false, comment: false, para: false, list: Object.freeze([]), lq: 0 });

/** Two states that tokenize the following lines alike compare equal by this. */
export const stateKey = (s) => `${+s.first}${s.fence}|${+s.fq}${+s.front}${+s.comment}${+s.para}${s.list.join(',')}>${s.lq}`;

const RE = {
  front: /^---[ \t]*$/,
  frontEnd: /^(---|\.\.\.)[ \t]*$/,
  quote: /^(?: {0,3}>[ \t]?)+/,
  fence: /^([ \t]*)(`{3,}|~{3,})(.*)$/,
  atx: /^( {0,3})(#{1,6})(?=[ \t]|$)/,
  atxClose: /[ \t]+#+[ \t]*$/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  list: /^([ \t]*)([-*+]|\d{1,9}[.)])(?=[ \t]|$)/,
  task: /^([ \t]+)(\[[ xX]\])(?=[ \t]|$)/,
  def: /^( {0,3})(\[[^\]]+\]:)([ \t]*)(\S*)/,
  table: /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*$/,
};

/**
 * Tokenize one line. `next` is the line after it (undefined for the last).
 * @returns {{tokens: Token[], state: LineState}}
 */
export function tokenizeLine(line, state = START, next = undefined) {
  const out = [];
  const st = { ...state, first: false };
  const len = line.length;

  // front matter: only from the very first line, up to --- or ...
  if (state.first && RE.front.test(line)) {
    out.push([0, len, 'fm mk']);
    return { tokens: out, state: { ...st, front: true, para: false } };
  }
  if (state.front) {
    if (RE.frontEnd.test(line)) {
      out.push([0, len, 'fm mk']);
      return { tokens: out, state: { ...st, front: false } };
    }
    if (len) out.push([0, len, 'fm']);
    return { tokens: out, state: st };
  }

  // inside a fenced block, until a fence as long (a quoted fence also ends with its quote)
  if (state.fence) {
    const q = state.fq ? line.match(RE.quote) : null;
    if (!state.fq || q) {
      const at = q ? q[0].length : 0;
      const rest = line.slice(at);
      const f = rest.match(/^([ \t]*)(`{3,}|~{3,})[ \t]*$/);
      if (q) out.push([0, at, 'qt']);
      if (f && f[2][0] === state.fence[0] && f[2].length >= state.fence.length
        && fenceIndent(f[1], state, q ? quoteDepth(q[0]) : 0)) {
        out.push([at, len, 'fence']);
        return { tokens: out, state: { ...st, fence: '', fq: false } };
      }
      if (len > at) out.push([at, len, 'code']);
      return { tokens: out, state: st };
    }
    st.fence = '';
    st.fq = false;
  }

  // an HTML comment left open on an earlier line
  let from = 0;
  if (state.comment) {
    const e = line.indexOf('-->');
    if (e < 0) {
      if (len) out.push([0, len, 'html']);
      return { tokens: out, state: st };
    }
    out.push([0, e + 3, 'html']);
    from = e + 3;
    st.comment = false;
  }

  if (from === 0 && !line.trim()) {
    st.para = false;
    return { tokens: out, state: st };
  }

  // a very long line (minified HTML, a data: URL) stays plain: thousands of spans in it would
  // cost more at every keystroke than the colours are worth
  if (len > LONG_LINE) {
    if (from === 0 && !state.para) st.list = within(state.list, columns(line.match(/^[ \t]*/)[0]));
    st.para = from === 0;
    return { tokens: out, state: st };
  }

  // block quote markers, then whatever the quote holds
  let at = from;
  if (from === 0) {
    const q = line.match(RE.quote);
    if (q) {
      out.push([0, q[0].length, 'qt']);
      at = q[0].length;
    }
  }
  const quoted = at > 0 && from === 0;
  const body = line.slice(at);
  let m;
  st.para = false;
  // a quote marker alone: a blank line in the quote
  if (quoted && !body.trim()) return { tokens: out, state: st };
  // the list items this line is in: those it is indented into (or, below, all of them when
  // it carries on a paragraph); none when it is in another quote than they are
  const depth = from === 0 ? quoteDepth(line.slice(0, at)) : state.lq;
  const indent = columns(body.match(/^[ \t]*/)[0]);
  if (from === 0) {
    st.list = depth === state.lq ? within(state.list, indent) : START.list;
    st.lq = depth;
  }

  if (from === 0 && (m = body.match(RE.fence)) && !(m[2][0] === '`' && m[3].includes('`'))
    && fenceIndent(m[1], state, depth)) {
    out.push([at, len, 'fence']);
    st.fence = m[2];
    st.fq = quoted;
  } else if (from === 0 && (m = body.match(RE.atx))) {
    const markEnd = at + m[0].length;
    out.push([at + m[1].length, markEnd, 'hd mk']);
    const close = body.slice(m[0].length).match(RE.atxClose);
    const textEnd = close ? len - close[0].length : len;
    inline(line, markEnd, textEnd, 'hd', out, st);
    if (close) out.push([textEnd, len, 'hd mk']);
  } else if (from === 0 && state.para && RE.setext.test(body)) {
    out.push([at, len, 'hd mk']);
  } else if (from === 0 && RE.hr.test(body)) {
    out.push([at, len, 'mk']);
  } else if (from === 0 && (m = body.match(RE.list))) {
    const markEnd = at + m[0].length;
    out.push([at + m[1].length, markEnd, 'li']);
    // the item's content starts after the marker and 1 to 4 spaces (1 when there are more,
    // or nothing)
    const mark = columns(m[1]) + m[2].length;
    const after = body.slice(m[0].length);
    const gap = columns(after.match(/^[ \t]*/)[0], mark) - mark;
    const content = mark + (gap > 4 || !after.trim() ? 1 : gap);
    st.list = [...st.list, content];
    let t = markEnd;
    const task = line.slice(markEnd).match(RE.task);
    if (task) {
      t = markEnd + task[0].length;
      out.push([markEnd + task[1].length, t, 'tk']);
    }
    inline(line, t, len, '', out, st);
  } else if (from === 0 && (m = body.match(RE.def))) {
    const s = at + m[1].length;
    const e = s + m[2].length;
    out.push([s, e, 'ln']);
    if (m[4]) out.push([e + m[3].length, e + m[3].length + m[4].length, 'url']);
    inline(line, e + m[3].length + m[4].length, len, '', out, st);
  } else if (from === 0 && RE.table.test(body)) {
    out.push([at, len, 'mk']);
  } else {
    // paragraph text, perhaps the heading of a setext underline below
    const heading = from === 0 && next !== undefined && RE.setext.test(next.replace(RE.quote, ''))
      && !(quoted && !RE.quote.test(next));
    inline(line, at, len, heading ? 'hd' : '', out, st);
    st.para = from === 0;
    // carrying on a paragraph (in an item, or lazily, even out of its quote): still in them
    if (from === 0 && state.para) {
      st.list = state.list;
      st.lq = state.lq;
    }
  }
  return { tokens: out, state: st };
}

/**
 * Tokenize every line.
 * @returns {{tokens: Token[][], states: LineState[]}} states[i] is the state line i starts
 *   in, and states[lines.length] the one after the last
 */
export function tokenizeAll(lines) {
  let st = START;
  const states = [st];
  const tokens = [];
  for (let i = 0; i < lines.length; i++) {
    const r = tokenizeLine(lines[i], st, lines[i + 1]);
    tokens.push(r.tokens);
    states.push((st = r.state));
  }
  return { tokens, states };
}

/**
 * After an edit turned lines [a, oldEnd) into [a, newEnd) of `lines`, bring `tokens` and
 * `states` (as tokenizeAll gives them, for the text before) up to date, in place. It
 * tokenizes again from the line above the edit (a setext heading looks at the next line)
 * until the state after a line at or past the edit is what the line after it started in
 * before: from there on nothing changes. Gives up, returning -1, when that is more than
 * `limit` lines past the edit (a code fence opened above the rest of the document); the
 * caller then tokenizes everything. Otherwise returns the end of the lines tokenized again,
 * which start at max(0, a - 1).
 */
export function retokenize(lines, tokens, states, a, oldEnd, newEnd, limit = Infinity) {
  // shift the states after the edit to their new places, the lines in it unknown: from
  // newEnd on, each is what its line started in before (the stop condition), except that
  // when lines were only deleted, newEnd is a, whose state is still that of the line above:
  // `boundary` stands for it then
  const boundary = states[oldEnd];
  if (newEnd > a) {
    const fresh = new Array(newEnd - a - 1).fill(null);
    if (oldEnd === a) fresh.push(boundary);
    states.splice(a + 1, Math.max(0, oldEnd - a - 1), ...fresh);
  } else {
    states.splice(a + 1, oldEnd - a);
  }
  tokens.splice(a, oldEnd - a, ...new Array(newEnd - a).fill(null));
  let i = Math.max(0, a - 1);
  let st = states[i];
  const n = lines.length;
  while (i < n) {
    if (i > newEnd + limit) return -1;
    const r = tokenizeLine(lines[i], st, lines[i + 1]);
    tokens[i] = r.tokens;
    st = r.state;
    i++;
    const was = i === newEnd ? boundary : states[i];
    states[i] = st;
    if (i >= newEnd && stateKey(was) === stateKey(st)) break;
  }
  return i;
}

/** The column after `s` (spaces and tabs, tab stops every 4), starting at column `col`. */
function columns(s, col = 0) {
  for (const c of s) col = c === '\t' ? col + 4 - (col % 4) : col + 1;
  return col;
}

/** How many quotes a line's quote markers open. */
const quoteDepth = (q) => q.split('>').length - 1;

/** The list items (by content column) a line indented `indent` columns is still in. */
function within(list, indent) {
  let k = list.length;
  while (k && list[k - 1] > indent) k--;
  return k === list.length ? list : list.slice(0, k);
}

/**
 * Whether a fence may be indented `ws` in the state before its line, `depth` quotes deep: at
 * most 3 columns past the content of the list item it is in (or the margin); 4 make an
 * indented code block, or carry on a paragraph.
 */
function fenceIndent(ws, state, depth) {
  const col = columns(ws);
  const items = depth === state.lq ? within(state.list, col) : [];
  return col - (items.length ? items[items.length - 1] : 0) <= 3;
}

const PUNCT = /[!-/:-@[-`{-~]/;
const ALNUM = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const STOPS = /[\\`<[!*_~h]/g;
const TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*)?\/?>/y;
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>/y;
const BARE_URL = /https?:\/\/[^\s<]*[^\s<.,:;"')\]*_~]/y;

/** Add the inline tokens of line[from, to) to `out`, every one also carrying `base`. */
function inline(line, from, to, base, out, st) {
  const cls = (c) => (base ? `${base} ${c}` : c);
  let plain = from;
  const flush = (j) => {
    if (base && j > plain) out.push([plain, j, base]);
  };
  const emit = (s, e, c) => {
    flush(s);
    if (e > s) out.push([s, e, cls(c)]);
    plain = e;
  };
  let i = from;
  while (i < to) {
    STOPS.lastIndex = i;
    const hit = STOPS.exec(line);
    if (!hit || hit.index >= to) break;
    i = hit.index;
    const c = line[i];

    if (c === '\\') {
      if (i + 1 < to && PUNCT.test(line[i + 1])) {
        emit(i, i + 2, 'mk');
        i += 2;
      } else i++;
      continue;
    }

    if (c === '`') {
      let n = 1;
      while (line[i + n] === '`') n++;
      const run = '`'.repeat(n);
      let j = line.indexOf(run, i + n);
      while (j >= 0 && j + n <= to && line[j + n] === '`') {
        let k = j;
        while (line[k] === '`') k++;
        j = line.indexOf(run, k);
      }
      if (j >= 0 && j + n <= to) {
        emit(i, j + n, 'code');
        i = j + n;
      } else i += n;
      continue;
    }

    if (c === '<') {
      if (line.startsWith('<!--', i)) {
        const e = line.indexOf('-->', i + 4);
        if (e >= 0 && e + 3 <= to) {
          emit(i, e + 3, 'html');
          i = e + 3;
        } else {
          emit(i, to, 'html');
          st.comment = true;
          i = to;
        }
        continue;
      }
      AUTOLINK.lastIndex = i;
      if (AUTOLINK.test(line) && AUTOLINK.lastIndex <= to) {
        emit(i, AUTOLINK.lastIndex, 'url');
        i = AUTOLINK.lastIndex;
        continue;
      }
      TAG.lastIndex = i;
      if (TAG.test(line) && TAG.lastIndex <= to) {
        emit(i, TAG.lastIndex, 'html');
        i = TAG.lastIndex;
        continue;
      }
      i++;
      continue;
    }

    if (c === '[' || (c === '!' && line[i + 1] === '[')) {
      const open = c === '!' ? i + 1 : i;
      const close = matching(line, open, to, '[', ']');
      if (close > 0 && (line[close + 1] === '(' || line[close + 1] === '[')) {
        const end = matching(line, close + 1, to, line[close + 1], line[close + 1] === '(' ? ')' : ']');
        if (end > 0) {
          emit(i, open + 1, 'ln mk');
          inline(line, open + 1, close, cls('ln'), out, st);
          plain = close;
          emit(close, close + 2, 'ln mk');
          emit(close + 2, end, line[close + 1] === '(' ? 'url' : 'ln');
          emit(end, end + 1, 'ln mk');
          i = end + 1;
          continue;
        }
      }
      i++;
      continue;
    }

    if (c === 'h') {
      BARE_URL.lastIndex = i;
      if ((i === 0 || !ALNUM.test(line[i - 1])) && BARE_URL.test(line) && BARE_URL.lastIndex <= to) {
        emit(i, BARE_URL.lastIndex, 'url');
        i = BARE_URL.lastIndex;
      } else i++;
      continue;
    }

    if (c === '!') {
      i++;
      continue;
    }

    // * _ ~: emphasis, strong, strikethrough
    let n = 1;
    while (line[i + n] === c) n++;
    const after = line[i + n];
    const before = line[i - 1];
    const opens = after !== undefined && i + n < to && !SPACE.test(after) && !(c === '_' && before && ALNUM.test(before));
    let done = false;
    if (opens) {
      const lens = c === '~' ? (n <= 2 ? [n] : []) : [Math.min(n, 3), 2, 1].filter((l, k, a) => l <= n && a.indexOf(l) === k);
      for (const l of lens) {
        const j = closer(line, c, l, i + l + (n - l), to);
        if (j < 0) continue;
        const kind = c === '~' ? 'del' : l === 1 ? 'em' : l === 2 ? 'strong' : 'strong em';
        emit(i + n - l, i + n, 'mk');
        inline(line, i + n, j, cls(kind), out, st);
        plain = j;
        emit(j, j + l, 'mk');
        i = j + l;
        done = true;
        break;
      }
    }
    if (!done) i += n;
  }
  flush(to);
}

/** Where a run of exactly `l` × `c` closes emphasis, searching line[from, to); -1 if nowhere. */
function closer(line, c, l, from, to) {
  for (let j = from; j + l <= to; j++) {
    if (line[j] === '`') {
      // code spans take precedence over emphasis
      let n = 1;
      while (line[j + n] === '`') n++;
      const e = line.indexOf('`'.repeat(n), j + n);
      if (e >= 0 && e < to) j = e + n - 1;
      continue;
    }
    if (line[j] === '\\') { j++; continue; }
    if (line[j] !== c) continue;
    let n = 1;
    while (line[j + n] === c) n++;
    if (n >= l && j > from && !SPACE.test(line[j - 1]) && !(c === '_' && ALNUM.test(line[j + n] || ''))) {
      return j + n - l;
    }
    j += n - 1;
  }
  return -1;
}

/** The bracket closing the one at `at` (nesting allowed, escapes skipped), or -1. */
function matching(line, at, to, open, close) {
  let depth = 0;
  for (let j = at; j < to; j++) {
    const ch = line[j];
    if (ch === '\\') { j++; continue; }
    if (ch === '`' && open === '[') {
      // a code span may hold brackets
      let n = 1;
      while (line[j + n] === '`') n++;
      const e = line.indexOf('`'.repeat(n), j + n);
      if (e >= 0 && e < to) { j = e + n - 1; continue; }
    }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return j;
  }
  return -1;
}

/**
 * Split ranges of the whole text (find matches) into ranges per line.
 * @param {string[]} lines
 * @param {{start: number, end: number}[]} ranges sorted, not overlapping
 * @param {(index: number) => string} cls the class for the i-th range
 * @returns {Map<number, Token[]>} line number -> its pieces
 */
export function rangesByLine(lines, ranges, cls) {
  const by = new Map();
  let line = 0;
  let lineStart = 0;
  for (let k = 0; k < ranges.length; k++) {
    const { start, end } = ranges[k];
    if (end <= start) continue;
    while (line < lines.length - 1 && lineStart + lines[line].length < start) {
      lineStart += lines[line].length + 1;
      line++;
    }
    let l = line;
    let ls = lineStart;
    while (l < lines.length && ls < end) {
      const a = Math.max(start, ls) - ls;
      const b = Math.min(end, ls + lines[l].length) - ls;
      if (b > a) {
        if (!by.has(l)) by.set(l, []);
        by.get(l).push([a, b, cls(k)]);
      }
      ls += lines[l].length + 1;
      l++;
    }
  }
  return by;
}

const esc = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

/**
 * One line as HTML: the text, escaped, in spans carrying the classes of the tokens and
 * marks (find matches) over it. Both lists are sorted and do not overlap among themselves.
 */
export function lineHtml(line, tokens = [], marks = []) {
  if (!tokens.length && !marks.length) return esc(line);
  const cuts = new Set([0, line.length]);
  for (const [a, b] of tokens) { cuts.add(a); cuts.add(b); }
  for (const [a, b] of marks) { cuts.add(Math.min(a, line.length)); cuts.add(Math.min(b, line.length)); }
  const pts = [...cuts].sort((x, y) => x - y);
  let t = 0;
  let k = 0;
  let html = '';
  for (let p = 0; p < pts.length - 1; p++) {
    const a = pts[p];
    const b = pts[p + 1];
    if (b <= a) continue;
    while (t < tokens.length && tokens[t][1] <= a) t++;
    while (k < marks.length && marks[k][1] <= a) k++;
    const c = [];
    if (t < tokens.length && tokens[t][0] <= a) c.push(tokens[t][2]);
    if (k < marks.length && marks[k][0] <= a) c.push(marks[k][2]);
    const s = esc(line.slice(a, b));
    html += c.length ? `<span class="${c.join(' ')}">${s}</span>` : s;
  }
  return html;
}
