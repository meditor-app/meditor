// The source panel's colours for code: highlight.js line by line, with carried state, and
// the same inside Markdown's fenced blocks (mdsyntax.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeCode, codeLineHtml, highlight, CODE_START } from '../src/highlight.js';
import {
  tokenizeAll, retokenize, syntaxFor, MARKDOWN, tokenizeLine, START, stateKey, LONG_LINE,
} from '../src/mdsyntax.js';

const LANGS = ['js', 'ts', 'python', 'shell', 'json', 'yaml', 'toml', 'ini', 'conf', 'c', 'cpp', 'csharp', 'java',
  'kotlin', 'swift', 'rust', 'go', 'ruby', 'lua', 'sql', 'html', 'css', 'scss', 'make', 'dockerfile', 'diff'];

/** The tokens of each line, as "class:text", checking they are sorted, apart and inside the line. */
function tok(text, lang) {
  let st = CODE_START;
  return text.split('\n').map((l) => {
    const r = tokenizeCode(l, lang, st);
    st = r.state;
    let at = 0;
    for (const [a, b, c] of r.tokens) {
      assert.ok(a >= at && b > a && b <= l.length, `${lang}: token [${a}, ${b}) in ${JSON.stringify(l)}`);
      assert.match(c, /^pl-[a-z0-9]+(?: pl-[a-z0-9]+)?$/, c);
      at = b;
    }
    return r.tokens.map(([a, b, c]) => `${c}:${l.slice(a, b)}`);
  });
}
const has = (lines, i, ...want) => {
  for (const w of want) assert.ok(lines[i].includes(w), `line ${i}: no ${w} in ${JSON.stringify(lines[i])}`);
};

test('block comments, template and triple-quoted strings go on over lines', () => {
  let t = tok('a /* one\ntwo\nthree */ b = 1', 'c');
  assert.deepEqual(t, [['pl-c:/* one'], ['pl-c:two'], ['pl-c:three */', 'pl-c1:1']]);
  t = tok('const s = `a\n${b} c\nd` + 1;\nf()', 'js');
  assert.deepEqual(t.slice(1), [['pl-s:${b} c'], ['pl-s:d`', 'pl-c1:1'], ['pl-en:f']]);
  t = tok('x = """doc\nis "here"\n"""\ny = r\'\'\'\nz\'\'\'', 'python');
  assert.deepEqual(t, [['pl-s:"""doc'], ['pl-s:is "here"'], ['pl-s:"""'], ['pl-s:r\'\'\''], ["pl-s:z'''"]]);
  // a string that does not close ends with its line, unless a backslash carries it on
  assert.deepEqual(tok('"open\nx = 1', 'python')[1], ['pl-c1:1']);
  assert.deepEqual(tok('s = "a \\\nb"; f()', 'c')[1], ['pl-s:b"', 'pl-en:f']);
  // Go's raw strings, Rust's strings, Kotlin's triple quotes, Lua's and SQL's comments
  assert.deepEqual(tok('x := `a\nb`', 'go')[1], ['pl-s:b`']);
  assert.deepEqual(tok('let s = "a\nb";', 'rust')[1], ['pl-s:b"']);
  assert.deepEqual(tok('val s = """\nx"""', 'kotlin')[1], ['pl-s:x"""']);
  assert.deepEqual(tok('--[[ a\nb ]] local x', 'lua')[1], ['pl-c:b ]]', 'pl-k:local']);
  assert.deepEqual(tok("SELECT 'a\nb' FROM t -- c", 'sql')[1], ["pl-s:b'", 'pl-k:FROM', 'pl-c:-- c']);
});

test('JavaScript: a regular expression is no division, and hides its quotes', () => {
  assert.deepEqual(tok('const r = /["`]/g; f(`x`)', 'js')[0], ['pl-k:const', 'pl-sr:/["`]/g', 'pl-en:f', 'pl-s:`x`']);
  assert.deepEqual(tok('a = b / c / 2', 'js')[0], ['pl-c1:2']);
  assert.deepEqual(tok('x = (a) / 2 // c', 'js')[0], ['pl-c1:2', 'pl-c:// c']);
  assert.deepEqual(tok('if (/^a[/]b$/.test(s)) {}', 'js')[0], ['pl-k:if', 'pl-sr:/^a[/]b$/', 'pl-en:test']);
});

test('shell: heredocs, strings over lines, variables in them', () => {
  const t = tok('cat <<EOF >out\n  $x "not code"\nEOF\nif true; then\n  cat <<-\'END\'\n\tx\n\tEND\nfi', 'shell');
  assert.deepEqual(t.slice(0, 4), [['pl-k:<<EOF'], ['pl-s:  $x "not code"'], ['pl-k:EOF'], ['pl-k:if', 'pl-c1:true', 'pl-k:then']]);
  assert.deepEqual(t.slice(4), [["pl-k:<<-'END'"], ['pl-s:\tx'], ['pl-k:\tEND'], ['pl-k:fi']]);
  assert.deepEqual(tok('echo "a\n$HOME b" # c\nfi', 'shell'), [['pl-c1:echo', 'pl-s:"a'], ['pl-s pl-smi:$HOME', 'pl-s: b"', 'pl-c:# c'], ['pl-k:fi']]);
  // arithmetic is no heredoc
  assert.deepEqual(tok('echo $(( 1 << 2 ))\nfi', 'shell')[1], ['pl-k:fi']);
});

test('HTML: comments and tags over lines, and the script and style in a page', () => {
  const t = tok('<!-- a\nb --> <p\n  class="x"\n  title="y\nz">t &amp; u</p>', 'html');
  assert.deepEqual(t, [['pl-c:<!-- a'], ['pl-c:b -->', 'pl-kos:<', 'pl-ent:p'], ['pl-c1:class', 'pl-s:"x"'], ['pl-c1:title', 'pl-s:"y'],
    ['pl-s:z"', 'pl-kos:>', 'pl-c1:&amp;', 'pl-kos:</', 'pl-ent:p', 'pl-kos:>']]);
  const page = tok('<script type="module">\nlet s = `a\n</p>`; /* c */\n</script>\n<style>\n/* x\n*/ a { color: red }\n</style>\n<b>', 'html');
  assert.deepEqual(page[1], ['pl-k:let', 'pl-s:`a']);
  assert.deepEqual(page[2], ['pl-s:</p>`', 'pl-c:/* c */']); // in a JavaScript string, not a tag
  assert.deepEqual(page[3], ['pl-kos:</', 'pl-ent:script', 'pl-kos:>']);
  assert.deepEqual(page[5], ['pl-c:/* x']);
  assert.deepEqual(page[6], ['pl-c:*/', 'pl-ent:a', 'pl-c1:color']);
  assert.deepEqual(page[8], ['pl-kos:<', 'pl-ent:b', 'pl-kos:>']);
  // a self-closing script holds no code; a tag left open ends at the next one
  assert.deepEqual(tok('<script src="x"/>\nlet', 'html')[1], []);
  assert.deepEqual(tok('a<b c\n<i>', 'html')[1], ['pl-kos:<', 'pl-ent:i', 'pl-kos:>']);
  assert.deepEqual(tok('<![CDATA[ a\n]]> <?xml x?>', 'html')[1], ['pl-s:]]>', 'pl-c1:<?xml x?>']);
});

test('CSS: comments over lines, rules in @media, SCSS line comments', () => {
  const t = tok('@media (min-width: 1px) {\n  a:hover { color: red; /* c\n  d */ margin: 0 }\n}\nb { top: 1px }', 'css');
  assert.deepEqual(t[1], ['pl-ent:a', 'pl-e::hover', 'pl-c1:color', 'pl-c:/* c']);
  assert.deepEqual(t[2], ['pl-c:  d */', 'pl-c1:margin', 'pl-c1:0']);
  assert.deepEqual(t[4], ['pl-ent:b', 'pl-c1:top', 'pl-c1:1px']);
  assert.deepEqual(tok('$x: 1px; // c\na { b: $x }', 'scss'), [['pl-smi:$x', 'pl-c1:1px', 'pl-c:// c'], ['pl-ent:a', 'pl-c1:b', 'pl-smi:$x']]);
});

test('YAML block scalars, TOML and INI', () => {
  const y = tok('run: |\n  npm test\n\n  k: v\nnext: 1 # c', 'yaml');
  assert.deepEqual(y, [['pl-ent:run', 'pl-k:|'], ['pl-s:  npm test'], [], ['pl-s:  k: v'], ['pl-ent:next', 'pl-c1:1', 'pl-c:# c']]);
  const t = tok('[tool.x] # c\nname = "a"\nd = 1979-05-27T07:32:00Z\ns = """\nmulti = 1\n"""\narr = [\n  "a", 2,\n]\n"q k".x = true', 'toml');
  assert.deepEqual(t, [['pl-en:[tool.x]', 'pl-c:# c'], ['pl-ent:name', 'pl-s:"a"'], ['pl-ent:d', 'pl-c1:1979-05-27T07:32:00Z'],
    ['pl-ent:s', 'pl-s:"""'], ['pl-s:multi = 1'], ['pl-s:"""'], ['pl-ent:arr'], ['pl-s:"a"', 'pl-c1:2'], [], ['pl-ent:"q k"', 'pl-ent:.x', 'pl-c1:true']]);
  assert.deepEqual(tok('[core]\n\tbare = false ; c\nurl = "x"\n# c', 'ini'),
    [['pl-en:[core]'], ['pl-ent:bare', 'pl-c1:false', 'pl-c:; c'], ['pl-ent:url', 'pl-s:"x"'], ['pl-c:# c']]);
  assert.deepEqual(tok('# c\nnode_modules/\n!keep.log', 'conf'), [['pl-c:# c'], [], ['pl-k:!']]);
});

test('Makefiles and Dockerfiles', () => {
  const m = tok('CC ?= gcc\nall: $(OBJ) main.o # c\n\t$(CC) -o $@ $^ "$$x"\n\techo a \\\n\t  b\nifeq ($(X),1)\ndefine T\n$(Y) # not a comment\nendef', 'make');
  assert.deepEqual(m[0], ['pl-v:CC']);
  assert.deepEqual(m[1], ['pl-en:all', 'pl-smi:$(OBJ)', 'pl-c:# c']);
  assert.deepEqual(m[2], ['pl-smi:$(CC)', 'pl-smi:$@', 'pl-smi:$^', 'pl-s:"', 'pl-s pl-smi:$$', 'pl-s:x"']);
  assert.deepEqual(m[5], ['pl-k:ifeq', 'pl-smi:$(X)']);
  assert.deepEqual(m[7], ['pl-smi:$(Y)']);
  assert.deepEqual(m[8], ['pl-k:endef']);
  const d = tok('FROM node AS build\n# c\nRUN apt-get update \\\n  # inner\n  && echo "$HOME" \\\n  run\nENV A=1', 'dockerfile');
  assert.deepEqual(d[0], ['pl-k:FROM']);
  assert.deepEqual(d[1], ['pl-c:# c']);
  assert.deepEqual(d[3], ['pl-c:# inner']);
  assert.deepEqual(d[4], ['pl-c1:echo', 'pl-s:"', 'pl-s pl-smi:$HOME', 'pl-s:"']);
  assert.deepEqual(d[5], []); // a continued line: no instruction
  assert.deepEqual(d[6], ['pl-k:ENV', 'pl-c1:1']);
});

test('more languages: Ruby, C#, Swift, diff', () => {
  assert.deepEqual(tok('def f(x)\n  @a = :sym # c\nend', 'ruby'), [['pl-k:def', 'pl-en:f'], ['pl-v:@a', 'pl-c1::sym', 'pl-c:# c'], ['pl-k:end']]);
  assert.deepEqual(tok('#region x\npublic class C { }', 'csharp'), [['pl-k:#region'], ['pl-k:public', 'pl-k:class', 'pl-en:C']]);
  assert.deepEqual(tok('func f() -> Int { nil }', 'swift')[0], ['pl-k:func', 'pl-en:f', 'pl-c1:nil']);
  assert.deepEqual(tok('+add\n-del\n@@ -1 +1 @@', 'diff'), [['pl-mi1 pl-mi1:+', 'pl-mi1:add'], ['pl-md pl-md:-', 'pl-md:del'], ['pl-mdr:@@ -1 +1 @@']]);
});

test('a nested class is a span in a span, in the preview\'s HTML', () => {
  assert.equal(codeLineHtml('"a $X" b', [[0, 3, 'pl-s'], [3, 5, 'pl-s pl-smi'], [5, 6, 'pl-s']]),
    '<span class="pl-s">&quot;a <span class="pl-smi">$X</span>&quot;</span> b');
  assert.equal(codeLineHtml('<a>', [[0, 1, 'pl-kos'], [1, 2, 'pl-ent'], [2, 3, 'pl-kos']]),
    '<span class="pl-kos">&lt;</span><span class="pl-ent">a</span><span class="pl-kos">&gt;</span>');
  // a construct over lines is coloured on each
  assert.equal(highlight('/* a\nb */', 'c'), '<span class="pl-c">/* a</span>\n<span class="pl-c">b */</span>');
});

// A small deterministic random number generator, so that a failure can be repeated.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return (n) => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x % n;
  };
}

// Lines that open and close what goes on over lines, in each language.
const PIECES = {
  js: ['/*', '*/', '`', '`${a}`', 'x = 1', '// c `', 'const s = "a', "'b\\", 'r = /`/', '', 'a /* b */ c'],
  python: ['"""', "'''", 'x = """a', 'b"""', 's = "a\\', 'def f():', '# """', "r'''", ''],
  shell: ['cat <<EOF', 'EOF', 'cat <<-X', '\tX', 'echo "a', 'b"', "'", '# "', 'x=$(( 1 << 2 ))', ''],
  html: ['<!--', '-->', '<script>', '</script>', '<style>', '</style>', '<a', 'b="c', 'd">', '/*', '*/', '`', '<![CDATA[', ']]>', '<b>', ''],
  css: ['/*', '*/', '@media x {', '}', 'a {', 'b: c;', '{', ''],
  yaml: ['run: |', '  text', 'k: v', '- a', '', '  - b: >', '    c', '---'],
  toml: ['"""', "'''", 's = """a', '[t]', 'k = 1', '', 'b"""'],
  make: ['define X', 'endef', '\techo "a', 'b"', '\tcat <<E', 'E', 'all: x', '\tx \\', 'X = 1', ''],
  dockerfile: ['RUN a \\', '  b', '# c', 'FROM x', 'RUN cat <<EOF', 'EOF', 'RUN echo "a', 'b"', ''],
  c: ['/*', '*/', '#include <a>', 's = "a\\', 'b"', 'int x;', ''],
  lua: ['--[[', ']]', '-- c', 'x = 1', ''],
  ruby: ['s = "a', 'b"', '# "', 'def f', 'end', '`', ''],
  markdown: ['```js', '```c', '```html', '```', '~~~py', '~~~', '/*', '*/', '`', '"""', '<!--', '-->', '<script>', 'text', '', '- a', '  ```sh', '  cat <<E', '  E'],
};

test('tokenizing again after an edit gives what tokenizing everything does, in code too', () => {
  for (const [lang, pieces] of Object.entries(PIECES)) {
    const syntax = syntaxFor(lang);
    for (let d = 0; d < 3; d++) {
      const rand = rng(d * 31 + lang.length + 1);
      let lines = Array.from({ length: 12 }, () => pieces[rand(pieces.length)]);
      let { tokens, states } = tokenizeAll(lines, syntax);
      for (let step = 0; step < 300; step++) {
        const a = rand(lines.length + 1);
        const del = Math.min(rand(4), lines.length - a);
        const ins = Array.from({ length: rand(4) }, () => pieces[rand(pieces.length)]);
        if (!del && !ins.length) continue;
        const next = [...lines.slice(0, a), ...ins, ...lines.slice(a + del)];
        if (!next.length) next.push('');
        let s = 0;
        while (s < next.length && s < lines.length && next[s] === lines[s]) s++;
        let e = 0;
        while (e < next.length - s && e < lines.length - s && next[next.length - 1 - e] === lines[lines.length - 1 - e]) e++;
        const end = retokenize(next, tokens, states, s, lines.length - e, next.length - e, Infinity, syntax);
        const full = tokenizeAll(next, syntax);
        const what = `${lang} ${d}, step ${step}: ${JSON.stringify(next.join('\n'))}`;
        assert.ok(end >= next.length - e, what);
        assert.deepEqual(tokens, full.tokens, what);
        assert.deepEqual(states.map(syntax.key), full.states.map(syntax.key), what);
        lines = next;
      }
    }
  }
});

test('any input: tokens sorted, apart, inside their line, and the HTML is the text', () => {
  const chars = ['a', 'if', ' ', '\t', '"', "'", '`', '/', '*', '#', '<', '>', '!', '-', '$', '{', '}', '(', ')', '[', ']',
    '\\', ':', '=', ';', '@', '1', '.', 'x', '<<', 'EOF', '--', '"""', '/*', '*/', '<!--', '-->', 'script', '&'];
  const rand = rng(99);
  for (const lang of LANGS) {
    for (let k = 0; k < 40; k++) {
      const text = Array.from({ length: 1 + rand(60) }, () => (rand(8) ? chars[rand(chars.length)] : '\n')).join('');
      tok(text, lang); // checks the tokens
      const html = highlight(text, lang);
      const plain = html.replace(/<\/?span[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      assert.equal(plain, text, `${lang}: ${JSON.stringify(text)}`);
    }
  }
});

test('fenced code in Markdown is coloured in its language, its state carried over lines', () => {
  const md = (text) => {
    const lines = text.split('\n');
    return tokenizeAll(lines).tokens.map((t, i) => t.map(([a, b, c]) => `${c}:${lines[i].slice(a, b)}`));
  };
  assert.deepEqual(md('```c\nint a; /* x\n*y* */\n```\n*z*'), [['fence:```c'], ['pl-k:int', 'pl-c:/* x'], ['pl-c:*y* */'], ['fence:```'], ['mk:*', 'em:z', 'mk:*']]);
  // the info string's first word; unknown languages stay as before
  assert.deepEqual(md('``` python title="x"\ndef f(): pass\n```')[1], ['pl-k:def', 'pl-en:f', 'pl-k:pass']);
  assert.deepEqual(md('```{.js}\nlet\n```')[1], ['pl-k:let']);
  assert.deepEqual(md('```klingon\nlet\n```')[1], ['code:let']);
  // in a quote and in a list item the code is coloured after the marker and the indentation
  assert.deepEqual(md('> ```sh\n> echo "$A"\n\nx'), [['qt:> ', 'fence:```sh'], ['qt:> ', 'pl-c1:echo', 'pl-s:"', 'pl-s pl-smi:$A', 'pl-s:"'], [], []]);
  assert.deepEqual(md('- a\n  ```yaml\n  k: v\n  ```')[2], ['pl-ent:k', 'pl-s:v']);
  // a string or comment left open in the code ends with the block
  assert.deepEqual(md('```js\n/* open\n```\n*a*')[3], ['mk:*', 'em:a', 'mk:*']);
  // the code's state is part of the line's
  const after = (text) => text.split('\n').reduce((st, l) => tokenizeLine(l, st).state, START);
  assert.notEqual(stateKey(after('```c\n/* a')), stateKey(after('```c\nint a;')));
  assert.equal(stateKey(after('```c\nint a;')), stateKey(after('```c\nlong b;')));
  assert.equal(MARKDOWN.key(START), stateKey(START));
});

test('very long lines stay plain, but keep their state', () => {
  const long = 'x'.repeat(LONG_LINE) + ' /* open';
  const syntax = syntaxFor('js');
  const r = syntax.line(long, syntax.start);
  assert.deepEqual(r.tokens, []);
  assert.equal(syntax.line('*/ f()', r.state).tokens.length, 2);
  assert.equal(syntaxFor('js'), syntax, 'the same object for the same language');
  assert.equal(syntaxFor(null), null);
  assert.equal(syntaxFor('markdown'), MARKDOWN);
});

test('a keystroke in a large code file tokenizes only a few lines again', () => {
  const files = {
    js: (i) => (i % 7 ? `  const v${i} = f("s", ${i}); // note` : `/* block ${i} */ function g${i}(a) {`),
    python: (i) => (i % 9 ? `    x${i} = "s" + f(${i})  # c` : `def f${i}(a):`),
    html: (i) => (i % 5 ? `  <p class="a">text ${i} &amp; more</p>` : '<!-- c -->'),
    css: (i) => (i % 4 ? `  color: #fff; margin: ${i}px;` : i % 8 ? '}' : `.a${i} {`),
    yaml: (i) => (i % 6 ? `  key${i}: "value" # c` : `k${i}:`),
    shell: (i) => (i % 5 ? `echo "$HOME/${i}" | grep x` : 'if [ -n "$x" ]; then fi'),
  };
  for (const [lang, line] of Object.entries(files)) {
    const syntax = syntaxFor(lang);
    const lines = Array.from({ length: 20000 }, (_, i) => line(i));
    const t0 = performance.now();
    const { tokens, states } = tokenizeAll(lines, syntax);
    const all = performance.now() - t0;
    assert.ok(all < 1500, `${lang}: 20,000 lines took ${all.toFixed(0)} ms`);
    lines[10001] += 'x';
    assert.ok(retokenize(lines, tokens, states, 10001, 10002, 10002, 300, syntax) <= 10003, lang);
    // a typed character opening a string: only that line changes state (strings end with it)
    lines[5001] = 'x = "abc';
    assert.ok(retokenize(lines, tokens, states, 5001, 5002, 5002, 300, syntax) <= 5003, lang);
  }
  // a block comment opened far up changes everything after it: give up, the page draws all
  const syntax = syntaxFor('c');
  const lines = Array.from({ length: 20000 }, (_, i) => `int v${i} = ${i};`);
  const { tokens, states } = tokenizeAll(lines, syntax);
  lines[10] = '/* open';
  assert.equal(retokenize(lines, tokens, states, 10, 11, 11, 300, syntax), -1);
});
