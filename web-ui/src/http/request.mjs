// Request helpers: public path mapping, origin checks and client address.
import { isIP } from 'node:net';
import { config } from '../config.mjs';

export function getPublicPath(pathname) {
  if (!pathname.startsWith(config.prefix)) return null;
  const local = pathname.slice(config.prefix.length) || '/';
  return local.startsWith('/') ? local : `/${local}`;
}

export function isAllowedOrigin(req, required = false) {
  const origin = String(req.headers.origin || '');
  if (!origin) return !required;
  if (config.authOrigin) return origin === config.authOrigin;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const requestHost = forwardedHost || String(req.headers.host || '').split(',')[0].trim();
  if (!requestHost || parsed.host.toLowerCase() !== requestHost.toLowerCase()) return false;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return !forwardedProto || parsed.protocol === `${forwardedProto}:`;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Client address for rate limiting. A forwarded header is only trusted when the TCP
 * peer is the local reverse proxy; otherwise anyone could rotate it to dodge limits.
 */
export function getClientIp(req) {
  const peer = req.socket.remoteAddress || 'unknown';
  if (!config.clientIpHeader || !LOOPBACK.has(peer)) return peer;
  const forwarded = String(req.headers[config.clientIpHeader] || '').split(',')[0].trim();
  return forwarded.length <= 64 && isIP(forwarded) ? forwarded : peer;
}

/** Methods that change state must come from our own origin (CSRF defence in depth). */
export function isSafeMethod(method) {
  return method === 'GET' || method === 'HEAD';
}
