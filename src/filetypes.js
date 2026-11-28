// What a file in a repository is, for the editor: Markdown (edited beside its rendered page),
// other text (edited, coloured as code when its language is known), or not text at all
// (binary, or too large: listed, but opened on github.com instead).
//
// Pure: paths and bytes in, answers out.

import { languageOf } from './highlight.js';

export const MARKDOWN_EXT = /\.(md|markdown|mdown|mkdn|mkd|mdx|rmd)$/i;

/** The largest file the editor opens (as UTF-8 bytes); larger ones are opened on GitHub. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const baseName = (path) => String(path).slice(String(path).lastIndexOf('/') + 1);

/** A Markdown file: shown rendered beside its source, with the Markdown toolbar. */
export const isMarkdown = (path) => MARKDOWN_EXT.test(baseName(path));

// Extensions of files that are not text, whatever their content (so they are not even read).
// SVG, XML, CSV and the like are text, and edited as such.
const BINARY_EXT = new Set(`
  png jpg jpeg jfif gif webp bmp ico icns tif tiff avif heic heif psd xcf ai eps raw cr2 nef dng
  zip gz tgz bz2 tbz2 xz txz 7z rar tar zst lz lz4 lzma cab jar war ear apk aab ipa deb rpm msi dmg iso img
  woff woff2 ttf otf eot pfb
  pdf doc docx xls xlsx ppt pptx odt ods odp odg pages numbers key epub mobi
  exe dll so dylib a lib o obj ko class pyc pyo pyd wasm elf bin
  mp3 mp4 m4a m4v wav ogg oga ogv flac aac opus wma webm mov avi mkv wmv flv mid midi
  sqlite sqlite3 db mdb accdb dat npy npz pkl pickle h5 hdf5 parquet feather onnx pt pth ckpt safetensors tflite
  swf fla blend fbx glb 3ds max dwg skp stl
  keystore jks p12 pfx der crt cer
`.split(/\s+/).filter(Boolean));

/** Whether a path's extension says it is no text file (an image, an archive, a font, …). */
export function isBinaryPath(path) {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 && BINARY_EXT.has(name.slice(dot + 1));
}

/**
 * A file's bytes as text, or null when they are not text: a NUL byte in the first 8,000
 * (as git decides), or not valid UTF-8 (a UTF-16 file has NULs; Latin-1 is not UTF-8 either,
 * and saving it as UTF-8 would change every accented letter).
 * @param {Uint8Array} bytes
 * @returns {string|null}
 */
export function decodeText(bytes) {
  const head = Math.min(bytes.length, 8000);
  for (let i = 0; i < head; i++) if (bytes[i] === 0) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// Files known by their name rather than an extension (lower case).
const NAMES = {
  makefile: 'make', gnumakefile: 'make', 'makefile.am': 'make', 'makefile.in': 'make',
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  '.gitignore': 'conf', '.dockerignore': 'conf', '.npmignore': 'conf', '.eslintignore': 'conf', '.prettierignore': 'conf',
  '.gitattributes': 'conf', '.hgignore': 'conf', codeowners: 'conf', 'requirements.txt': 'conf', '.nvmrc': 'conf',
  '.gitmodules': 'ini', '.gitconfig': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini', '.yarnrc': 'ini', 'setup.cfg': 'ini',
  'tox.ini': 'ini', '.flake8': 'ini', '.pylintrc': 'ini', '.coveragerc': 'ini',
  '.env': 'shell', '.bashrc': 'shell', '.bash_profile': 'shell', '.bash_aliases': 'shell', '.zshrc': 'shell', '.zprofile': 'shell',
  '.profile': 'shell', '.envrc': 'shell', pkgbuild: 'shell', apkbuild: 'shell',
  gemfile: 'ruby', rakefile: 'ruby', vagrantfile: 'ruby', podfile: 'ruby', brewfile: 'ruby', guardfile: 'ruby', fastfile: 'ruby',
  '.babelrc': 'json', '.eslintrc': 'json', '.prettierrc': 'json', '.jshintrc': 'json', '.swcrc': 'json', 'flake.lock': 'json',
  'pipfile': 'toml', 'cargo.lock': 'toml', 'poetry.lock': 'toml', 'uv.lock': 'toml',
  '.clang-format': 'yaml', '.clang-tidy': 'yaml',
};

// Files that are Markdown-free and colourless but have no extension: a new file named so
// is created as it is (not as name.md).
const PLAIN_NAMES = new Set(['license', 'licence', 'copying', 'authors', 'contributors', 'notice', 'procfile',
  'jenkinsfile', 'justfile', 'owners', 'maintainers', 'version', 'cname', 'unlicense', 'patents']);

const SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?([A-Za-z]+)/;
const INTERPRETERS = {
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', dash: 'shell', ash: 'shell',
  python: 'python', pypy: 'python', node: 'js', deno: 'ts', bun: 'js', ruby: 'ruby', lua: 'lua', make: 'make',
};

/**
 * How the editor treats the file at `path`: 'markdown', a language highlight.js colours, or
 * null (plain text). `firstLine`, if given, may name the language of a script without an
 * extension (#!/usr/bin/env python3).
 */
export function fileLanguage(path, firstLine = '') {
  if (isMarkdown(path)) return 'markdown';
  const name = baseName(path).toLowerCase();
  if (Object.hasOwn(NAMES, name)) return NAMES[name];
  if (/^(?:docker|container)file[.-]/.test(name) || name.endsWith('.dockerfile')) return 'dockerfile';
  if (/^makefile[.-]/.test(name)) return 'make';
  if (/^\.env\./.test(name)) return 'shell';
  if (/^requirements[\w.-]*\.txt$/.test(name)) return 'conf';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 || (dot === 0 && name.indexOf('.', 1) > 0) ? name.slice(dot + 1) : '';
  const lang = ext ? languageOf(ext) : null;
  if (lang) return lang;
  const m = firstLine.startsWith('#!') && firstLine.match(SHEBANG);
  if (m) {
    const interp = m[1].replace(/\d+$/, '').toLowerCase();
    if (Object.hasOwn(INTERPRETERS, interp)) return INTERPRETERS[interp];
  }
  return null;
}

/**
 * The path a new file is created at, from what was typed: as it is when it has an
 * extension, is a dotfile or a known name without one (Makefile, LICENSE); otherwise with
 * `.md` added. Refuses a binary file, which the editor cannot write.
 * @returns {{path: string}|{error: string}}
 */
export function newFilePath(typed) {
  const path = String(typed);
  const name = baseName(path);
  if (!name) return { error: 'Give the file a name.' };
  if (isBinaryPath(path)) return { error: `${name} would not be a text file: meditor edits text files only. Upload it on GitHub.` };
  const lower = name.toLowerCase();
  const known = name.startsWith('.') || /\.[^.]+$/.test(name) || Object.hasOwn(NAMES, lower) || PLAIN_NAMES.has(lower);
  return { path: known ? path : `${path}.md` };
}

