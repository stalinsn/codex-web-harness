import assert from 'node:assert/strict';
import { test } from 'node:test';
// markdown.js loads browser state (localStorage) through config.js; give Node a stub first.
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { markdown } = await import('../public/js/markdown.js');

test('markdown escapes HTML and only links http(s) URLs', () => {
  const html = markdown('<img src=x onerror=alert(1)> [a](javascript:alert(1)) [b](https://example.com)');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(html.includes('<a href="https://example.com" target="_blank" rel="noopener noreferrer">b</a>'));
});

test('markdown renders code blocks, lists and tables', () => {
  const html = markdown('# T\n\n- a\n- b\n\n```js\nx < 1\n```\n\n| A | B |\n| --- | :---: |\n| 1 | 2 |');
  assert.ok(html.includes('<h1>T</h1>'));
  assert.ok(html.includes('<ul><li>a</li><li>b</li></ul>'));
  assert.ok(html.includes('<code class="language-js">x &lt; 1</code>'));
  assert.ok(html.includes('<th style="text-align:center">B</th>'));
});

test('markdown renders local project images and HTML previews', () => {
  const html = markdown('![Tela 1](/home/ubuntu/projects/app/docs/tela-1.png) [Mockup](/home/ubuntu/projects/app/docs/mockup.html) [Notas](/home/ubuntu/projects/app/notes.txt)');
  assert.match(html, /class="local-image-button" data-preview-image="[^"]*local-files\?path=%2Fhome%2Fubuntu%2Fprojects%2Fapp%2Fdocs%2Ftela-1\.png&amp;preview=1"/);
  assert.match(html, /<img src="[^"]*preview=1" alt="Tela 1" loading="lazy">/);
  assert.match(html, /class="local-preview-card" data-local-preview="[^"]*mockup\.html&amp;preview=1"/);
  assert.match(html, /<a class="local-file-link" href="[^"]*notes\.txt"/);
  assert.ok(!html.includes('notes.txt&amp;preview'));
});

test('local previews escape labels and ignore non-local images', () => {
  const html = markdown('![<b>x</b>](/home/u/projects/a.png) ![r](https://example.com/a.png) [<i>m</i>](/home/u/projects/m.html)');
  assert.ok(!html.includes('<b>x'));
  assert.ok(!html.includes('<i>m'));
  assert.ok(!html.includes('src="https://example.com'));
});
