// Syntax colours for fenced code blocks in the live preview: source text in, HTML out.
//
// Pure (no DOM). It knows the languages README files show most (JavaScript/TypeScript,
// Python, shell, JSON, YAML, C/C++, Java, Rust, Go, HTML/XML, CSS, diff) at the level a
// reader notices: comments, strings, numbers, keywords, function names, and a few things of
// each language's own (diff lines, tags, shell variables, YAML keys). It emits nothing but
// escaped text and <span class="pl-…"> with the class names GitHub's highlighter uses, so
// the same stylesheet colours both renderers.
//
// Every tokenizer is a single left-to-right pass that only ever moves forward, with sticky
// regexes that cannot backtrack across more than a token, so time is linear in the input.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ESC[c]);
const span = (cls, s) => (s ? `<span class="${cls}">${esc(s)}</span>` : '');

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[a-zA-Z]*/y;

const stick = (re, s, i) => {
  re.lastIndex = i;
  const m = re.exec(s);
  return m ? m[0] : null;
};

// ---------------------------------------------------------------- C-like languages

const C_KW = 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool _Bool';
const CPP_KW = `${C_KW} alignas alignof and asm catch class concept constexpr consteval constinit co_await co_return co_yield decltype delete explicit export friend mutable namespace new noexcept not operator or override final private protected public requires static_assert static_cast dynamic_cast reinterpret_cast const_cast template this throw try typeid typename using virtual wchar_t char8_t char16_t char32_t auto`;
const JS_KW = 'async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield as';
const TS_KW = `${JS_KW} abstract declare enum implements interface keyof namespace private protected public readonly type infer is satisfies module override any unknown never string number boolean symbol bigint object`;
const JAVA_KW = 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public record return short static strictfp super switch synchronized this throw throws transient try var void volatile while yield sealed permits';
const RUST_KW = 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str';
const GO_KW = 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var';
const PY_KW = 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case';
const SH_KW = 'if then else elif fi for while until do done case esac in function select return local export readonly declare unset shift time';
const SH_BUILTIN = 'echo printf cd pwd exit source alias unalias set test read eval exec trap wait kill true false type command builtin let getopts umask';

/**
 * A language for the generic scanner.
 *  line: line comment starts; block: [open, close] comment pairs; quotes: string delimiters
 *  (a quote in `multi` may span lines); kw / consts: words; defs: keywords after which the
 *  next name is being defined (coloured as a function name); hash: `#` starts a comment only
 *  at a word boundary (shell); pre: C preprocessor lines; at: `@name` decorators/annotations.
 */
const C_LIKE = (kw, extra = {}) => ({
  line: ['//'], block: [['/*', '*/']], quotes: '"\'', multi: '', kw: words(kw),
  consts: words('true false null NULL nullptr'), defs: words('class struct enum union'), ...extra,
});

const LANGS = {
  c: C_LIKE(C_KW, { pre: true }),
  cpp: C_LIKE(CPP_KW, { pre: true }),
  java: C_LIKE(JAVA_KW, { at: true, defs: words('class interface enum record') }),
  js: C_LIKE(JS_KW, {
    quotes: '"\'`', multi: '`', consts: words('true false null undefined NaN Infinity'),
    defs: words('function class'),
  }),
  ts: C_LIKE(TS_KW, {
    quotes: '"\'`', multi: '`', at: true, consts: words('true false null undefined NaN Infinity'),
    defs: words('function class interface type enum namespace'),
  }),
  rust: C_LIKE(RUST_KW, { quotes: '"', rustChar: true, consts: words('true false None Some Ok Err'), defs: words('fn struct enum trait type mod union') }),
  go: C_LIKE(GO_KW, { quotes: '"\'`', multi: '`', consts: words('true false nil iota'), defs: words('func type') }),
  python: {
    line: ['#'], block: [], quotes: '"\'', multi: '', triple: true, kw: words(PY_KW), at: true,
    consts: words('True False None self cls NotImplemented Ellipsis __name__'), defs: words('def class'),
    prefixes: words('r u b f br rb fr rf'),
  },
  shell: {
    line: ['#'], hash: true, block: [], quotes: '"\'', multi: '"\'', kw: words(SH_KW),
    consts: words(SH_BUILTIN), defs: words('function'), shell: true,
  },
  json: { line: ['//'], block: [['/*', '*/']], quotes: '"', multi: '', kw: new Set(), consts: words('true false null'), defs: new Set(), json: true },
};

const ALIASES = {
  javascript: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'ts', ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  python: 'python', py: 'python', python3: 'python', py3: 'python', pyi: 'python', gyp: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', ksh: 'shell', shellscript: 'shell', 'shell-script': 'shell',
  json: 'json', jsonc: 'json', json5: 'json', geojson: 'json',
  yaml: 'yaml', yml: 'yaml',
  c: 'c', h: 'c',
  cpp: 'cpp', 'c++': 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp', hh: 'cpp', 'h++': 'cpp',
  java: 'java',
  rust: 'rust', rs: 'rust',
  go: 'go', golang: 'go',
  html: 'html', htm: 'html', xhtml: 'html', xml: 'html', svg: 'html', xsl: 'html', plist: 'html', vue: 'html',
  css: 'css', scss: 'css', less: 'css',
  diff: 'diff', patch: 'diff', udiff: 'diff',
};

/** The highlighter's name for a fenced block's language, or null when it has none. */
export function languageOf(lang) {
  const key = String(lang).toLowerCase();
  return Object.hasOwn(ALIASES, key) ? ALIASES[key] : null;
}

// 1 for a character that may start a name, 2 for a digit (which may continue one)
const WORD = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  WORD[c] = /[A-Za-z_$]/.test(ch) ? 1 : /\d/.test(ch) ? 2 : 0;
}
const wordAt = (s, i) => { const c = s.charCodeAt(i); return c < 128 ? WORD[c] : 0; };
const isWord = (s, i) => wordAt(s, i) > 0;

/** The characters (other than names and numbers) at which the scanner may find a token. */
function startsOf(L) {
  if (!L.starts) {
    L.starts = new Set([...L.line, ...L.block.map(([o]) => o), ...L.quotes].map((t) => t[0]));
    if (L.pre) L.starts.add('#');
    if (L.rustChar) L.starts.add("'");
    if (L.shell) L.starts.add('$');
    if (L.at) L.starts.add('@');
  }
  return L.starts;
}

/** The end of a string opened at s[i] (one past its closing quote, or where it gives up). */
function stringEnd(s, i, q, multi) {
  const n = s.length;
  let k = i + 1;
  while (k < n) {
    const ch = s[k];
    if (ch === '\\') { k += 2; continue; }
    if (ch === q) return k + 1;
    if (ch === '\n' && !multi) return k;
    k++;
  }
  return n;
}

/** Shell double-quoted strings and bare words: `$VAR`, `${…}`, `$1`, `$?` stand out. */
const SH_VAR = /\$(?:\{[^}\n]*\}|[A-Za-z_]\w*|[0-9#?@*!$-])/y;

function shellString(body) {
  let out = '';
  let last = 0;
  for (let k = 0; k < body.length; k++) {
    if (body[k] === '\\') { k++; continue; }
    if (body[k] !== '$') continue;
    const v = stick(SH_VAR, body, k);
    if (!v) continue;
    out += esc(body.slice(last, k)) + span('pl-smi', v);
    k += v.length - 1;
    last = k + 1;
  }
  return out + esc(body.slice(last));
}

function scan(s, L) {
  const n = s.length;
  let out = '';
  let plain = 0; // start of text not yet emitted
  let defining = false;
  let lineStart = true; // only whitespace so far on this line
  const flush = (to) => { if (to > plain) out += esc(s.slice(plain, to)); };
  const emit = (i, j, cls) => { flush(i); out += span(cls, s.slice(i, j)); plain = j; };
  const starts = startsOf(L);
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === '\n') { lineStart = true; i++; continue; }
    if (ch === ' ' || ch === '\t') { i++; continue; }
    const atLineStart = lineStart;
    lineStart = false;
    const w = wordAt(s, i);
    if (!w && ch !== '.' && !starts.has(ch)) {
      // punctuation: nothing starts here (most of what is not a name is this)
      if (defining && !/[*&<>:]/.test(ch)) defining = false;
      i++;
      continue;
    }

    // comments
    let hit = false;
    for (const lc of L.line) {
      if (s.startsWith(lc, i) && !(L.hash && i > 0 && !/\s/.test(s[i - 1]))) {
        let e = s.indexOf('\n', i);
        if (e < 0) e = n;
        emit(i, e, 'pl-c');
        i = e;
        hit = true;
        break;
      }
    }
    if (hit) continue;
    for (const [open, close] of L.block) {
      if (s.startsWith(open, i)) {
        let e = s.indexOf(close, i + open.length);
        e = e < 0 ? n : e + close.length;
        emit(i, e, 'pl-c');
        i = e;
        hit = true;
        break;
      }
    }
    if (hit) continue;

    // C preprocessor: the directive is a keyword, an #include's file a string
    if (L.pre && ch === '#' && atLineStart) {
      const m = /#[ \t]*[a-z]+/y;
      const d = stick(m, s, i);
      if (d) {
        emit(i, i + d.length, 'pl-k');
        i += d.length;
        if (/include|import/.test(d)) {
          const f = stick(/[ \t]*<[^>\n]*>/y, s, i);
          if (f) {
            const lt = i + f.indexOf('<');
            emit(lt, i + f.length, 'pl-s');
            i += f.length;
          }
        }
        continue;
      }
    }

    // strings
    if (L.quotes.includes(ch) && !(L.rustChar && ch === "'")) {
      let e;
      if (L.triple && s.startsWith(ch.repeat(3), i)) {
        e = s.indexOf(ch.repeat(3), i + 3);
        e = e < 0 ? n : e + 3;
      } else e = stringEnd(s, i, ch, L.multi.includes(ch));
      if (L.json) {
        const after = stick(/[ \t]*:/y, s, e);
        emit(i, e, after ? 'pl-ent' : 'pl-s');
      } else if (L.shell && ch === '"') {
        flush(i);
        out += `<span class="pl-s">${shellString(s.slice(i, e))}</span>`;
        plain = e;
      } else emit(i, e, 'pl-s');
      i = e;
      continue;
    }
    if (L.rustChar && ch === "'") {
      const c = stick(/'(?:\\(?:u\{[\da-fA-F]{1,6}\}|x[\da-fA-F]{2}|.)|[^\\'\n])'/y, s, i);
      if (c) { emit(i, i + c.length, 'pl-s'); i += c.length; continue; }
      const life = stick(/'[A-Za-z_]\w*/y, s, i);
      if (life) { emit(i, i + life.length, 'pl-k'); i += life.length; continue; }
    }

    // shell variables outside strings
    if (L.shell && ch === '$') {
      const v = stick(SH_VAR, s, i);
      if (v) { emit(i, i + v.length, 'pl-smi'); i += v.length; continue; }
    }

    // decorators and annotations
    if (L.at && ch === '@') {
      const id = stick(/@[A-Za-z_][\w.]*/y, s, i);
      if (id) { emit(i, i + id.length, 'pl-en'); i += id.length; continue; }
    }

    // numbers
    if ((w === 2 || ch === '.') && !(i > 0 && isWord(s, i - 1))) {
      const num = stick(NUMBER, s, i);
      if (num && !(L.shell && isWord(s, i + num.length))) {
        emit(i, i + num.length, 'pl-c1');
        i += num.length;
        continue;
      }
    }

    // words
    if (w === 1 && !(L.shell && ch === '$')) {
      let j = i + 1;
      while (j < n && isWord(s, j)) j++;
      const id = s.slice(i, j);
      // Python string prefixes: r"…", f'…', b"…"
      if (L.prefixes && L.prefixes.has(id.toLowerCase()) && L.quotes.includes(s[j])) {
        flush(i);
        plain = i;
        const q = s[j];
        let e;
        if (s.startsWith(q.repeat(3), j)) {
          e = s.indexOf(q.repeat(3), j + 3);
          e = e < 0 ? n : e + 3;
        } else e = stringEnd(s, j, q, false);
        emit(i, e, 'pl-s');
        i = e;
        continue;
      }
      if (L.shell && (s[i - 1] === '-' || s[i - 1] === '/' || s[i - 1] === '.' || s[j] === '=' || s[j] === '-' || s[j] === '.' || s[j] === '/')) {
        // an option, a path or an assignment, not a keyword
        i = j;
        continue;
      }
      if (defining && !L.kw.has(id)) {
        emit(i, j, 'pl-en');
        defining = false;
      } else if (L.kw.has(id)) {
        emit(i, j, 'pl-k');
        defining = L.defs.has(id);
      } else if (L.consts.has(id)) {
        emit(i, j, 'pl-c1');
      } else if (s[j] === '(' || (L.rustChar && s[j] === '!' && s[j + 1] !== '=')) {
        emit(i, L.rustChar && s[j] === '!' ? j + 1 : j, 'pl-en');
        if (L.rustChar && s[j] === '!') { i = j + 1; continue; }
      }
      i = j;
      continue;
    }

    if (defining && !/[\w*&<>:]/.test(ch)) defining = false;
    i++;
  }
  flush(n);
  return out;
}

// ---------------------------------------------------------------- line-based languages

function diff(s) {
  return s.split('\n').map((line) => {
    if (/^(?:diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) return span('pl-mh', line);
    if (line.startsWith('@@')) return span('pl-mdr', line);
    if (line.startsWith('+') || line.startsWith('>')) return `<span class="pl-mi1">${span('pl-mi1', line[0])}${esc(line.slice(1))}</span>`;
    if (line.startsWith('-') || line.startsWith('<')) return `<span class="pl-md">${span('pl-md', line[0])}${esc(line.slice(1))}</span>`;
    if (line.startsWith('!')) return span('pl-mc', line);
    return esc(line);
  }).join('\n');
}

const YAML_CONST = /^(?:true|false|yes|no|on|off|null|~|[+-]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|0x[\da-fA-F]+|\.inf|\.nan))$/i;

/** A YAML value: quoted strings, constants and numbers, plain text, a trailing comment. */
function yamlValue(v) {
  let out = '';
  let k = 0;
  const lead = v.match(/^[ \t]*/)[0];
  out += lead;
  k = lead.length;
  if (k >= v.length) return out;
  const ch = v[k];
  if (ch === '"' || ch === "'") {
    const e = stringEnd(v, k, ch, false);
    out += span('pl-s', v.slice(k, e));
    k = e;
  } else if (ch === '#') {
    return out + span('pl-c', v.slice(k));
  } else if (ch === '|' || ch === '>' || ch === '&' || ch === '*' || ch === '!') {
    const tok = v.slice(k).match(/^\S+/)[0];
    out += span(ch === '|' || ch === '>' ? 'pl-k' : 'pl-v', tok);
    k += tok.length;
  } else if (ch === '[' || ch === '{') {
    // flow collections: colour the scalars inside loosely
    return out + v.slice(k).split(/([[\]{},])/).map((p) => (/^[[\]{},]$/.test(p) ? esc(p) : yamlValue(p))).join('');
  } else {
    const c = v.slice(k).search(/[ \t]#/);
    const text = c < 0 ? v.slice(k) : v.slice(k, k + c + 1);
    const t = text.trimEnd();
    out += span(YAML_CONST.test(t) ? 'pl-c1' : 'pl-s', t) + text.slice(t.length);
    k += text.length;
  }
  const rest = v.slice(k);
  const c = rest.indexOf('#');
  if (c < 0) return out + esc(rest);
  return out + esc(rest.slice(0, c)) + span('pl-c', rest.slice(c));
}

/** Where a `key:` starting at k ends, and its colon; null when the line is no mapping entry. */
function yamlKey(line, k) {
  const ch = line[k];
  if (ch === undefined || '#[{'.includes(ch)) return null;
  let end;
  if (ch === '"' || ch === "'") {
    end = stringEnd(line, k, ch, false);
  } else {
    // the first ': ' (or ':' at the end) not inside a comment
    end = k;
    for (;;) {
      end = line.indexOf(':', end);
      if (end < 0) return null;
      if (line[end + 1] === undefined || line[end + 1] === ' ' || line[end + 1] === '\t') break;
      end++;
    }
    const hash = line.indexOf(' #', k);
    if (hash >= 0 && hash < end) return null;
  }
  const colon = stick(/[ \t]*:(?=[ \t]|$)/y, line, end);
  return colon ? { end, colon: end + colon.length - 1 } : null;
}

function yaml(s) {
  let block = -1; // indentation of a block scalar (| or >) being read, else -1
  return s.split('\n').map((line) => {
    const ind = line.match(/^ */)[0].length;
    if (block >= 0) {
      if (!line.trim() || ind > block) return span('pl-s', line);
      block = -1;
    }
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(line)) return span('pl-c1', line.slice(0, 3)) + yamlValue(line.slice(3));
    if (/^\s*#/.test(line)) return esc(line.match(/^\s*/)[0]) + span('pl-c', line.trimStart());
    const lead = stick(/[ \t]*(?:-(?:[ \t]+|$))*/y, line, 0);
    const key = yamlKey(line, lead.length);
    let out = esc(lead);
    let value;
    if (key) {
      const k = line.slice(lead.length, key.end).trimEnd();
      out += span('pl-ent', k) + esc(line.slice(lead.length + k.length, key.colon + 1));
      value = line.slice(key.colon + 1);
    } else value = line.slice(lead.length);
    if (/^[ \t]*[|>][-+0-9]*[ \t]*(?:#.*)?$/.test(value)) block = ind;
    return out + yamlValue(value);
  }).join('\n');
}

// ---------------------------------------------------------------- markup and stylesheets

const TAG = /<(\/?)([A-Za-z][\w:.-]*)/y;
const ATTR = /([ \t\n]+)([^\s"'>/=]+)(?:([ \t\n]*=[ \t\n]*)("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/y;

function markup(s) {
  const n = s.length;
  let out = '';
  let plain = 0;
  const flush = (to) => { if (to > plain) out += esc(s.slice(plain, to)); };
  let i = 0;
  // the next < and & (kept, so that a run of one does not rescan for the other each time)
  let lt = -1;
  let amp = -1;
  while (i < n) {
    if (lt !== n && lt < i) { lt = s.indexOf('<', i); if (lt < 0) lt = n; }
    if (amp !== n && amp < i) { amp = s.indexOf('&', i); if (amp < 0) amp = n; }
    if (lt === n && amp === n) break;
    if (amp < lt) {
      const ent = stick(/&(?:#\d+|#x[\da-fA-F]+|[A-Za-z]\w*);/y, s, amp);
      if (ent) { flush(amp); out += span('pl-c1', ent); plain = amp + ent.length; }
      i = amp + (ent ? ent.length : 1);
      continue;
    }
    i = lt;
    let e;
    if (s.startsWith('<!--', i)) {
      e = s.indexOf('-->', i + 4);
      e = e < 0 ? n : e + 3;
      flush(i); out += span('pl-c', s.slice(i, e)); plain = e; i = e;
      continue;
    }
    if (s.startsWith('<![CDATA[', i)) {
      e = s.indexOf(']]>', i);
      e = e < 0 ? n : e + 3;
      flush(i); out += span('pl-s', s.slice(i, e)); plain = e; i = e;
      continue;
    }
    if (s.startsWith('<!', i) || s.startsWith('<?', i)) {
      e = s.indexOf('>', i);
      e = e < 0 ? n : e + 1;
      flush(i); out += span('pl-c1', s.slice(i, e)); plain = e; i = e;
      continue;
    }
    const t = (TAG.lastIndex = i, TAG.exec(s));
    if (!t) { i++; continue; }
    flush(i);
    out += span('pl-kos', '<' + t[1]) + span('pl-ent', t[2]);
    i += t[0].length;
    for (;;) {
      ATTR.lastIndex = i;
      const a = ATTR.exec(s);
      if (!a) break;
      out += esc(a[1]) + span('pl-c1', a[2]);
      if (a[3]) out += esc(a[3]) + span('pl-s', a[4]);
      i += a[0].length;
    }
    const close = stick(/[ \t\n]*\/?>/y, s, i);
    if (close) { out += span('pl-kos', close); i += close.length; }
    plain = i;
  }
  flush(n);
  return out;
}

function css(s, scss) {
  const n = s.length;
  let out = '';
  let plain = 0;
  // for each open brace, whether it holds declarations (a rule) or more rules (@media …)
  const blocks = [];
  let groupAt = false; // the rule being read is an at-rule that holds rules
  let prelude = false; // reading an at-rule's prelude: `@media (max-width: 9px)` reads like declarations
  const inRule = () => blocks.length > 0 && blocks[blocks.length - 1];
  const flush = (to) => { if (to > plain) out += esc(s.slice(plain, to)); };
  const emit = (i, j, cls) => { flush(i); out += span(cls, s.slice(i, j)); plain = j; };
  // the next `;`, `{` or `}` at or after a position; it only moves forward, so it is found once
  let stop = -1;
  const nextStop = (from) => {
    if (stop < from) {
      stop = from;
      while (stop < n && !';{}'.includes(s[stop])) stop++;
    }
    return stop;
  };
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (s.startsWith('/*', i)) {
      let e = s.indexOf('*/', i + 2);
      e = e < 0 ? n : e + 2;
      emit(i, e, 'pl-c'); i = e; continue;
    }
    if (scss && s.startsWith('//', i)) {
      let e = s.indexOf('\n', i);
      if (e < 0) e = n;
      emit(i, e, 'pl-c'); i = e; continue;
    }
    if (ch === '"' || ch === "'") { const e = stringEnd(s, i, ch, false); emit(i, e, 'pl-s'); i = e; continue; }
    if (ch === '{') { blocks.push(!groupAt); groupAt = prelude = false; i++; continue; }
    if (ch === '}') { blocks.pop(); prelude = false; i++; continue; }
    if (ch === ';') { groupAt = prelude = false; i++; continue; }
    if (ch === '@' || (scss && ch === '$')) {
      const w = stick(/[@$][\w-]+/y, s, i);
      if (w) {
        if (ch === '@') prelude = true;
        if (ch === '@' && !inRule()) groupAt = /^@(?:media|supports|document|layer|container|scope|-moz-document)$/i.test(w);
        emit(i, i + w.length, ch === '@' ? 'pl-k' : 'pl-smi');
        i += w.length;
        continue;
      }
    }
    if (ch === '!') {
      const w = stick(/!\s*important/y, s, i);
      if (w) { emit(i, i + w.length, 'pl-k'); i += w.length; continue; }
    }
    // a declaration: property name, then its value up to ; or }
    const decls = inRule() || prelude;
    const word = decls && /[A-Za-z-]/.test(ch) && !/[\w-]/.test(s[i - 1] ?? '');
    const decl = word && stick(/-*[A-Za-z][\w-]*(?=[ \t]*:(?!:))/y, s, i);
    // `a:hover {` inside a nested rule is a selector, not a declaration
    if (decl && (prelude || s[nextStop(i)] !== '{')) { emit(i, i + decl.length, 'pl-c1'); i += decl.length; continue; }
    if (decls && /[\d.#+-]/.test(ch) && !/[\w-]/.test(s[i - 1] ?? '')) {
      const hex = ch === '#' && stick(/#[\da-fA-F]{3,8}\b/y, s, i);
      if (hex) { emit(i, i + hex.length, 'pl-c1'); i += hex.length; continue; }
      const num = stick(/[+-]?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/y, s, i);
      if (num) { emit(i, i + num.length, 'pl-c1'); i += num.length; continue; }
    }
    if (word) {
      const fn = stick(/[A-Za-z-][\w-]*(?=\()/y, s, i);
      if (fn) { emit(i, i + fn.length, 'pl-c1'); i += fn.length; continue; }
      const w = stick(/[\w-]+/y, s, i);
      i += w.length;
      continue;
    }
    if (!decls) {
      // selectors: classes, ids and pseudo-classes, and element names
      const sel = /[.#]/.test(ch) ? stick(/[.#][\w-]+/y, s, i)
        : ch === ':' ? stick(/::?[\w-]+/y, s, i)
          : /[A-Za-z*]/.test(ch) && !/[\w-]/.test(s[i - 1] ?? '') ? stick(/[A-Za-z][\w-]*|\*/y, s, i) : null;
      if (sel) { emit(i, i + sel.length, /^[.#:]/.test(sel) ? 'pl-e' : 'pl-ent'); i += sel.length; continue; }
    }
    i++;
  }
  flush(n);
  return out;
}

// ---------------------------------------------------------------- entry point

/**
 * @param {string} code a fenced block's content
 * @param {string} lang its info string's first word
 * @returns {string|null} HTML (escaped text and pl-* spans), or null when the language is
 *   not one this knows (the caller then shows the block plain)
 */
export function highlight(code, lang) {
  const name = languageOf(lang);
  if (!name) return null;
  const s = String(code);
  switch (name) {
    case 'diff': return diff(s);
    case 'yaml': return yaml(s);
    case 'html': return markup(s);
    case 'css': return css(s, /^(?:scss|less)$/i.test(lang));
    default: return scan(s, LANGS[name]);
  }
}
