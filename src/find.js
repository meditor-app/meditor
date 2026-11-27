// Find and replace in the source: where a query matches a text, and what replacing the
// matches gives. Pure, so tested headless; the find bar in ui.js only shows the result.
//
// A query is plain text or a regular expression (JavaScript's), optionally matching case
// and only whole words. Replacements in regular-expression mode may use $1, $<name>, $&
// and \n, \t as in most editors.

/** @typedef {{caseSensitive?: boolean, wholeWord?: boolean, regex?: boolean}} FindOptions */
/** @typedef {{start: number, end: number}} Match */

/** More than this many matches are not listed (the counter says "10000+"). */
export const MAX_MATCHES = 10000;

export const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The query as a global RegExp, or an error message for an invalid regular expression.
 * Tried with the `u` flag first (so that whole words and `.` know about non-ASCII letters),
 * then without it, since some patterns people type (`\-`, `\:`) are only valid without.
 */
export function compile(query, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
  if (!query) return { re: null, error: '' };
  const body = regex ? query : escapeRegExp(query);
  const flags = 'gm' + (caseSensitive ? '' : 'i');
  let error = '';
  for (const [u, word] of [['u', '[\\p{L}\\p{N}_]'], ['', '\\w']]) {
    const src = wholeWord ? `(?<!${word})(?:${body})(?!${word})` : body;
    try {
      return { re: new RegExp(src, flags + u), error: '' };
    } catch (e) {
      error ||= String(e.message).replace(/^Invalid regular expression: \/.*\/[a-z]*: /s, '');
    }
  }
  return { re: null, error };
}

/**
 * Past an empty match: one character on, or a whole surrogate pair. Without the `u` flag
 * (see compile) a regular expression would find the place between the two halves too;
 * neither Enter nor replace goes there, since replacing there would split the character.
 */
function advance(text, i) {
  if (i < text.length - 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) return i + 2;
    }
  }
  return i + 1;
}

/** Every match of `re` in `text`, in order; empty matches are listed too but never loop. */
function* scan(text, re) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    yield m;
    if (m[0] === '') re.lastIndex = advance(text, re.lastIndex);
    if (re.lastIndex > text.length) break;
  }
}

/**
 * All matches of `query` in `text`.
 * @returns {{matches: Match[], error: string, capped: boolean}}
 */
export function findAll(text, query, opts = {}) {
  const { re, error } = compile(query, opts);
  const matches = [];
  if (!re) return { matches, error, capped: false };
  for (const m of scan(text, re)) {
    if (matches.length >= MAX_MATCHES) return { matches, error: '', capped: true };
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return { matches, error: '', capped: false };
}

/** Index of the first match starting at or after `pos`, wrapping around; -1 if none. */
export function matchFrom(matches, pos) {
  if (!matches.length) return -1;
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].start < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo === matches.length ? 0 : lo;
}

/** Index of the last match starting before `pos`, wrapping around; -1 if none. */
export function matchBefore(matches, pos) {
  if (!matches.length) return -1;
  const i = matchFrom(matches, pos);
  const j = (i === 0 && matches[0].start >= pos ? matches.length : i) - 1;
  return j < 0 ? matches.length - 1 : j;
}

/**
 * The replacement for one regular-expression match: $1…$99, $<name>, $&, $`, $', $$
 * as in String.prototype.replace, and \n, \t, \\ for a line break, a tab, a backslash.
 */
export function expand(template, m) {
  return template.replace(/\$(?:(\$)|(&)|(`)|(')|(\d\d?)|<([^>]*)>)|\\([nt\\])/g,
    (all, dollar, amp, pre, post, num, name, esc) => {
      if (dollar) return '$';
      if (amp) return m[0];
      if (pre) return m.input.slice(0, m.index);
      if (post) return m.input.slice(m.index + m[0].length);
      if (esc) return esc === 'n' ? '\n' : esc === 't' ? '\t' : '\\';
      if (name !== undefined) return m.groups ? (m.groups[name] ?? '') : all;
      // two digits if there is such a group, else one digit and a literal one
      let n = +num;
      let rest = '';
      if (num.length === 2 && n >= m.length) {
        n = +num[0];
        rest = num[1];
      }
      return n >= 1 && n < m.length ? (m[n] ?? '') + rest : all;
    });
}

/** What replaces the match at `match`: the template expanded (regex mode) or as is. */
function replacementAt(text, match, query, template, opts) {
  if (!opts.regex) return template;
  const { re } = compile(query, opts);
  if (!re) return null;
  const sticky = new RegExp(re.source, re.flags.replace('g', '') + 'y');
  sticky.lastIndex = match.start;
  const m = sticky.exec(text);
  if (!m || m.index + m[0].length !== match.end) return null;
  return expand(template, m);
}

/**
 * Replace one match. Returns the new text and where the replacement is, or null when
 * `match` is no longer a match (the text changed under it).
 */
export function replaceOne(text, match, query, template, opts = {}) {
  const rep = replacementAt(text, match, query, template, opts);
  if (rep === null) return null;
  return {
    text: text.slice(0, match.start) + rep + text.slice(match.end),
    start: match.start,
    end: match.start + rep.length,
  };
}

/**
 * Replace every match (not capped at MAX_MATCHES).
 * @returns {{text: string, count: number, first: number, error: string}} `first` is where
 *   the first replacement starts (-1 if none).
 */
export function replaceAll(text, query, template, opts = {}) {
  const { re, error } = compile(query, opts);
  if (!re) return { text, count: 0, first: -1, error };
  const out = [];
  let last = 0;
  let count = 0;
  let first = -1;
  for (const m of scan(text, re)) {
    if (first < 0) first = m.index;
    out.push(text.slice(last, m.index), opts.regex ? expand(template, m) : template);
    last = m.index + m[0].length;
    count++;
  }
  out.push(text.slice(last));
  return { text: count ? out.join('') : text, count, first, error: '' };
}

/**
 * Where to look for the next match after replacing `match` (the result `r` of replaceOne):
 * past the replacement, and one character further for an empty match, which would else
 * be found again at the same place (`^` or `x*` replaced with nothing changes nothing).
 */
export function anchorAfter(r, match) {
  return match.end > match.start ? r.end : advance(r.text, r.end);
}

// ---------------------------------------------------------------- keyboard shortcuts
//
// Decided here, from a plain copy of the key event, so that layouts can be tested:
//   find: Ctrl+F (⌘F on macOS); replace: Ctrl+H or Ctrl+Alt+F (⌥⌘F; Ctrl+H deletes backward
//   on macOS, and ⌘H hides the browser); options: Alt+C, Alt+W, Alt+R (⌃⌥C, ⌃⌥W, ⌃⌥R on
//   macOS, where browsers take ⌥⌘C, ⌥⌘W, ⌥⌘R for themselves: Safari's ⌥⌘W closes the other
//   tabs; they are still taken when the page gets them).
// AltGr types characters, and Windows reports it as Ctrl+Alt: Czech AltGr+F is '['. Option
// on macOS types characters too (Polish Option+C is 'ć'). So off macOS a shortcut is the
// letter the key types, or on a layout without Latin letters (Russian 'а' on KeyF) the
// letter at its place; a symbol or Latin letter AltGr made never counts. On macOS, a
// shortcut with Option also needs ⌘ or ⌃, so it types nothing, and Option's character
// tells the letter (⌥F is 'ƒ'), else the key's place.

/**
 * @typedef {{key: string, code?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean,
 *   shiftKey?: boolean, altGraph?: boolean}} KeyInfo  altGraph: getModifierState('AltGraph')
 */

/**
 * The modifier that makes shortcuts is held: ⌘ on macOS, Ctrl elsewhere (the other one not
 * held). On macOS Ctrl+letter is the text field's own (⌃E end of line, ⌃K delete to it, ⌃O
 * open a line, ⌃H delete backward), so it is no shortcut of the page's.
 */
export const commandHeld = (e, mac) => (mac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey);

/** What Option makes of the letters on a US (or Dvorak, which follows the letters) Mac. */
const OPTION_CHARS = Object.fromEntries([...'å∫ç∂´ƒ©˙ˆ∆˚¬µ˜øπœ®ß†¨√∑≈¥Ω'].map((c, i) => [c, String.fromCharCode(97 + i)]));

/** The letter at the key's place on a US keyboard ('' for a key that is no letter). */
const placeLetter = (e) => (/^Key[A-Z]$/.test(e.code ?? '') ? e.code.slice(3).toLowerCase() : '');

/** The Latin letter a key stands for in a shortcut, lower case, or ''. */
function keyLetter(e, mac) {
  const k = typeof e.key === 'string' ? e.key : '';
  if (/^[a-z]$/i.test(k)) return k.toLowerCase();
  if (mac && e.altKey) {
    if (OPTION_CHARS[k]) return OPTION_CHARS[k];
    return [...k].length === 1 ? placeLetter(e) : ''; // 'Dead', 'Unidentified': nothing to go by
  }
  // a letter of another script: the layout has no Latin ones (AltGr makes symbols or Latin)
  return /^\p{L}$/u.test(k) && !/\p{Script=Latin}/u.test(k) ? placeLetter(e) : '';
}

/** 'find', 'replace' or null for a key in the editor. */
export function findShortcut(e, mac) {
  if (e.altGraph || e.shiftKey || !commandHeld(e, mac)) return null;
  const l = keyLetter(e, mac);
  if (!e.altKey) return l === 'f' ? 'find' : !mac && l === 'h' ? 'replace' : null;
  return l === 'f' ? 'replace' : null;
}

const OPTION_KEYS = { c: 'caseSensitive', w: 'wholeWord', r: 'regex' };

/** The find option ('caseSensitive', 'wholeWord', 'regex') a key in the find bar toggles, or null. */
export function findOptionKey(e, mac) {
  if (e.altGraph || !e.altKey) return null;
  // macOS: ⌃⌥ (or ⌥⌘, when the browser leaves it to the page); elsewhere Alt alone
  if (mac ? !(e.ctrlKey || e.metaKey) || (e.ctrlKey && e.metaKey) : e.ctrlKey || e.metaKey) return null;
  return OPTION_KEYS[keyLetter(e, mac)] ?? null;
}

/** A tooltip's shortcuts as written for macOS, when on it. */
export function shortcutText(text, mac) {
  if (!mac) return text;
  return text.replace(/Ctrl\+H|Ctrl\+Alt\+F/g, '⌥⌘F').replace(/Ctrl\+/g, '⌘').replace(/Alt\+([CWR])\b/g, '⌃⌥$1')
    .replace(/(⌥⌘F)(, ⌥⌘F)+/g, '$1');
}
