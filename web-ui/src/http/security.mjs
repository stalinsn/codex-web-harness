// Baseline security headers for every response.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // Inline style attributes are used for meters and colours.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: data:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ');

export function applySecurityHeaders(res, { scriptHashes = [] } = {}) {
  const policy = scriptHashes.length
    ? CONTENT_SECURITY_POLICY.replace("script-src 'self'", `script-src 'self' ${scriptHashes.map((hash) => `'${hash}'`).join(' ')}`)
    : CONTENT_SECURITY_POLICY;
  res.setHeader('Content-Security-Policy', policy);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self), payment=(), usb=()');
}
