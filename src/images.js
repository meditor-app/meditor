// Images pasted or dropped into a document: where they go in the repository, the Markdown
// that shows them, and which of them the text still uses when it is committed.
//
// An image is put next to the document, in an `images/` directory beside it, and linked
// relatively (`![](images/guide-1.png)`), so the link works on github.com as well.

import { resolveRef, dirname, basename } from './links.js';

const TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

/** The file extension for an image, from its type, else from its name ('png' at worst). */
export function imageExt(type, name = '') {
  if (TYPES[type]) return TYPES[type];
  const m = String(name).match(/\.([a-z0-9]{1,5})$/i);
  return m ? m[1].toLowerCase().replace(/^jpeg$/, 'jpg') : 'png';
}

/** "My Screenshot (2).PNG" → "my-screenshot-2" */
export function slugify(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/**
 * Where an image pasted into the document at `docPath` goes.
 * A file with a name of its own (a dropped `diagram.png`) keeps it; a pasted screenshot, which
 * browsers all call `image.png`, is named after the document: `images/<document>-<n>.png`.
 * @param {{name?: string, type?: string}} file
 * @param {(path: string) => boolean} taken whether a path is in use (in the branch, or pending)
 * @returns {{path: string, rel: string}} the path in the repository, and the link from the document
 */
export function proposeImagePath(docPath, file, taken) {
  const ext = imageExt(file.type, file.name);
  const own = String(file.name || '').replace(/\.[^.]*$/, '');
  const generic = !own || /^(image|clipboard|pasted|untitled|blob)(-\d+)?$/i.test(own);
  const stem = (!generic && slugify(own)) || slugify(basename(docPath).replace(/\.[^.]*$/, '')) || 'image';
  const dir = dirname(docPath);
  for (let n = generic ? 1 : 0; ; n++) {
    const rel = `images/${stem}${n ? `-${n}` : ''}.${ext}`;
    const path = dir ? `${dir}/${rel}` : rel;
    if (!taken(path)) return { path, rel };
  }
}

/** The Markdown inserted for the images: one per line, empty alt text for the writer to fill. */
export function imageMarkdown(rels) {
  return rels.map((r) => `![](${r})`).join('\n');
}

/**
 * The repository paths the text refers to, by the URL of a link or image, a reference
 * definition, or an HTML `src`/`href`. Generous on purpose: it decides which pending images
 * are committed, and keeping one the text does not show costs less than dropping one it does.
 */
export function referencedPaths(text, docPath) {
  const urls = [];
  const take = (re, i = 1) => { for (const m of text.matchAll(re)) urls.push(m[i]); };
  take(/\]\(\s*<([^>\n]*)>/g); // [x](<a b.png>)
  take(/\]\(\s*([^\s)<]+)/g); // [x](a.png "title")
  take(/^ {0,3}\[[^\]\n]+\]:\s*<?([^\s>]+)/gm); // [x]: a.png
  take(/\b(?:src|href)\s*=\s*["']?([^"'\s>]+)/gi); // <img src="a.png">
  const out = new Set();
  for (const u of urls) {
    const r = resolveRef(u, { path: docPath });
    if (r.kind === 'repo') out.add(r.path);
  }
  return out;
}

/** 1234 → "1.2 KB" */
export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
