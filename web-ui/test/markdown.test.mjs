import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdown } from '../public/js/markdown.js';

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
