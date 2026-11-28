// Syntax colours for code: fenced blocks in the preview (as HTML), and code files and fenced
// blocks in the source panel (as tokens, line by line).
//
// Pure (no DOM). It knows the languages repositories hold most (JavaScript/TypeScript,
// Python, shell, JSON, YAML, TOML, INI, C/C++, C#, Java, Kotlin, Swift, Rust, Go, Ruby, Lua,
// SQL, HTML/XML/SVG, CSS/SCSS, Makefile, Dockerfile, diff) at the level a reader notices:
// comments, strings, numbers, keywords, function names, and a few things of each language's
// own (diff lines, tags, shell variables, YAML keys, Make targets). It uses the class names
// GitHub's highlighter uses, so that the same stylesheet colours both renderers.
//
// It reads one line at a time, carrying a short string from one line to the next that says
// what the line above left open (a block comment, a multi-line string, a heredoc, a tag
// whose attributes go on, a YAML block scalar…; '' when nothing), so that the source panel
// re-tokenizes only the lines an edit touched and the few after it whose state changed (see
// mdsyntax.js, retokenize). Every tokenizer only ever moves forward through the line, with
// sticky regexes that cannot backtrack across more than a token, so time is linear.

/**
 * @typedef {[number, number, string]} Token [from, to, classes] within the line; classes is
 *   'pl-x', or 'pl-x pl-y' for a pl-y inside a pl-x (a variable in a string)
 */

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

// ---------------------------------------------------------------- languages

const C_KW = 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool _Bool';
const CPP_KW = `${C_KW} alignas alignof and asm catch class concept constexpr consteval constinit co_await co_return co_yield decltype delete explicit export friend mutable namespace new noexcept not operator or override final private protected public requires static_assert static_cast dynamic_cast reinterpret_cast const_cast template this throw try typeid typename using virtual wchar_t char8_t char16_t char32_t auto`;
const JS_KW = 'async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield as';
const TS_KW = `${JS_KW} abstract declare enum implements interface keyof namespace private protected public readonly type infer is satisfies module override any unknown never string number boolean symbol bigint object`;
const JAVA_KW = 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public record return short static strictfp super switch synchronized this throw throws transient try var void volatile while yield sealed permits';
const CS_KW = 'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw try typeof uint ulong unchecked unsafe ushort using virtual void volatile while var async await yield record init get set when where dynamic nameof';
const KOTLIN_KW = 'as break class continue do else for fun if in interface is object package return super this throw try typealias typeof val var when while by catch constructor finally get import init set where abstract annotation companion const crossinline data enum external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg';
const SWIFT_KW = 'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is super self Self throw throws try async await some any';
const RUST_KW = 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str';
const GO_KW = 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var';
const PY_KW = 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case';
const RUBY_KW = 'BEGIN END alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return super then undef unless until when while yield require require_relative include extend private protected public raise attr_accessor attr_reader attr_writer';
const LUA_KW = 'and break do else elseif end for function goto if in local not or repeat return then until while';
const SQL_KW = 'select from where insert into values update set delete create table drop alter add column index view join inner left right outer full cross on as and or not is in exists between like ilike group by order having limit offset union all distinct primary key foreign references default constraint unique check case when then else end begin commit rollback transaction with recursive returning if replace grant revoke database schema asc desc cascade trigger procedure function returns declare int integer smallint bigint varchar char text boolean date time timestamp serial real float double numeric decimal';
const SH_KW = 'if then else elif fi for while until do done case esac in function select return local export readonly declare unset shift time';
const SH_BUILTIN = 'echo printf cd pwd exit source alias unalias set test read eval exec trap wait kill true false type command builtin let getopts umask';
const DOCKER_KW = words('from run cmd label maintainer expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell as');
const MAKE_KW = words('ifeq ifneq ifdef ifndef else endif include -include sinclude define endef export unexport override vpath');

/**
 * A language for the generic scanner.
 *  line: line comment starts; block: [open, close] comment pairs; quotes: string delimiters
 *  (a quote in `multi` may span lines; any string may go on after a backslash at the end of
 *  a line); kw / consts: words; defs: keywords after which the next name is being defined
 *  (coloured as a function name); hash: `#` starts a comment only at a word boundary
 *  (shell); pre: C preprocessor lines; at: `@name` decorators/annotations (atCls their
 *  colour); triple: '''/""" strings; ci: keywords in any case; regex: /…/ literals (JS);
 *  sym: Ruby's :symbols; vars: what a variable looks like (shell, Make).
 */
const C_LIKE = (kw, extra = {}) => ({
  line: ['//'], block: [['/*', '*/']], quotes: '"\'', multi: '', kw: words(kw),
  consts: words('true false null NULL nullptr'), defs: words('class struct enum union'), ...extra,
});

/**
 * Shell variables: `$VAR`, `${…}`, `$1`, `$?`; and Make's `$(VAR)`, `$@`, `$<`, `$^`. (A
 * brace or parenthesis is looked for no further than a name could be: on `${${${…` each
 * try would read to the end of the line, and all of them together take quadratic time.)
 */
const SH_VAR = /\$(?:\{[^}\n]{0,200}\}|[A-Za-z_]\w*|[0-9#?@*!$-])/y;
const MAKE_VAR = /\$(?:\([^)\n]{0,200}\)|\{[^}\n]{0,200}\}|[A-Za-z_]\w*|[0-9#?@*!$<^+%|-])/y;
// a /regular expression/ literal, of at most 300 characters (for the same reason)
const REGEX = /\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n]){0,300}\]|[^/\\\n[]){1,300}\/[dgimsuyv]*/y;

const SHELL = {
  line: ['#'], hash: true, block: [], quotes: '"\'', multi: '"\'', kw: words(SH_KW),
  consts: words(SH_BUILTIN), defs: words('function'), shell: true, vars: SH_VAR,
};

const LANGS = {
  c: C_LIKE(C_KW, { pre: true }),
  cpp: C_LIKE(CPP_KW, { pre: true }),
  java: C_LIKE(JAVA_KW, { at: true, defs: words('class interface enum record') }),
  csharp: C_LIKE(CS_KW, { pre: true, at: false, defs: words('class struct interface enum record namespace') }),
  kotlin: C_LIKE(KOTLIN_KW, { at: true, triple: true, quotes: '"\'', consts: words('true false null'), defs: words('class fun interface object typealias') }),
  swift: C_LIKE(SWIFT_KW, { at: true, triple: true, consts: words('true false nil'), defs: words('class struct enum protocol func extension typealias') }),
  js: C_LIKE(JS_KW, {
    quotes: '"\'`', multi: '`', regex: true, consts: words('true false null undefined NaN Infinity'),
    defs: words('function class'),
  }),
  ts: C_LIKE(TS_KW, {
    quotes: '"\'`', multi: '`', regex: true, at: true, consts: words('true false null undefined NaN Infinity'),
    defs: words('function class interface type enum namespace'),
  }),
  rust: C_LIKE(RUST_KW, { quotes: '"', multi: '"', rustChar: true, consts: words('true false None Some Ok Err'), defs: words('fn struct enum trait type mod union') }),
  go: C_LIKE(GO_KW, { quotes: '"\'`', multi: '`', consts: words('true false nil iota'), defs: words('func type') }),
  python: {
    line: ['#'], block: [], quotes: '"\'', multi: '', triple: true, kw: words(PY_KW), at: true,
    consts: words('True False None self cls NotImplemented Ellipsis __name__'), defs: words('def class'),
    prefixes: words('r u b f br rb fr rf'),
  },
  ruby: {
    line: ['#'], block: [], quotes: '"\'`', multi: '"\'`', kw: words(RUBY_KW), at: true, atCls: 'pl-v', sym: true,
    consts: words('true false nil self __FILE__ __LINE__'), defs: words('def class module'),
  },
  lua: {
    line: ['--'], block: [['--[[', ']]']], quotes: '"\'', multi: '', kw: words(LUA_KW),
    consts: words('true false nil'), defs: words('function'),
  },
  sql: {
    line: ['--'], block: [['/*', '*/']], quotes: '\'"', multi: '\'', kw: words(SQL_KW), ci: true,
    consts: words('true false null'), defs: new Set(),
  },
  shell: SHELL,
  json: { line: ['//'], block: [['/*', '*/']], quotes: '"', multi: '', kw: new Set(), consts: words('true false null'), defs: new Set(), json: true },
};
// a Makefile's recipes: shell, with Make's variables
const MAKE_SHELL = { ...SHELL, vars: MAKE_VAR, kw: SHELL.kw };

const ALIASES = {
  javascript: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'ts', ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  python: 'python', py: 'python', python3: 'python', py3: 'python', pyi: 'python', pyw: 'python', gyp: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', ksh: 'shell', shellscript: 'shell', 'shell-script': 'shell',
  json: 'json', jsonc: 'json', json5: 'json', geojson: 'json', jsonl: 'json', webmanifest: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  ini: 'ini', cfg: 'ini', properties: 'ini', editorconfig: 'ini', gitconfig: 'ini', dosini: 'ini',
  c: 'c', h: 'c',
  cpp: 'cpp', 'c++': 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp', hh: 'cpp', 'h++': 'cpp', ino: 'cpp',
  csharp: 'csharp', cs: 'csharp', 'c#': 'csharp',
  java: 'java',
  kotlin: 'kotlin', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  rust: 'rust', rs: 'rust',
  go: 'go', golang: 'go',
  ruby: 'ruby', rb: 'ruby', gemspec: 'ruby', rake: 'ruby',
  lua: 'lua',
  sql: 'sql', mysql: 'sql', postgresql: 'sql', psql: 'sql', sqlite: 'sql', plsql: 'sql',
  html: 'html', htm: 'html', xhtml: 'html', xml: 'html', svg: 'html', xsl: 'html', xslt: 'html', xsd: 'html',
  plist: 'html', vue: 'html', rss: 'html', atom: 'html', csproj: 'html', fsproj: 'html', vbproj: 'html',
  props: 'html', targets: 'html', nuspec: 'html', resx: 'html', wsdl: 'html',
  css: 'css', scss: 'scss', less: 'scss',
  diff: 'diff', patch: 'diff', udiff: 'diff',
  make: 'make', makefile: 'make', mk: 'make', mak: 'make',
  dockerfile: 'dockerfile', docker: 'dockerfile', containerfile: 'dockerfile',
  gitignore: 'conf', ignore: 'conf', conf: 'conf',
};

/** The highlighter's name for a language (a fenced block's info string, a file extension), or null. */
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
    if (L.shell) { L.starts.add('$'); L.starts.add('<'); }
    if (L.at) L.starts.add('@');
    if (L.regex) L.starts.add('/');
    if (L.sym) L.starts.add(':');
  }
  return L.starts;
}

/** One past the quote closing a string whose text starts at `from`, or -1 when the line ends first. */
function closeQuote(s, from, q) {
  const n = s.length;
  for (let k = from; k < n; k++) {
    const ch = s[k];
    if (ch === '\\') { k++; continue; }
    if (ch === q) return k + 1;
  }
  return -1;
}

/** The end of a string opened at s[i] on this line (one past its closing quote, or the end). */
function stringEnd(s, i, q) {
  const e = closeQuote(s, i + 1, q);
  return e < 0 ? s.length : e;
}

/** Whether the line ends in a backslash that is not itself escaped (the string goes on). */
function continued(s) {
  let k = s.length - 1;
  let n = 0;
  while (k >= 0 && s[k] === '\\') { n++; k--; }
  return n % 2 === 1;
}

/** Shell double-quoted text s[a, b): the string, and the variables in it. */
function shellString(s, a, b, out, vars = SH_VAR) {
  let last = a;
  for (let k = a; k < b; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (s[k] !== '$') continue;
    const v = stick(vars, s, k);
    if (!v || k + v.length > b) continue;
    if (k > last) out.push([last, k, 'pl-s']);
    out.push([k, k + v.length, 'pl-s pl-smi']);
    k += v.length - 1;
    last = k + 1;
  }
  if (b > last) out.push([last, b, 'pl-s']);
}

const HEREDOC = /<<(-|~)?[ \t]*(?:(['"])([A-Za-z_][\w-]*)\2|\\?([A-Za-z_][\w-]*))/y;

/**
 * One line of a language read by the generic scanner, from `from` on. `state`: '' or what
 * the line above left open — 'c<k>' L.block[k]'s comment, 's<q>' a string, 't<q>' a triple-
 * quoted one, 'h<-| ><word>' a shell heredoc. Returns the state after the line.
 */
function scanLine(s, L, state, out, from = 0) {
  const n = s.length;
  let i = from;
  const emit = (a, b, cls) => { if (b > a) out.push([a, b, cls]); };

  // what the line above left open
  if (state) {
    const k = state[0];
    if (k === 'h') {
      const strip = state[1] === '-';
      const word = state.slice(2);
      const t = strip ? s.replace(/^\t+/, '') : s;
      if (t === word) { emit(0, n, 'pl-k'); return ''; }
      emit(0, n, 'pl-s');
      return state;
    }
    if (k === 'c') {
      const close = L.block[+state.slice(1)][1];
      const e = s.indexOf(close, i);
      if (e < 0) { emit(i, n, 'pl-c'); return state; }
      emit(i, e + close.length, 'pl-c');
      i = e + close.length;
    } else if (k === 't') {
      const q3 = state[1].repeat(3);
      const e = s.indexOf(q3, i);
      if (e < 0) { emit(i, n, 'pl-s'); return state; }
      emit(i, e + 3, 'pl-s');
      i = e + 3;
    } else if (k === 's') {
      const q = state[1];
      const e = closeQuote(s, i, q);
      const end = e < 0 ? n : e;
      if (L.shell && q === '"') shellString(s, i, end, out, L.vars);
      else emit(i, end, 'pl-s');
      if (e < 0) return L.multi.includes(q) || continued(s) ? state : '';
      i = e;
    }
  }

  let defining = false;
  let lineStart = i === 0; // only whitespace so far on this line
  let heredoc = ''; // a heredoc opened on this line starts on the next
  let prev = ''; // the last token's kind, for telling a regex from a division: 'w' a value
  const starts = startsOf(L);
  while (i < n) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    const atLineStart = lineStart;
    lineStart = false;
    const w = wordAt(s, i);
    if (!w && ch !== '.' && !starts.has(ch)) {
      // punctuation: nothing starts here (most of what is not a name is this)
      if (defining && !/[*&<>:]/.test(ch)) defining = false;
      prev = ch === ')' || ch === ']' || ch === '}' ? 'w' : '';
      i++;
      continue;
    }

    // comments (a block one first: Lua's --[[ also starts a line comment)
    let hit = false;
    for (let b = 0; b < L.block.length; b++) {
      const [open, close] = L.block[b];
      if (s.startsWith(open, i)) {
        const e = s.indexOf(close, i + open.length);
        if (e < 0) { emit(i, n, 'pl-c'); return `c${b}`; }
        emit(i, e + close.length, 'pl-c');
        i = e + close.length;
        hit = true;
        break;
      }
    }
    if (hit) continue;
    for (const lc of L.line) {
      if (s.startsWith(lc, i) && !(L.hash && i > 0 && !/\s/.test(s[i - 1]))) {
        emit(i, n, 'pl-c');
        return heredoc;
      }
    }

    // C preprocessor: the directive is a keyword, an #include's file a string
    if (L.pre && ch === '#' && atLineStart) {
      const d = stick(/#[ \t]*[a-z]+/y, s, i);
      if (d) {
        emit(i, i + d.length, 'pl-k');
        i += d.length;
        if (/include|import/.test(d)) {
          const f = stick(/[ \t]*<[^>\n]*>/y, s, i);
          if (f) {
            emit(i + f.indexOf('<'), i + f.length, 'pl-s');
            i += f.length;
          }
        }
        continue;
      }
    }

    // strings
    if (L.quotes.includes(ch) && !(L.rustChar && ch === "'")) {
      prev = 'w';
      if (L.triple && s.startsWith(ch.repeat(3), i)) {
        const e = s.indexOf(ch.repeat(3), i + 3);
        if (e < 0) { emit(i, n, 'pl-s'); return `t${ch}`; }
        emit(i, e + 3, 'pl-s');
        i = e + 3;
        continue;
      }
      const c = closeQuote(s, i + 1, ch);
      const e = c < 0 ? n : c;
      if (L.json) {
        emit(i, e, stick(/[ \t]*:/y, s, e) ? 'pl-ent' : 'pl-s');
      } else if (L.shell && ch === '"') {
        shellString(s, i, e, out, L.vars);
      } else emit(i, e, 'pl-s');
      if (c < 0) return L.multi.includes(ch) || continued(s) ? `s${ch}` : heredoc;
      i = e;
      continue;
    }
    if (L.rustChar && ch === "'") {
      const c = stick(/'(?:\\(?:u\{[\da-fA-F]{1,6}\}|x[\da-fA-F]{2}|.)|[^\\'\n])'/y, s, i);
      if (c) { emit(i, i + c.length, 'pl-s'); i += c.length; prev = 'w'; continue; }
      const life = stick(/'[A-Za-z_]\w*/y, s, i);
      if (life) { emit(i, i + life.length, 'pl-k'); i += life.length; continue; }
    }

    // a regular expression literal, where a value may start (not after one: a division)
    if (L.regex && ch === '/') {
      const re = prev !== 'w' && stick(REGEX, s, i);
      if (re) { emit(i, i + re.length, 'pl-sr'); i += re.length; prev = 'w'; continue; }
      prev = '';
      i++;
      continue;
    }

    // shell: variables outside strings, and heredocs
    if (L.shell && ch === '$') {
      const v = stick(L.vars, s, i);
      if (v) { emit(i, i + v.length, 'pl-smi'); i += v.length; continue; }
    }
    if (L.shell && ch === '<') {
      const h = s[i + 1] === '<' && s[i + 2] !== '<' ? HEREDOC.exec((HEREDOC.lastIndex = i, s)) : null;
      if (h) {
        emit(i, i + h[0].length, 'pl-k');
        heredoc = `h${h[1] === '-' ? '-' : ' '}${h[3] || h[4]}`;
        i += h[0].length;
        continue;
      }
      i++;
      continue;
    }

    // decorators and annotations
    if (L.at && ch === '@') {
      const id = stick(/@@?[A-Za-z_][\w.]*/y, s, i);
      if (id) { emit(i, i + id.length, L.atCls || 'pl-en'); i += id.length; prev = 'w'; continue; }
    }
    // Ruby's symbols
    if (L.sym && ch === ':') {
      const sym = s[i + 1] !== ':' && !(i > 0 && (isWord(s, i - 1) || s[i - 1] === ':')) && stick(/:[A-Za-z_]\w*[?!]?/y, s, i);
      if (sym) { emit(i, i + sym.length, 'pl-c1'); i += sym.length; prev = 'w'; continue; }
      i++;
      continue;
    }

    // numbers
    if ((w === 2 || ch === '.') && !(i > 0 && isWord(s, i - 1))) {
      const num = stick(NUMBER, s, i);
      if (num && !(L.shell && isWord(s, i + num.length))) {
        emit(i, i + num.length, 'pl-c1');
        i += num.length;
        prev = 'w';
        continue;
      }
    }

    // words
    if (w === 1 && !(L.shell && ch === '$')) {
      let j = i + 1;
      while (j < n && isWord(s, j)) j++;
      const id = s.slice(i, j);
      prev = 'w';
      // Python string prefixes: r"…", f'…', b"""…"""
      if (L.prefixes && L.prefixes.has(id.toLowerCase()) && L.quotes.includes(s[j])) {
        const q = s[j];
        if (s.startsWith(q.repeat(3), j)) {
          const e = s.indexOf(q.repeat(3), j + 3);
          if (e < 0) { emit(i, n, 'pl-s'); return `t${q}`; }
          emit(i, e + 3, 'pl-s');
          i = e + 3;
        } else {
          const c = closeQuote(s, j + 1, q);
          emit(i, c < 0 ? n : c, 'pl-s');
          if (c < 0) return continued(s) ? `s${q}` : '';
          i = c;
        }
        continue;
      }
      if (L.shell && (s[i - 1] === '-' || s[i - 1] === '/' || s[i - 1] === '.' || s[j] === '=' || s[j] === '-' || s[j] === '.' || s[j] === '/')) {
        // an option, a path or an assignment, not a keyword
        i = j;
        continue;
      }
      const key = L.ci ? id.toLowerCase() : id;
      if (defining && !L.kw.has(key)) {
        emit(i, j, 'pl-en');
        defining = false;
      } else if (L.kw.has(key)) {
        emit(i, j, 'pl-k');
        defining = L.defs.has(key);
        prev = '';
      } else if (L.consts.has(key)) {
        emit(i, j, 'pl-c1');
      } else if (s[j] === '(' || (L.rustChar && s[j] === '!' && s[j + 1] !== '=')) {
        const bang = L.rustChar && s[j] === '!';
        emit(i, bang ? j + 1 : j, 'pl-en');
        if (bang) { i = j + 1; continue; }
      }
      i = j;
      continue;
    }

    if (defining && !/[\w*&<>:]/.test(ch)) defining = false;
    prev = '';
    i++;
  }
  return heredoc;
}

// ---------------------------------------------------------------- line-based languages

function diffLine(s, out) {
  const n = s.length;
  if (/^(?:diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(s)) out.push([0, n, 'pl-mh']);
  else if (s.startsWith('@@')) out.push([0, n, 'pl-mdr']);
  else if (s[0] === '+' || s[0] === '>' || s[0] === '-' || s[0] === '<') {
    const cls = s[0] === '+' || s[0] === '>' ? 'pl-mi1' : 'pl-md';
    out.push([0, 1, `${cls} ${cls}`]);
    if (n > 1) out.push([1, n, cls]);
  } else if (s[0] === '!') out.push([0, n, 'pl-mc']);
}

const YAML_CONST = /^(?:true|false|yes|no|on|off|null|~|[+-]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|0x[\da-fA-F]+|\.inf|\.nan))$/i;

/** A YAML value in s[k, end): quoted strings, constants and numbers, plain text, a trailing comment. */
function yamlValue(s, k, out, end = s.length) {
  while (k < end && (s[k] === ' ' || s[k] === '\t')) k++;
  if (k >= end) return;
  const ch = s[k];
  if (ch === '"' || ch === "'") {
    const e = Math.min(stringEnd(s, k, ch), end);
    out.push([k, e, 'pl-s']);
    k = e;
  } else if (ch === '#') {
    out.push([k, end, 'pl-c']);
    return;
  } else if (ch === '|' || ch === '>' || ch === '&' || ch === '*' || ch === '!') {
    let e = k;
    while (e < end && !/\s/.test(s[e])) e++;
    out.push([k, e, ch === '|' || ch === '>' ? 'pl-k' : 'pl-v']);
    k = e;
  } else if (ch === '[' || ch === '{') {
    // flow collections: colour the scalars inside loosely
    let p = k;
    for (let j = k; j <= end; j++) {
      if (j === end || '[]{},'.includes(s[j])) {
        if (j > p) yamlValue(s, p, out, j);
        p = j + 1;
      }
    }
    return;
  } else {
    // plain text, up to a comment
    let c = k;
    while (c < end && !((s[c] === ' ' || s[c] === '\t') && s[c + 1] === '#')) c++;
    let t = c;
    while (t > k && (s[t - 1] === ' ' || s[t - 1] === '\t')) t--;
    out.push([k, t, YAML_CONST.test(s.slice(k, t)) ? 'pl-c1' : 'pl-s']);
    k = c < end ? c + 1 : end;
  }
  while (k < end && s[k] !== '#') k++;
  if (k < end) out.push([k, end, 'pl-c']);
}

/** Where a `key:` starting at k ends, and its colon; null when the line is no mapping entry. */
function yamlKey(line, k) {
  const ch = line[k];
  if (ch === undefined || '#[{'.includes(ch)) return null;
  let end;
  if (ch === '"' || ch === "'") {
    end = stringEnd(line, k, ch);
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

/** state: '' or 'b<indent>' inside a block scalar (| or >) of a key indented so. */
function yamlLine(line, state, out) {
  const n = line.length;
  let ind = 0;
  while (line[ind] === ' ') ind++;
  if (state) {
    if (!line.trim() || ind > +state.slice(1)) {
      if (n) out.push([0, n, 'pl-s']);
      return state;
    }
  }
  if (/^(?:---|\.\.\.)(?:\s|$)/.test(line)) {
    out.push([0, 3, 'pl-c1']);
    yamlValue(line, 3, out);
    return '';
  }
  const ws = line.match(/^\s*/)[0].length;
  if (line[ws] === '#') {
    out.push([ws, n, 'pl-c']);
    return '';
  }
  const lead = stick(/[ \t]*(?:-(?:[ \t]+|$))*/y, line, 0).length;
  const key = yamlKey(line, lead);
  let v = lead;
  if (key) {
    let e = key.end;
    while (e > lead && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
    out.push([lead, e, 'pl-ent']);
    v = key.colon + 1;
  }
  yamlValue(line, v, out);
  return /^[ \t]*[|>][-+0-9]*[ \t]*(?:#.*)?$/.test(line.slice(v)) ? `b${ind}` : '';
}

const TOML_CONST = /^(?:true|false|[+-]?(?:inf|nan)|[+-]?(?:0x[\da-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)|\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?)?(?:Z|[+-]\d\d:\d\d)?|\d\d:\d\d:\d\d(?:\.\d+)?)$/;

/** state: '' or 't<q>' in a multi-line string ("""…""" or '''…'''). */
function tomlLine(s, state, out) {
  const n = s.length;
  let i = 0;
  if (state) {
    const e = s.indexOf(state[1].repeat(3));
    if (e < 0) { if (n) out.push([0, n, 'pl-s']); return state; }
    out.push([0, e + 3, 'pl-s']);
    i = e + 3;
  } else {
    const h = stick(/[ \t]*\[\[?[^\]\n]*\]\]?(?=[ \t]*(?:#|$))/y, s, 0);
    if (h) {
      const at = h.length - h.trimStart().length;
      out.push([at, h.length, 'pl-en']);
      i = h.length;
    }
  }
  while (i < n) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === ',' || ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === '=') { i++; continue; }
    if (ch === '#') { out.push([i, n, 'pl-c']); break; }
    if (ch === '"' || ch === "'") {
      if (s.startsWith(ch.repeat(3), i)) {
        const e = s.indexOf(ch.repeat(3), i + 3);
        if (e < 0) { out.push([i, n, 'pl-s']); return `t${ch}`; }
        out.push([i, e + 3, 'pl-s']);
        i = e + 3;
        continue;
      }
      const e = ch === '"' ? stringEnd(s, i, ch) : (s.indexOf("'", i + 1) + 1 || n);
      // a quoted key, or a value
      out.push([i, e, stick(/[ \t]*[=.]/y, s, e) ? 'pl-ent' : 'pl-s']);
      i = e;
      continue;
    }
    const w = stick(/[\w.:+-]+(?: \d\d:\d\d[\w:.+-]*)?/y, s, i);
    if (!w) { i++; continue; }
    if (stick(/[ \t]*=/y, s, i + w.length)) out.push([i, i + w.length, 'pl-ent']);
    else if (TOML_CONST.test(w)) out.push([i, i + w.length, 'pl-c1']);
    i += w.length;
  }
  return '';
}

/** INI files, .properties, .editorconfig, .gitconfig: [sections], keys, values, comments. */
function iniLine(s, out) {
  const n = s.length;
  const ws = s.match(/^\s*/)[0].length;
  const ch = s[ws];
  if (ch === ';' || ch === '#' || ch === '!') { out.push([ws, n, 'pl-c']); return; }
  if (ch === '[') {
    const e = s.indexOf(']', ws);
    out.push([ws, e < 0 ? n : e + 1, 'pl-en']);
    const c = e < 0 ? -1 : s.slice(e + 1).search(/[;#]/);
    if (c >= 0) out.push([e + 1 + c, n, 'pl-c']);
    return;
  }
  let eq = ws;
  while (eq < n && s[eq] !== '=' && s[eq] !== ':') eq++;
  if (eq >= n || eq === ws) return;
  let k = eq;
  while (k > ws && (s[k - 1] === ' ' || s[k - 1] === '\t')) k--;
  out.push([ws, k, 'pl-ent']);
  let v = eq + 1;
  while (s[v] === ' ' || s[v] === '\t') v++;
  if (v >= n) return;
  const q = s[v];
  if (q === '"' || q === "'") { out.push([v, stringEnd(s, v, q), 'pl-s']); return; }
  const c = s.slice(v).search(/\s[;#]/);
  const val = (c < 0 ? s.slice(v) : s.slice(v, v + c)).trimEnd();
  if (/^(?:true|false|yes|no|on|off|-?\d+(?:\.\d+)?)$/i.test(val)) out.push([v, v + val.length, 'pl-c1']);
  if (c >= 0) out.push([v + c + 1, n, 'pl-c']);
}

/** .gitignore and the like: only comments. */
function confLine(s, out) {
  const ws = s.match(/^\s*/)[0].length;
  if (s[ws] === '#') out.push([ws, s.length, 'pl-c']);
  else if (s[ws] === '!') out.push([ws, ws + 1, 'pl-k']);
}

/** Make variables in s[a, b) (outside recipes). */
function makeVars(s, a, b, out) {
  for (let k = s.indexOf('$', a); k >= 0 && k < b; k = s.indexOf('$', k + 1)) {
    const v = stick(MAKE_VAR, s, k);
    if (v && k + v.length <= b) {
      out.push([k, k + v.length, 'pl-smi']);
      k += v.length - 1;
    }
  }
}

/** state: '' | 'd' inside define…endef | 'r' and a recipe's shell state, when it goes on */
function makeLine(s, state, out) {
  const n = s.length;
  if (state === 'd') {
    const e = stick(/\s*endef\b/y, s, 0);
    if (e) { out.push([e.length - 5, e.length, 'pl-k']); return ''; }
    makeVars(s, 0, n, out);
    return 'd';
  }
  if (s[0] === '\t' || state[0] === 'r') {
    // a recipe: shell (a heredoc, a string or a continued line going on, too)
    const st = scanLine(s, MAKE_SHELL, state.slice(1), out);
    return st || continued(s) ? `r${st}` : '';
  }
  const ws = s.match(/^\s*/)[0].length;
  // the comment at the end of the line (\# is no comment)
  let end = n;
  for (let k = s.indexOf('#', ws); k >= 0; k = s.indexOf('#', k + 1)) {
    if (s[k - 1] !== '\\') { end = k; break; }
  }
  let next = '';
  const dir = stick(/-?[a-z]+/y, s, ws);
  const head = s.slice(ws, end);
  const assign = head.match(/^(?:(?:export|override)\s+)?([A-Za-z_.][\w.-]*)\s*(?::{1,3}=|\?=|\+=|!=|=)/);
  const rule = !assign && head.match(/^([^:=\t][^:=]*?)(::?)(?!=)/);
  if (dir && MAKE_KW.has(dir) && !isWord(s, ws + dir.length) && s[ws + dir.length] !== ':' && !assign) {
    out.push([ws, ws + dir.length, 'pl-k']);
    makeVars(s, ws + dir.length, end, out);
    if (dir === 'define') next = 'd';
  } else if (assign) {
    const at = ws + assign[0].indexOf(assign[1]);
    if (at > ws) out.push([ws, at - 1, 'pl-k']);
    out.push([at, at + assign[1].length, 'pl-v']);
    makeVars(s, ws + assign[0].length, end, out);
  } else if (rule) {
    // the targets (a variable among them stays one), then the prerequisites
    const t1 = ws + rule[1].length;
    const vars = [];
    makeVars(s, ws, t1, vars);
    let p = ws;
    for (const v of vars) {
      pushWords(s, p, v[0], 'pl-en', out);
      out.push(v);
      p = v[1];
    }
    pushWords(s, p, t1, 'pl-en', out);
    makeVars(s, t1 + rule[2].length, end, out);
  } else {
    makeVars(s, ws, end, out);
  }
  if (end < n) out.push([end, n, 'pl-c']);
  return next;
}

/** The non-blank runs of s[a, b), as tokens of class `cls`. */
function pushWords(s, a, b, cls, out) {
  const re = /\S+/g;
  re.lastIndex = a;
  for (let m; (m = re.exec(s)) && m.index < b;) out.push([m.index, Math.min(b, m.index + m[0].length), cls]);
}

/** state: [ '\' when the line above went on ] + the shell's state */
function dockerLine(s, state, out) {
  const cont = state[0] === '\\';
  const sh = cont ? state.slice(1) : state;
  let from = 0;
  if (!cont && !sh) {
    const ws = s.match(/^\s*/)[0].length;
    if (s[ws] === '#') { out.push([ws, s.length, 'pl-c']); return ''; }
    const w = stick(/[A-Za-z]+/y, s, ws);
    if (w && DOCKER_KW.has(w.toLowerCase()) && !isWord(s, ws + w.length)) {
      out.push([ws, ws + w.length, 'pl-k']);
      from = ws + w.length;
    }
  } else if (cont && !sh && /^\s*#/.test(s)) {
    // a comment line inside a continued instruction
    out.push([s.match(/^\s*/)[0].length, s.length, 'pl-c']);
    return state;
  }
  const st = scanLine(s, SHELL, sh, out, from);
  if (st) return (cont || continued(s) ? '\\' : '') + st;
  return continued(s) ? '\\' : '';
}

// ---------------------------------------------------------------- markup

const TAG = /<(\/?)([A-Za-z][\w:.-]*)/y;
const ATTR_NAME = /[^\s"'>/=]+/y;
const ATTR_EQ = /[ \t]*=[ \t]*/y;
const ATTR_VALUE = /[^\s"'=<>`]+/y;
const ENTITY = /&(?:#\d+|#x[\da-fA-F]+|[A-Za-z]\w*);/y;

/**
 * HTML and XML. state: '' | '!' in a comment | 'D' in CDATA | '?' in <!…> or <?…> |
 * 'T<k><q>' in a tag (k: 'j' <script>, 's' <style>; q: the quote of a value going on) |
 * 'J…' / 'S…' in a script or style (the rest is the state of the JavaScript or CSS in it).
 */
function markupLine(s, state, out) {
  const n = s.length;
  let i = 0;
  let lt = -1;
  let amp = -1;
  while (i < n) {
    const k = state[0];
    if (k === 'J' || k === 'S') {
      const re = k === 'J' ? /<\/script/ig : /<\/style/ig;
      re.lastIndex = i;
      const m = re.exec(s);
      const e = m ? m.index : n;
      const sub = [];
      const inner = k === 'J' ? scanLine(s.slice(i, e), LANGS.js, state.slice(1), sub) : cssLine(s.slice(i, e), state.slice(1), sub, false);
      for (const t of sub) out.push([t[0] + i, t[1] + i, t[2]]);
      if (!m) return k + inner;
      state = '';
      i = e;
      continue;
    }
    if (k === '!' || k === 'D' || k === '?') {
      const close = k === '!' ? '-->' : k === 'D' ? ']]>' : '>';
      const e = s.indexOf(close, i);
      const cls = k === '!' ? 'pl-c' : k === 'D' ? 'pl-s' : 'pl-c1';
      if (e < 0) { out.push([i, n, cls]); return state; }
      out.push([i, e + close.length, cls]);
      i = e + close.length;
      state = '';
      continue;
    }
    if (k === 'T') {
      const kind = state[1] === 'j' || state[1] === 's' ? state[1] : '';
      const q = state[1 + kind.length];
      if (q) {
        // a quoted value that went on from the line above
        const e = s.indexOf(q, i);
        if (e < 0) { out.push([i, n, 'pl-s']); return state; }
        out.push([i, e + 1, 'pl-s']);
        i = e + 1;
        state = `T${kind}`;
      }
      // attributes, up to the end of the tag
      while (i < n) {
        const ch = s[i];
        if (ch === ' ' || ch === '\t') { i++; continue; }
        if (ch === '<') { state = ''; break; } // a tag left open: no attributes past another
        if (ch === '>' || (ch === '/' && s[i + 1] === '>')) {
          const e = ch === '>' ? i + 1 : i + 2;
          out.push([i, e, 'pl-kos']);
          i = e;
          state = ch === '>' && kind ? kind.toUpperCase() : '';
          break;
        }
        const name = stick(ATTR_NAME, s, i);
        if (!name) { i++; continue; }
        out.push([i, i + name.length, 'pl-c1']);
        i += name.length;
        const eq = stick(ATTR_EQ, s, i);
        if (!eq) continue;
        i += eq.length;
        const v = s[i];
        if (v === '"' || v === "'") {
          const e = s.indexOf(v, i + 1);
          if (e < 0) { out.push([i, n, 'pl-s']); return `T${kind}${v}`; }
          out.push([i, e + 1, 'pl-s']);
          i = e + 1;
        } else {
          const u = stick(ATTR_VALUE, s, i);
          if (u) { out.push([i, i + u.length, 'pl-s']); i += u.length; }
        }
      }
      if (state[0] === 'T') return state;
      continue;
    }
    // text: up to the next < or & (both kept, so that a run of one does not rescan for the other)
    if (lt !== n && lt < i) { lt = s.indexOf('<', i); if (lt < 0) lt = n; }
    if (amp !== n && amp < i) { amp = s.indexOf('&', i); if (amp < 0) amp = n; }
    if (lt === n && amp === n) break;
    if (amp < lt) {
      const ent = stick(ENTITY, s, amp);
      if (ent) out.push([amp, amp + ent.length, 'pl-c1']);
      i = amp + (ent ? ent.length : 1);
      continue;
    }
    i = lt;
    const open = s.startsWith('<!--', i) ? '!' : s.startsWith('<![CDATA[', i) ? 'D'
      : s.startsWith('<!', i) || s.startsWith('<?', i) ? '?' : '';
    if (open) {
      // a comment, CDATA or declaration: read on from inside it, as when one goes on
      const len = open === '!' ? 4 : open === 'D' ? 9 : 2;
      const close = open === '!' ? '-->' : open === 'D' ? ']]>' : '>';
      const cls = open === '!' ? 'pl-c' : open === 'D' ? 'pl-s' : 'pl-c1';
      const e = s.indexOf(close, i + len);
      if (e < 0) { out.push([i, n, cls]); return open; }
      out.push([i, e + close.length, cls]);
      i = e + close.length;
      continue;
    }
    const t = stick(TAG, s, i);
    if (!t) { i++; continue; }
    const closing = s[i + 1] === '/';
    out.push([i, i + (closing ? 2 : 1), 'pl-kos']);
    out.push([i + (closing ? 2 : 1), i + t.length, 'pl-ent']);
    const name = t.slice(closing ? 2 : 1).toLowerCase();
    i += t.length;
    state = `T${!closing && name === 'script' ? 'j' : !closing && name === 'style' ? 's' : ''}`;
  }
  return state;
}

// ---------------------------------------------------------------- stylesheets

const CSS_GROUP = /^@(?:media|supports|document|layer|container|scope|-moz-document)$/i;

/**
 * CSS, SCSS and Less. state: '' at the start, else 'C|G|P|blocks': C '1' in a comment, G '1'
 * when the rule being read is an at-rule holding rules, P '1' in an at-rule's prelude, and
 * for each open brace '1' if it holds declarations (a rule), '0' if rules (@media …).
 */
function cssLine(s, state, out, scss) {
  const n = s.length;
  const st = state || '000';
  const blocks = [...st.slice(3)].map((c) => c === '1');
  let groupAt = st[1] === '1';
  let prelude = st[2] === '1';
  const inRule = () => blocks.length > 0 && blocks[blocks.length - 1];
  const emit = (a, b, cls) => { if (b > a) out.push([a, b, cls]); };
  // the next `;`, `{` or `}` at or after a position on this line; found once, moving forward
  let stop = -1;
  const nextStop = (from) => {
    if (stop < from) {
      stop = from;
      while (stop < n && !';{}'.includes(s[stop])) stop++;
    }
    return stop;
  };
  const key = (comment) => `${comment ? 1 : 0}${+groupAt}${+prelude}${blocks.map((b) => +b).join('')}`;
  let i = 0;
  if (st[0] === '1') {
    const e = s.indexOf('*/');
    if (e < 0) { emit(0, n, 'pl-c'); return key(true); }
    emit(0, e + 2, 'pl-c');
    i = e + 2;
  }
  while (i < n) {
    const ch = s[i];
    if (ch === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i + 2);
      if (e < 0) { emit(i, n, 'pl-c'); return key(true); }
      emit(i, e + 2, 'pl-c');
      i = e + 2;
      continue;
    }
    if (scss && ch === '/' && s[i + 1] === '/') { emit(i, n, 'pl-c'); break; }
    if (ch === '"' || ch === "'") { const e = stringEnd(s, i, ch); emit(i, e, 'pl-s'); i = e; continue; }
    if (ch === '{') { blocks.push(!groupAt); groupAt = prelude = false; i++; continue; }
    if (ch === '}') { blocks.pop(); prelude = false; i++; continue; }
    if (ch === ';') { groupAt = prelude = false; i++; continue; }
    if (ch === '@' || (scss && ch === '$')) {
      const w = stick(/[@$][\w-]+/y, s, i);
      if (w) {
        // an at-rule's prelude, or an SCSS variable's value, reads like a declaration
        if (ch === '@' || !inRule()) prelude = true;
        if (ch === '@' && !inRule()) groupAt = CSS_GROUP.test(w);
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
      i += stick(/[\w-]+/y, s, i).length;
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
  return key(false);
}

// ---------------------------------------------------------------- entry points

/** The state before the first line, in every language. */
export const CODE_START = '';

/**
 * One line of code in a language (a name languageOf gives), after a line that left `state`.
 * @returns {{tokens: Token[], state: string}} the tokens sorted, not overlapping
 */
export function tokenizeCode(line, name, state = CODE_START) {
  const tokens = [];
  let st = '';
  switch (name) {
    case 'diff': diffLine(line, tokens); break;
    case 'yaml': st = yamlLine(line, state, tokens); break;
    case 'toml': st = tomlLine(line, state, tokens); break;
    case 'ini': iniLine(line, tokens); break;
    case 'conf': confLine(line, tokens); break;
    case 'html': st = markupLine(line, state, tokens); break;
    case 'css': st = cssLine(line, state, tokens, false); break;
    case 'scss': st = cssLine(line, state, tokens, true); break;
    case 'make': st = makeLine(line, state, tokens); break;
    case 'dockerfile': st = dockerLine(line, state, tokens); break;
    default: st = LANGS[name] ? scanLine(line, LANGS[name], state, tokens) : '';
  }
  return { tokens, state: st };
}

/**
 * One line as HTML: escaped text and <span class="pl-…">, a nested class (`pl-s pl-smi`)
 * as a span in the span of the tokens around it that share its outer class.
 */
export function codeLineHtml(line, tokens) {
  let out = '';
  let pos = 0;
  let k = 0;
  const outer = (c) => { const sp = c.indexOf(' '); return sp < 0 ? c : c.slice(0, sp); };
  while (k < tokens.length) {
    const [a, b, cls] = tokens[k];
    if (a > pos) out += esc(line.slice(pos, a));
    // the run of touching tokens with the same outer class; one span if any is nested
    const o = outer(cls);
    let j = k;
    let p = a;
    let nested = false;
    while (j < tokens.length && tokens[j][0] === p && outer(tokens[j][2]) === o) {
      if (tokens[j][2] !== o) nested = true;
      p = tokens[j][1];
      j++;
    }
    if (!nested) {
      for (let t = k; t < j; t++) out += span(tokens[t][2], line.slice(tokens[t][0], tokens[t][1]));
      pos = p;
      k = j;
      continue;
    }
    out += `<span class="${o}">`;
    for (let t = k; t < j; t++) {
      const [x, y, c] = tokens[t];
      out += c === o ? esc(line.slice(x, y)) : span(c.slice(o.length + 1), line.slice(x, y));
    }
    out += '</span>';
    pos = p;
    k = j;
  }
  return out + esc(line.slice(pos));
}

/**
 * @param {string} code a fenced block's content
 * @param {string} lang its info string's first word
 * @returns {string|null} HTML (escaped text and pl-* spans), or null when the language is
 *   not one this knows (the caller then shows the block plain)
 */
export function highlight(code, lang) {
  const name = languageOf(lang);
  if (!name) return null;
  const lines = String(code).split('\n');
  let st = CODE_START;
  const out = [];
  for (const l of lines) {
    const r = tokenizeCode(l, name, st);
    st = r.state;
    out.push(codeLineHtml(l, r.tokens));
  }
  return out.join('\n');
}
