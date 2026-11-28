import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMarkdown, isBinaryPath, isBinaryContent, notTextKind, fileLanguage, newFilePath, MAX_TEXT_BYTES,
} from '../src/filetypes.js';
import { GitHub, bytesToBase64, encodeBase64 } from '../src/github.js';
import { newFileText } from '../src/drafts.js';

test('Markdown files, by extension', () => {
  for (const p of ['README.md', 'docs/a.markdown', 'x.MDX', 'notes.Rmd']) assert.ok(isMarkdown(p), p);
  for (const p of ['md', 'README', 'a.md.txt', 'docs.md/x.js', 'x.mdc']) assert.ok(!isMarkdown(p), p);
});

test('binary files, by extension', () => {
  for (const p of ['logo.png', 'docs/img/A.JPG', 'font.woff2', 'paper.pdf', 'a.tar.gz', 'x.zip', 'app.exe', 'm.mp4', 'w.wasm', 'data.sqlite']) {
    assert.ok(isBinaryPath(p), p);
  }
  // text, whatever the name suggests to a person
  for (const p of ['icon.svg', 'data.csv', 'a.xml', 'Makefile', '.png', 'png', 'x.png.md', 'notes.txt', 'docs.pdf/README.md']) {
    assert.ok(!isBinaryPath(p), p);
  }
});

test('binary content: NUL bytes in the first 8,000; and by name or size', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.equal(isBinaryContent(enc('Příliš žluťoučký kůň 🐎\n')), false);
  assert.equal(isBinaryContent(new Uint8Array()), false);
  assert.equal(isBinaryContent(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])), true); // a PNG
  assert.equal(isBinaryContent(new Uint8Array([0xff, 0xfe, 0x61, 0x00])), true); // UTF-16
  // a NUL far into a file does not make it binary by itself (as git decides)
  assert.equal(isBinaryContent(enc('a'.repeat(9000) + '\0')), false);
  assert.equal(notTextKind('logo.png', 10), 'binary');
  assert.equal(notTextKind('a.json', MAX_TEXT_BYTES + 1), 'large');
  assert.equal(notTextKind('a.json', MAX_TEXT_BYTES), '');
  assert.equal(notTextKind('a.json'), '');
});

test('a file\'s language: by extension, by name, by #! line', () => {
  const cases = {
    'README.md': 'markdown', 'src/app.js': 'js', 'x.mjs': 'js', 'a.tsx': 'ts', 'a.d.ts': 'ts', 'p.py': 'python',
    'run.sh': 'shell', 'c.json': 'json', '.eslintrc.json': 'json', 'ci.yml': 'yaml', 'Cargo.toml': 'toml',
    'setup.cfg': 'ini', 'x.ini': 'ini', 'a.properties': 'ini', 'm.c': 'c', 'm.h': 'c', 'm.cpp': 'cpp', 'M.java': 'java',
    'm.go': 'go', 'm.rs': 'rust', 'i.html': 'html', 'icon.svg': 'html', 'pom.xml': 'html', 's.css': 'css', 's.scss': 'scss',
    'fix.patch': 'diff', 'm.rb': 'ruby', 'm.kt': 'kotlin', 'm.cs': 'csharp', 'q.sql': 'sql', 'm.lua': 'lua', 'm.swift': 'swift',
    Makefile: 'make', 'sub/GNUmakefile': 'make', 'rules.mk': 'make', Dockerfile: 'dockerfile', 'Dockerfile.dev': 'dockerfile',
    'web.dockerfile': 'dockerfile', '.gitignore': 'conf', 'docs/.gitignore': 'conf', '.gitattributes': 'conf',
    '.editorconfig': 'ini', '.gitmodules': 'ini', '.env': 'shell', '.env.local': 'shell', '.bashrc': 'shell',
    Gemfile: 'ruby', 'requirements-dev.txt': 'conf', '.babelrc': 'json', 'Cargo.lock': 'toml',
    'notes.txt': null, LICENSE: null, 'data.csv': null, 'x.unknown': null, '.hidden': null,
  };
  for (const [path, lang] of Object.entries(cases)) assert.equal(fileLanguage(path), lang, path);
  // scripts without an extension
  assert.equal(fileLanguage('bin/deploy', '#!/bin/bash'), 'shell');
  assert.equal(fileLanguage('bin/tool', '#!/usr/bin/env python3'), 'python');
  assert.equal(fileLanguage('bin/tool', '#!/usr/bin/env -S node --flag'), 'js');
  assert.equal(fileLanguage('bin/tool', '#!/usr/bin/perl'), null);
  assert.equal(fileLanguage('bin/tool', '# not a shebang'), null);
  // the extension wins
  assert.equal(fileLanguage('x.rb', '#!/bin/sh'), 'ruby');
  assert.equal(fileLanguage('x.md', '#!/bin/sh'), 'markdown');
  // a name that is an Object.prototype key is no language
  assert.equal(fileLanguage('constructor'), null);
  assert.equal(fileLanguage('x.constructor'), null);
});

test('a new file: any text, .md added to a bare name, binary refused', () => {
  assert.deepEqual(newFilePath('docs/intro'), { path: 'docs/intro.md' });
  assert.deepEqual(newFilePath('docs/intro.md'), { path: 'docs/intro.md' });
  assert.deepEqual(newFilePath('src/app.js'), { path: 'src/app.js' });
  assert.deepEqual(newFilePath('v1.2/notes.txt'), { path: 'v1.2/notes.txt' });
  assert.deepEqual(newFilePath('v1.2/notes'), { path: 'v1.2/notes.md' });
  for (const p of ['Makefile', 'sub/Dockerfile', 'LICENSE', '.gitignore', 'docs/.nojekyll', 'Gemfile']) {
    assert.deepEqual(newFilePath(p), { path: p }, p);
  }
  assert.match(newFilePath('img/logo.png').error, /logo\.png .*text/);
  assert.ok(newFilePath('').error);
});

test('a new file starts with a heading only if it is Markdown', () => {
  assert.equal(newFileText('docs/how-to.md'), '# How to\n\n');
  assert.equal(newFileText('src/app.js'), '');
  assert.equal(newFileText('Makefile'), '');
});

function fake(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push(url);
    const r = routes[`${init.method} ${url.replace('https://api.github.com', '')}`];
    if (!r) return { ok: false, status: 404, headers: new Map(), json: async () => ({ message: 'Not Found' }) };
    return { ok: true, status: 200, headers: new Map(), json: async () => r };
  };
  f.calls = calls;
  return f;
}

test('getFile says when a file is not text, or too large, rather than mangle it', async () => {
  const png = bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]));
  const latin1 = bytesToBase64(new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
  const f = fake({
    'GET /repos/o/r/contents/a.js?ref=main': { type: 'file', sha: 's1', size: 9, encoding: 'base64', content: encodeBase64('let a = 1') },
    'GET /repos/o/r/contents/img.dat?ref=main': { type: 'file', sha: 's2', size: 8, encoding: 'base64', content: png },
    'GET /repos/o/r/contents/old.txt?ref=main': { type: 'file', sha: 's3', size: 4, encoding: 'base64', content: latin1 },
    'GET /repos/o/r/contents/big.json?ref=main': { type: 'file', sha: 's4', size: MAX_TEXT_BYTES + 1, encoding: 'none', content: '' },
    // between 1 MB and the limit: read through the blob API, as before
    'GET /repos/o/r/contents/mid.csv?ref=main': { type: 'file', sha: 's5', size: 1500000, encoding: 'none', content: '' },
    'GET /repos/o/r/git/blobs/s5': { content: encodeBase64('a,b\n'), encoding: 'base64' },
  });
  const gh = new GitHub('T', f);
  const plain = { eol: '\n', bom: false, utf8: true };
  assert.deepEqual(await gh.getFile('o', 'r', 'a.js', 'main'), { text: 'let a = 1', sha: 's1', format: plain });
  assert.deepEqual(await gh.getFile('o', 'r', 'img.dat', 'main'), { text: null, sha: 's2', size: 8, binary: true });
  // not UTF-8 (Latin-1 "café"): not opened either, rather than shown and saved with U+FFFD
  assert.deepEqual(await gh.getFile('o', 'r', 'old.txt', 'main'), { text: null, sha: 's3', size: 4, binary: true, notUtf8: true });
  assert.deepEqual(await gh.getFile('o', 'r', 'big.json', 'main'), { text: null, sha: 's4', size: MAX_TEXT_BYTES + 1, tooLarge: true });
  assert.ok(!f.calls.some((u) => u.includes('/git/blobs/s4')), 'a file too large is not downloaded');
  assert.deepEqual(await gh.getFile('o', 'r', 'mid.csv', 'main'), { text: 'a,b\n', sha: 's5', format: plain });
});
