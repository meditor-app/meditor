// Editing commands on plain text and a selection — what the toolbar buttons and the
// keyboard shortcuts do. Pure: each takes {text, start, end} and returns a new one, so
// they are tested headless and the page only has to apply the result to the textarea.

/** @typedef {{text: string, start: number, end: number}} Sel */

const lineStart = (text, i) => text.lastIndexOf('\n', i - 1) + 1;
const lineEnd = (text, i) => {
  const j = text.indexOf('\n', i);
  return j < 0 ? text.length : j;
};

/** Bold, italic, code, strike…: wrap the selection, or unwrap it if already wrapped. */
export function wrap({ text, start, end }, before, after = before, placeholder = '') {
  const sel = text.slice(start, end);
  // "*" and "**" share a character: "**word**" is not italic, "***word***" is both
  const emph = before === after && /^([*_])\1?$/.test(before);
  const run = (s) => s.match(new RegExp(`^\\${before[0]}*`))[0].length;
  const has = (left, right) => {
    const r = Math.min(run(left), run(right));
    return before.length === 1 ? r % 2 === 1 : r >= 2;
  };
  const around = emph
    ? has([...text.slice(0, start)].reverse().join(''), text.slice(end))
    : text.slice(start - before.length, start) === before && text.slice(end, end + after.length) === after;
  const inside = emph
    ? sel.length >= 2 * before.length && has(sel, [...sel].reverse().join(''))
    : sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length;
  if (around) {
    return {
      text: text.slice(0, start - before.length) + sel + text.slice(end + after.length),
      start: start - before.length,
      end: end - before.length,
    };
  }
  if (inside) {
    const inner = sel.slice(before.length, sel.length - after.length);
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
  }
  // keep surrounding whitespace outside the markers: "**word **" is not bold
  const lead = sel.match(/^\s*/)[0];
  const trail = sel.slice(lead.length).match(/\s*$/)[0];
  const core = sel.slice(lead.length, sel.length - trail.length) || placeholder;
  const s = start + lead.length + before.length;
  return {
    text: text.slice(0, start) + lead + before + core + after + trail + text.slice(end),
    start: s,
    end: s + core.length,
  };
}

/** The lines the selection touches, as [from, to) offsets. */
function lineRange({ text, start, end }) {
  const from = lineStart(text, start);
  const to = lineEnd(text, end > start && text[end - 1] === '\n' ? end - 1 : end);
  return [from, to];
}

/** Rewrite each selected line with `fn(line, index)`; keeps the lines selected. */
export function mapLines(sel, fn) {
  const [from, to] = lineRange(sel);
  const lines = sel.text.slice(from, to).split('\n');
  const out = lines.map(fn).join('\n');
  const text = sel.text.slice(0, from) + out + sel.text.slice(to);
  if (sel.start === sel.end) {
    // a bare cursor follows the end of its line's change
    const delta = out.length - (to - from);
    const pos = Math.max(from, sel.start + delta);
    return { text, start: pos, end: pos };
  }
  return { text, start: from, end: from + out.length };
}

const LIST = /^(\s*)(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const QUOTE = /^(?:[ \t]*>[ \t]?)*/;
const BREAK = /^\s*([-*_])(?:\s*\1){2,}\s*$/;

/** The selected lines, and whether every non-blank one passes `test` (false if all are blank). */
function selectedLines(sel, test) {
  const [from, to] = lineRange(sel);
  const lines = sel.text.slice(from, to).split('\n');
  const nonBlank = lines.filter((l) => l.trim());
  return { lines, all: nonBlank.length > 0 && nonBlank.every(test) };
}

/** Split a line into its blockquote markers and the rest. */
const splitQuote = (l) => {
  const q = l.match(QUOTE)[0];
  return [q, l.slice(q.length)];
};

/** Apply `fn` to each selected line without its blockquote markers. */
const mapInQuote = (sel, fn) => mapLines(sel, (l) => {
  const [q, rest] = splitQuote(l);
  return q + fn(rest);
});

/**
 * Put list markers on the selected lines, keeping each line's blockquote markers and the
 * nesting: `marker(n)` gives the marker of the n-th item (1-based) at its level, and
 * children move with their parent's content column when the marker's width changes. A
 * line indented into the content of an item above it stays that item's continuation.
 */
function setListMarkers(sel, lines, marker) {
  const stack = []; // the items above: their content columns before and after
  const counts = [];
  let quote = null;
  return mapLines(sel, (l) => {
    const [q, rest] = splitQuote(l);
    if (!rest.trim() && lines.length > 1) return l;
    if (q !== quote) { stack.length = 0; counts.length = 0; quote = q; }
    const m = rest.match(LIST);
    const ind = m ? m[1].length : rest.match(/^\s*/)[0].length;
    while (stack.length && ind < stack.at(-1).oldContent) stack.pop();
    const top = stack.at(-1);
    const pad = ' '.repeat(top ? top.newContent + ind - top.oldContent : ind);
    if (!m && top) return q + pad + rest.slice(ind);
    const depth = stack.length;
    counts.length = depth + 1;
    counts[depth] = (counts[depth] ?? 0) + 1;
    const mk = marker(counts[depth]);
    // a task box is part of the item's content, not of its marker
    const width = (s) => s.replace(/\[[ xX]\]\s+$/, '').length;
    // (a plain line that becomes an item has no continuation lines: the next line is an item too)
    stack.push({ oldContent: m ? width(m[0]) : Infinity, newContent: pad.length + width(mk) });
    return q + pad + mk + rest.slice(m ? m[0].length : ind);
  });
}

/** A bullet item that is neither a task nor a thematic break. */
const isBullet = (rest) => {
  const m = rest.match(/^\s*[-+*]\s+/);
  return !!m && !BREAK.test(rest) && !/^\[[ xX]\](\s|$)/.test(rest.slice(m[0].length));
};

/** Toggle a blockquote; quoting several paragraphs keeps them in one quote. */
function toggleQuote(sel) {
  const { lines, all } = selectedLines(sel, (l) => /^\s*>/.test(l));
  const first = lines.findIndex((l) => l.trim());
  const last = lines.findLastIndex((l) => l.trim());
  return mapLines(sel, (l, i) => {
    if (all) return l.replace(/^\s*>[ \t]?/, '');
    if (!l.trim() && lines.length > 1) return i > first && i < last ? '>' : l;
    return '> ' + l;
  });
}

/** Toggle a prefix ("> ", "- ") on every selected line. */
export function togglePrefix(sel, prefix) {
  if (prefix === '> ') return toggleQuote(sel);
  const { lines, all } = selectedLines(sel, (l) => isBullet(splitQuote(l)[1]));
  if (all) return mapInQuote(sel, (r) => r.replace(/^(\s*)[-+*]\s+/, '$1'));
  return setListMarkers(sel, lines, () => prefix);
}

export function orderedList(sel) {
  const { lines, all } = selectedLines(sel, (l) => /^\s*\d+[.)]\s/.test(splitQuote(l)[1]));
  if (all) return mapInQuote(sel, (r) => r.replace(/^(\s*)\d+[.)]\s+/, '$1'));
  return setListMarkers(sel, lines, (n) => `${n}. `);
}

export function taskList(sel) {
  const { lines, all } = selectedLines(sel, (l) => /^\s*[-+*]\s+\[[ xX]\]\s/.test(splitQuote(l)[1]));
  if (all) return mapInQuote(sel, (r) => r.replace(/^(\s*)[-+*]\s+\[[ xX]\]\s+/, '$1'));
  return setListMarkers(sel, lines, () => '- [ ] ');
}

/** Set an ATX heading on the selected lines, or remove it if they all have this level. */
export function heading(sel, level) {
  const H = /^\s{0,3}(#{1,6})(?:\s+|$)/;
  const { lines, all } = selectedLines(sel, (l) => l.match(H)?.[1].length === level);
  return mapLines(sel, (l) => {
    if (!l.trim() && lines.length > 1) return l;
    const m = l.match(H);
    const body = m ? l.slice(m[0].length) : l;
    return all ? body : `${'#'.repeat(level)} ${body}`;
  });
}

/** `[selection](url)`, with the url selected so it can be typed over. */
export function link(sel, isImage = false) {
  const { text, start, end } = sel;
  const label = text.slice(start, end) || (isImage ? 'alt text' : 'text');
  const url = /^(https?:\/\/|www\.)\S+$/.test(label) ? label : 'url';
  const prefix = (isImage ? '!' : '') + `[${url === label ? (isImage ? 'alt text' : label) : label}](`;
  const ins = `${prefix}${url})`;
  const s = start + prefix.length;
  return { text: text.slice(0, start) + ins + text.slice(end), start: s, end: s + url.length };
}

export function codeBlock(sel) {
  const { text, start, end } = sel;
  const inner = text.slice(start, end);
  const pre = start > 0 && text[start - 1] !== '\n' ? '\n' : '';
  const block = `${pre}\`\`\`\n${inner}${inner && !inner.endsWith('\n') ? '\n' : ''}\`\`\`\n`;
  const s = start + pre.length + 3;
  return { text: text.slice(0, start) + block + text.slice(end), start: s, end: s };
}

export function table(sel) {
  const { text, start, end } = sel;
  const pre = start > 0 && text[start - 1] !== '\n' ? '\n\n' : start > 1 && text[start - 2] !== '\n' ? '\n' : '';
  // a line straight after a table is another row: leave a blank line before any text
  const post = end < text.length && text[end] !== '\n' ? '\n' : '';
  const t = '| Column | Column |\n| ------ | ------ |\n| cell   | cell   |\n';
  const s = start + pre.length + 2;
  return { text: text.slice(0, start) + pre + t + post + text.slice(end), start: s, end: s + 6 };
}

export function rule(sel) {
  const { text, start, end } = sel;
  const pre = start > 0 && text[start - 1] !== '\n' ? '\n\n' : '\n';
  const ins = `${pre}---\n\n`;
  const p = start + ins.length;
  return { text: text.slice(0, start) + ins + text.slice(end), start: p, end: p };
}

/** Tab / Shift-Tab: indent or outdent the selected lines (by two spaces, like list nesting). */
export function indent(sel, out = false) {
  const { text, start, end } = sel;
  if (!out && start === end && !LIST.test(text.slice(lineStart(text, start), lineEnd(text, start)))) {
    return { text: text.slice(0, start) + '  ' + text.slice(end), start: start + 2, end: start + 2 };
  }
  const r = mapLines(sel, (l) => (out ? l.replace(/^ {1,2}|^\t/, '') : '  ' + l));
  if (start === end) {
    const delta = r.text.length - text.length;
    const p = Math.max(lineStart(text, start), start + delta);
    return { text: r.text, start: p, end: p };
  }
  return r;
}

/**
 * Enter inside a list item: start the next item with the same marker (numbers count up,
 * a task starts unticked). Enter on an empty item ends the list instead.
 * @returns {Sel|null} null when Enter should just insert a newline
 */
export function continueList(sel) {
  const { text, start, end } = sel;
  if (start !== end) return null;
  const from = lineStart(text, start);
  const line = text.slice(from, start);
  const quote = line.match(/^(\s*>\s?)+/)?.[0] ?? '';
  const rest = line.slice(quote.length);
  if (BREAK.test(text.slice(from + quote.length, lineEnd(text, start)))) return null; // "* * *"
  const m = rest.match(/^(\s*)([-+*]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/);
  if (!m) {
    if (quote && rest.trim()) return insert(sel, '\n' + quote);
    if (quote && !rest.trim()) return { text: text.slice(0, from) + text.slice(start), start: from, end: from };
    return null;
  }
  if (!rest.slice(m[0].length).trim() && start === lineEnd(text, start)) {
    // empty item: end the list
    return { text: text.slice(0, from) + quote + text.slice(start), start: from + quote.length, end: from + quote.length };
  }
  const marker = m[3] ? `${+m[3] + 1}${m[4]}` : m[2];
  const task = m[6] ? '[ ] ' : '';
  return insert(sel, `\n${quote}${m[1]}${marker}${m[5]}${task}`);
}

function insert({ text, start, end }, s) {
  return { text: text.slice(0, start) + s + text.slice(end), start: start + s.length, end: start + s.length };
}

/** Tick or untick the task-list box on source line `line` (0-based). */
export function toggleTask(text, line) {
  const lines = text.split('\n');
  const l = lines[line];
  if (l === undefined) return text;
  // list and quote markers in any mix: "> - [ ]", "- > - [ ]"
  const m = l.match(/^((?:\s*(?:>\s?|(?:[-+*]|\d+[.)])\s+))*?\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\]/);
  if (!m) return text;
  lines[line] = m[1] + (m[2] === ' ' ? '[x]' : '[ ]') + l.slice(m[0].length);
  return lines.join('\n');
}

/** Words, as a reader would count them: without code blocks, front matter and markup. */
export function countWords(text) {
  const prose = text
    .replace(/\r\n?/g, '\n')
    .replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/, '') // front matter
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n?[\s\S]*?(?:^[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))/gm, ' ') // fences
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[A-Za-z][^<>]*>/g, ' ') // HTML tags, autolinks
    .replace(/\]\([^)\s]*(?:\s+(?:"[^"]*"|'[^']*'))?\)/g, '] ') // link and image targets
    .replace(/^[ \t]*\[[^\]\n]+\]:[ \t]*\S+.*$/gm, ' ') // link reference definitions
    .replace(/^((?:[ \t]*>)*[ \t]*(?:[-+*][ \t]+)?)\d+[.)](?=\s|$)/gm, '$1'); // list numbers
  const m = prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return m ? m.length : 0;
}
