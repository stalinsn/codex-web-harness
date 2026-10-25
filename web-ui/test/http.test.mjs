import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getClientIp, getPublicPath, isAllowedOrigin, isSafeMethod } from '../src/http/request.mjs';
import { Router } from '../src/http/router.mjs';

const req = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } });

test('router matches method, exact paths and regex params', () => {
  const router = new Router();
  const list = () => 'list';
  const item = () => 'item';
  router.get('/api/threads', list).post(/^\/api\/threads\/([a-z]+)\/rename$/, item);
  assert.equal(router.match('GET', '/api/threads').handler, list);
  assert.equal(router.match('POST', '/api/threads'), null);
  assert.deepEqual(router.match('POST', '/api/threads/abc/rename').params, ['abc']);
  assert.equal(router.match('POST', '/api/threads/ABC/rename'), null);
});

test('public paths stay under the prefix', () => {
  assert.equal(getPublicPath('/codex-agent'), '/');
  assert.equal(getPublicPath('/codex-agent/api/x'), '/api/x');
  assert.equal(getPublicPath('/other'), null);
});

test('client IP header is only trusted from the local proxy', () => {
  assert.equal(getClientIp(req({ 'x-real-ip': '203.0.113.9' })), '203.0.113.9');
  assert.equal(getClientIp(req({ 'x-real-ip': '203.0.113.9' }, '198.51.100.7')), '198.51.100.7');
  assert.equal(getClientIp(req({ 'cf-connecting-ip': '203.0.113.9' })), '127.0.0.1');
  assert.equal(getClientIp(req({ 'x-real-ip': 'not-an-ip' })), '127.0.0.1');
});

test('origin checks follow host and forwarded proto', () => {
  assert.equal(isAllowedOrigin(req({ host: 'a.example' })), true);
  assert.equal(isAllowedOrigin(req({ host: 'a.example' }), true), false);
  assert.equal(isAllowedOrigin(req({ host: 'a.example', origin: 'https://a.example', 'x-forwarded-proto': 'https' }), true), true);
  assert.equal(isAllowedOrigin(req({ host: 'a.example', origin: 'http://a.example', 'x-forwarded-proto': 'https' }), true), false);
  assert.equal(isAllowedOrigin(req({ host: 'a.example', origin: 'https://evil.example' }), true), false);
  assert.equal(isSafeMethod('GET') && !isSafeMethod('DELETE'), true);
});
