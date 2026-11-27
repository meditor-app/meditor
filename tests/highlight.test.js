import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlight, languageOf } from '../src/highlight.js';

// The tokens a block was cut into, as [class, text] pairs (top-level spans only).
const tokens = (code, lang) => [...highlight(code, lang).matchAll(/<span class="([\w-]+)">((?:(?!<\/?span)[\s\S])*)<\/span>/g)]
  .map((m) => [m[1], m[2]]);
const has = (code, lang, ...want) => {
  const got = tokens(code, lang);
  for (const w of want) assert.ok(got.some((g) => g[0] === w[0] && g[1] === w[1]), `${lang}: no ${w} in ${JSON.stringify(got)}`);
};
// What is left once the spans are removed must be the source, escaped.
const text = (html) => html.replace(/<\/?span[^>]*>/g, '');
const escaped = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

test('languages and their aliases', () => {
  for (const [alias, name] of [['js', 'js'], ['JavaScript', 'js'], ['tsx', 'ts'], ['py', 'python'], ['zsh', 'shell'],
    ['bash', 'shell'], ['yml', 'yaml'], ['c++', 'cpp'], ['h', 'c'], ['rs', 'rust'], ['golang', 'go'], ['xml', 'html'],
    ['patch', 'diff'], ['jsonc', 'json'], ['scss', 'css']]) assert.equal(languageOf(alias), name, alias);
  assert.equal(languageOf('klingon'), null);
  assert.equal(highlight('if x', 'klingon'), null);
  assert.equal(languageOf('constructor'), null);
});

test('JavaScript and TypeScript', () => {
  const js = 'import x from "y";\n// note\nconst a = `t ${b}` + 0x1f; /* c\n */ function go(n) { return n ?? null; }';
  has(js, 'js', ['pl-k', 'import'], ['pl-s', '&quot;y&quot;'], ['pl-c', '// note'], ['pl-k', 'const'],
    ['pl-s', '`t ${b}`'], ['pl-c1', '0x1f'], ['pl-c', '/* c\n */'], ['pl-en', 'go'], ['pl-k', 'return'], ['pl-c1', 'null']);
  has('interface P { x: number }\n@Component\nclass C implements P {}', 'ts',
    ['pl-k', 'interface'], ['pl-en', 'P'], ['pl-k', 'number'], ['pl-en', '@Component'], ['pl-en', 'C'], ['pl-k', 'implements']);
  // a name that merely contains a keyword is no keyword
  assert.deepEqual(tokens('format(classy)', 'js'), [['pl-en', 'format']]);
});

test('Python', () => {
  has('@cache\ndef f(x=1.5e-3):  # why\n    return f"{x}" if x is not None else b\'\'\n"""doc\nstring"""', 'py',
    ['pl-en', '@cache'], ['pl-k', 'def'], ['pl-en', 'f'], ['pl-c1', '1.5e-3'], ['pl-c', '# why'], ['pl-s', 'f&quot;{x}&quot;'],
    ['pl-k', 'is'], ['pl-k', 'not'], ['pl-c1', 'None'], ['pl-s', "b''"], ['pl-s', '&quot;&quot;&quot;doc\nstring&quot;&quot;&quot;']);
});

test('shell', () => {
  const sh = '#!/bin/sh\nif [ -n "$HOME" ]; then echo ${PATH} $1 # done\nfi\nls -la docs/if.md';
  has(sh, 'bash', ['pl-c', '#!/bin/sh'], ['pl-k', 'if'], ['pl-k', 'then'], ['pl-c1', 'echo'], ['pl-smi', '${PATH}'],
    ['pl-smi', '$1'], ['pl-c', '# done'], ['pl-k', 'fi']);
  // variables inside double quotes, not inside single ones; # inside a word is no comment
  assert.match(highlight('"a $X" \'b $Y\' a#b', 'sh'),
    /^<span class="pl-s">&quot;a <span class="pl-smi">\$X<\/span>&quot;<\/span> <span class="pl-s">'b \$Y'<\/span> a#b$/);
  // options and paths are not keywords
  assert.deepEqual(tokens('ls --if ./done', 'sh'), []);
});

test('JSON and YAML', () => {
  assert.deepEqual(tokens('{"a": [1, true, null, "s"]}', 'json'),
    [['pl-ent', '&quot;a&quot;'], ['pl-c1', '1'], ['pl-c1', 'true'], ['pl-c1', 'null'], ['pl-s', '&quot;s&quot;']]);
  const y = '---\nname: CI # the name\non:\n  push:\n    branches: [ master ]\nn: 3\n- "q"\nurl: http://a:b\nrun: |\n  npm test\n  x: y\nk: ~';
  has(y, 'yaml', ['pl-c1', '---'], ['pl-ent', 'name'], ['pl-s', 'CI'], ['pl-c', '# the name'], ['pl-ent', 'on'],
    ['pl-ent', 'push'], ['pl-ent', 'branches'], ['pl-s', 'master'], ['pl-c1', '3'], ['pl-s', '&quot;q&quot;'],
    ['pl-s', 'http://a:b'], ['pl-k', '|'], ['pl-s', '  npm test'], ['pl-s', '  x: y'], ['pl-c1', '~']);
});

test('C, C++, Java, Rust and Go', () => {
  has('#include <stdio.h>\nstruct P { int x; };\nint main(void) { return NULL; }', 'c',
    ['pl-k', '#include'], ['pl-s', '&lt;stdio.h&gt;'], ['pl-k', 'struct'], ['pl-en', 'P'], ['pl-en', 'main'], ['pl-c1', 'NULL']);
  has('template <typename T> class V : public B {};\nauto p = nullptr;', 'cpp',
    ['pl-k', 'template'], ['pl-k', 'typename'], ['pl-en', 'V'], ['pl-k', 'public'], ['pl-c1', 'nullptr']);
  has('@Override\npublic static void main(String[] a) { char c = \'x\'; }', 'java',
    ['pl-en', '@Override'], ['pl-k', 'static'], ['pl-en', 'main'], ['pl-s', "'x'"]);
  has("fn f<'a>(s: &'a str) -> Option<u8> { let c = '\\n'; println!(\"{}\", s); None }", 'rust',
    ['pl-k', 'fn'], ['pl-en', 'f'], ['pl-k', "'a"], ['pl-k', 'str'], ['pl-s', "'\\n'"], ['pl-en', 'println!'], ['pl-c1', 'None']);
  has('func (s *S) Run() error { return fmt.Errorf(`raw\n%v`, nil) }', 'go',
    ['pl-k', 'func'], ['pl-en', 'Run'], ['pl-en', 'Errorf'], ['pl-s', '`raw\n%v`'], ['pl-c1', 'nil']);
});

test('HTML, CSS and diff', () => {
  has('<!DOCTYPE html>\n<a href="x" hidden>A &amp; B<!-- c --></a>', 'html',
    ['pl-c1', '&lt;!DOCTYPE html&gt;'], ['pl-kos', '&lt;'], ['pl-ent', 'a'], ['pl-c1', 'href'], ['pl-s', '&quot;x&quot;'],
    ['pl-c1', 'hidden'], ['pl-c1', '&amp;amp;'], ['pl-c', '&lt;!-- c --&gt;'], ['pl-kos', '&lt;/']);
  has('@media (max-width: 9px) {\n.a > p:hover, #id { color: #fff !important; margin: -1.5em 0; /* c */ }\n}', 'css',
    ['pl-k', '@media'], ['pl-c1', 'max-width'], ['pl-c1', '9px'], ['pl-e', '.a'], ['pl-ent', 'p'], ['pl-e', ':hover'],
    ['pl-e', '#id'], ['pl-c1', 'color'], ['pl-c1', '#fff'], ['pl-k', '!important'], ['pl-c1', '-1.5em'], ['pl-c', '/* c */']);
  assert.equal(highlight('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n same', 'diff'),
    '<span class="pl-mh">--- a/f</span>\n<span class="pl-mh">+++ b/f</span>\n<span class="pl-mdr">@@ -1 +1 @@</span>\n'
    + '<span class="pl-md"><span class="pl-md">-</span>old</span>\n<span class="pl-mi1"><span class="pl-mi1">+</span>new</span>\n same');
});

test('the output is the source, escaped, and nothing but pl- spans', () => {
  const nasty = '<script>alert("x")</script> \' " & </span> <img onerror=x>\n/* <b> */ "</code>" `${"<"}`';
  for (const lang of ['js', 'ts', 'python', 'sh', 'json', 'yaml', 'c', 'cpp', 'java', 'rust', 'go', 'html', 'css', 'diff']) {
    const out = highlight(nasty, lang);
    assert.equal(text(out), escaped(nasty), lang);
    for (const tag of out.match(/<[^>]*>/g) ?? []) assert.match(tag, /^(?:<span class="pl-[a-z0-9]+">|<\/span>)$/, `${lang}: ${tag}`);
  }
});

test('linear time, also on input made to make it backtrack', () => {
  const line = { js: 'const v = f("s", 2.5) + `t` // c', python: 'v = f("s", 2.5)  # c', sh: 'echo "$v" ${x} # c',
    json: '{"k": [1, "s", true]},', yaml: 'key: "v" # c', c: 'int v = f("s", 2.5); // c', rust: "let v: &'a str = f(\"s\"); // c",
    go: 'v := f("s", 2.5) // c', java: 'int v = f("s", 2.5); // c', html: '<a href="x">t &amp; u</a>', css: '.a { color: #fff; }',
    diff: '+ added line' };
  for (const [lang, l] of Object.entries(line)) {
    const big = Array(5000).fill(l).join('\n');
    highlight(l, lang);
    const t = performance.now();
    highlight(big, lang);
    const ms = performance.now() - t;
    assert.ok(ms < 100, `${lang}: 5,000 lines took ${ms.toFixed(1)} ms`);
  }
  // 100,000 characters each: anything quadratic would take seconds
  const n = 100000;
  for (const [lang, s] of [['yaml', 'a' + ' '.repeat(n) + 'x'], ['yaml', 'a:b'.repeat(n / 3)], ['js', '"'.repeat(n)],
    ['js', '/*'.repeat(n / 2)], ['css', '{' + 'a:'.repeat(n / 2)], ['css', '{' + 'a'.repeat(n)], ['html', '<a '.repeat(n / 3)],
    ['html', '&'.repeat(n) + '<'], ['sh', '$'.repeat(n)], ['sh', '"$'.repeat(n / 2)], ['python', "'''".repeat(n / 3)],
    ['c', '#'.repeat(n)], ['rust', "'".repeat(n)], ['go', '`'.repeat(n)], ['yaml', '- '.repeat(n / 2)]]) {
    const t = performance.now();
    highlight(s, lang);
    const ms = performance.now() - t;
    assert.ok(ms < 500, `${lang} on ${JSON.stringify(s.slice(0, 6))}…: ${ms.toFixed(1)} ms`);
  }
});
