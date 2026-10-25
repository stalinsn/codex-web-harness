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

export function getClientIp(req) {
  const forwarded = String(req.headers['cf-connecting-ip'] || '').trim();
  if (forwarded.length <= 64 && isIP(forwarded)) return forwarded;
  return req.socket.remoteAddress || 'unknown';
}
