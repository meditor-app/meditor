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
  if (text.slice(start - before.length, start) === before && text.slice(end, end + after.length) === after) {
    return {
      text: text.slice(0, start - before.length) + sel + text.slice(end + after.length),
      start: start - before.length,
      end: end - before.length,
    };
  }
  if (sel.startsWith(before) && sel.endsWith(after) && sel.length >= before.length + after.length) {
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

/** Toggle a prefix ("> ", "- ") on every selected line. */
export function togglePrefix(sel, prefix) {
  const [from, to] = lineRange(sel);
  const lines = sel.text.slice(from, to).split('\n');
  const all = lines.filter((l) => l.trim()).every((l) => l.startsWith(prefix));
  return mapLines(sel, (l) => {
    if (!l.trim() && lines.length > 1) return l;
    if (all) return l.slice(prefix.length);
    return prefix + (prefix === '> ' ? l : l.replace(LIST, '$1'));
  });
}

export function orderedList(sel) {
  const [from, to] = lineRange(sel);
  const lines = sel.text.slice(from, to).split('\n');
  const all = lines.filter((l) => l.trim()).every((l) => /^\s*\d+[.)]\s/.test(l));
  let n = 0;
  return mapLines(sel, (l) => {
    if (!l.trim() && lines.length > 1) return l;
    if (all) return l.replace(/^(\s*)\d+[.)]\s+/, '$1');
    n += 1;
    return `${n}. ${l.replace(LIST, '')}`;
  });
}

export function taskList(sel) {
  const [from, to] = lineRange(sel);
  const lines = sel.text.slice(from, to).split('\n');
  const all = lines.filter((l) => l.trim()).every((l) => /^\s*[-+*]\s+\[[ xX]\]\s/.test(l));
  return mapLines(sel, (l) => {
    if (!l.trim() && lines.length > 1) return l;
    if (all) return l.replace(/^(\s*)[-+*]\s+\[[ xX]\]\s+/, '$1');
    return `- [ ] ${l.replace(LIST, '')}`;
  });
}

/** Set (or with the same level, remove) an ATX heading on the cursor's line. */
export function heading(sel, level) {
  return mapLines(sel, (l) => {
    const m = l.match(/^\s{0,3}(#{1,6})\s+/);
    const body = m ? l.slice(m[0].length) : l;
    if (m && m[1].length === level) return body;
    return `${'#'.repeat(level)} ${body}`;
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
  const t = '| Column | Column |\n| ------ | ------ |\n| cell   | cell   |\n';
  const s = start + pre.length + 2;
  return { text: text.slice(0, start) + pre + t + text.slice(end), start: s, end: s + 6 };
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
  const m = l.match(/^(\s*(?:>\s?)*\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\]/);
  if (!m) return text;
  lines[line] = m[1] + (m[2] === ' ' ? '[x]' : '[ ]') + l.slice(m[0].length);
  return lines.join('\n');
}

/** Words, as a reader would count them. */
export function countWords(text) {
  const m = text.replace(/```[\s\S]*?```/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return m ? m.length : 0;
}
