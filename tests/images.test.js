import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageExt, slugify, proposeImagePath, imageMarkdown, referencedPaths, formatSize } from '../src/images.js';

test('image file extensions', () => {
  assert.equal(imageExt('image/png'), 'png');
  assert.equal(imageExt('image/jpeg', 'x.jpeg'), 'jpg');
  assert.equal(imageExt('', 'Photo.JPEG'), 'jpg');
  assert.equal(imageExt('image/svg+xml'), 'svg');
  assert.equal(imageExt('', 'noext'), 'png');
});

test('slugs', () => {
  assert.equal(slugify('My Screenshot (2).PNG'), 'my-screenshot-2-png');
  assert.equal(slugify('Příliš žluťoučký'), 'prilis-zlutoucky');
  assert.equal(slugify('***'), '');
});

test('a pasted screenshot is named after the document, beside it', () => {
  const taken = new Set(['docs/images/guide-1.png']);
  const has = (p) => taken.has(p);
  assert.deepEqual(proposeImagePath('docs/guide.md', { name: 'image.png', type: 'image/png' }, has),
    { path: 'docs/images/guide-2.png', rel: 'images/guide-2.png' });
  assert.deepEqual(proposeImagePath('README.md', { name: 'image.png', type: 'image/png' }, has),
    { path: 'images/readme-1.png', rel: 'images/readme-1.png' });
  assert.deepEqual(proposeImagePath('Über uns.md', { type: 'image/jpeg' }, has).rel, 'images/uber-uns-1.jpg');
});

test('a dropped file keeps its name, numbered only if taken', () => {
  const taken = new Set(['docs/images/arch-diagram.png']);
  const has = (p) => taken.has(p);
  assert.equal(proposeImagePath('docs/guide.md', { name: 'Flow Chart.svg', type: 'image/svg+xml' }, has).rel, 'images/flow-chart.svg');
  assert.equal(proposeImagePath('docs/guide.md', { name: 'arch diagram.png', type: 'image/png' }, has).rel, 'images/arch-diagram-1.png');
});

test('the Markdown for the images', () => {
  assert.equal(imageMarkdown(['images/a-1.png']), '![](images/a-1.png)');
  assert.equal(imageMarkdown(['images/a-1.png', 'images/a-2.png']), '![](images/a-1.png)\n![](images/a-2.png)');
});

test('which repository paths the text refers to', () => {
  const text = [
    '![](images/a-1.png) and ![alt](images/a-2.png "title")',
    '[a link](../README.md#x) [ext](https://x.org/y.png) [anchor](#top)',
    '![](<images/with space.png>)',
    '[ref]: images/ref.png',
    '<img src="images/html.png" width=10> <img src=images/bare.gif>',
  ].join('\n');
  assert.deepEqual([...referencedPaths(text, 'docs/guide.md')].sort(), [
    'README.md', 'docs/images/a-1.png', 'docs/images/a-2.png', 'docs/images/bare.gif',
    'docs/images/html.png', 'docs/images/ref.png', 'docs/images/with space.png',
  ]);
  assert.deepEqual([...referencedPaths('![](images/a%201.png)', 'x.md')], ['images/a 1.png']);
  assert.equal(referencedPaths('no links here', 'x.md').size, 0);
});

test('sizes', () => {
  assert.equal(formatSize(900), '900 B');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(200 * 1024), '200 KB');
  assert.equal(formatSize(3.5 * 1024 * 1024), '3.5 MB');
});
