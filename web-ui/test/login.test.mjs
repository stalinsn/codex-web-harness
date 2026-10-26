import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractHints, plainText } from '../src/accounts/login-sessions.mjs';

test('terminal text drops escape sequences', () => {
  assert.equal(plainText('\x1b[1mOlá\x1b[0m'), 'Olá');
  assert.equal(plainText('a\rb'), 'a\nb');
});

test('links wrapped by a TUI are joined and device codes are found', () => {
  const cols = 40;
  const url = 'https://accounts.google.com/o/oauth2/auth?client_id=123&scope=abc&state=xyz';
  const wrapped = `│ ${url.slice(0, cols - 2)}\n│ ${url.slice(cols - 2)}\nDigite o código ABCD-12345`;
  const hints = extractHints(wrapped, cols);
  assert.deepEqual(hints.links, [url]);
  assert.deepEqual(hints.codes, ['ABCD-12345']);
});

test('tokens are captured only when complete and never glued to the next word', async () => {
  const { captureToken } = await import('../src/accounts/login-sessions.mjs');
  const pattern = 'sk-ant-oat[0-9]*-[A-Za-z0-9_-]{20,}';
  const token = `sk-ant-oat01-${'A'.repeat(90)}`;
  assert.equal(captureToken(`Your token:\n${token.slice(0, 40)}`, pattern), null);
  assert.equal(captureToken(`Your token:\n${token}\x1b[2K\x1b[1GStore it`, pattern)[0], token);
  assert.equal(captureToken(`${token}\r\n`, pattern)[0], token);
});
