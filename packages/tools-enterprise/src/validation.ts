/**
 * Input validation helpers for enterprise connectors.
 *
 * Prevents path traversal, SSRF, injection, and other OWASP Top 10 issues
 * by sanitising all user-supplied values before they reach URL construction
 * or request bodies.
 */

/* ---- table / class / field names ---- */
const SAFE_NAME = /^[a-z][a-z0-9_]{0,79}$/;

/** Validate a ServiceNow table or CMDB class name. */
export function validateTableName(name: string): string {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`Invalid table/class name: "${name}". Must match [a-z][a-z0-9_]* (max 80 chars).`);
  }
  return name;
}

/* ---- sys_id (32-char hex GUID) ---- */
const SYS_ID = /^[0-9a-f]{32}$/;

/** Validate a ServiceNow sys_id. */
export function validateSysId(id: string): string {
  if (!SYS_ID.test(id)) {
    throw new Error(`Invalid sys_id: "${id}". Must be a 32-character lowercase hex string.`);
  }
  return id;
}

/* ---- baseUrl ---- */

/** Enforce HTTPS and a service-now.com domain (or localhost for dev). */
export function validateBaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid baseUrl: "${url}". Must be a valid URL.`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const isServiceNow = hostname.endsWith('.service-now.com');
  const isLocalDev = hostname === 'localhost' || hostname === '127.0.0.1';
  if (!isServiceNow && !isLocalDev) {
    throw new Error(`baseUrl hostname must be *.service-now.com or localhost. Got: "${hostname}".`);
  }
  if (!isLocalDev && parsed.protocol !== 'https:') {
    throw new Error(`baseUrl must use HTTPS for non-local hosts. Got: "${parsed.protocol}".`);
  }
  // Strip trailing slash for consistent URL construction
  return url.replace(/\/+$/, '');
}

/* ---- API path (for scripted REST / generic calls) ---- */

/** Validate an API path starts with /api/ and contains no traversal segments. */
export function validateApiPath(path: string): string {
  if (!path.startsWith('/api/')) {
    throw new Error(`API path must start with /api/. Got: "${path}".`);
  }
  if (/\.\.[/\\]/.test(path) || path.includes('//')) {
    throw new Error(`API path contains traversal or double-slash: "${path}".`);
  }
  return path;
}

/* ---- HTTP method allowlist ---- */
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function validateHttpMethod(method: string): string {
  const upper = method.toUpperCase();
  if (!ALLOWED_METHODS.has(upper)) {
    throw new Error(`HTTP method not allowed: "${method}". Must be one of: ${[...ALLOWED_METHODS].join(', ')}.`);
  }
  return upper;
}

/* ---- attachment size limit ---- */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
