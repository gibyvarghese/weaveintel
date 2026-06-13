/**
 * oauth-native.ts — pure helpers for the native (mobile) OAuth sign-in path.
 *
 * The browser-based OAuth flow (popup + postMessage) cannot hand a bearer token
 * back to a native app, so the mobile client drives the same provider flow but
 * asks the server to redirect the final hop to its own app scheme
 * (`geneweave://oauth` in a standalone build, `exp://…/--/oauth` under Expo Go).
 *
 * To avoid a schema migration the chosen redirect URI is encoded *into* the
 * OAuth `state` value (which the provider echoes back verbatim), alongside the
 * usual random nonce. Every helper here is pure and unit-tested; the route layer
 * only wires them. The redirect target is always validated against a small
 * app-scheme allowlist before we ever issue a 302, so this can never become an
 * open redirect.
 */

const NATIVE_STATE_PREFIX = 'native:';

/** App schemes we are willing to 302 a freshly minted session back to. */
const ALLOWED_NATIVE_SCHEMES = new Set(['geneweave', 'exp']);

function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

/** Extract the URI scheme (without the trailing colon), lowercased, or null. */
function schemeOf(uri: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(uri);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Whether a redirect URI targets one of our app schemes. This is the open-redirect
 * guard: a `https://evil.example` redirect URI is rejected before any 302.
 */
export function isAllowedNativeRedirect(redirectUri: string): boolean {
  const scheme = schemeOf(redirectUri);
  return scheme !== null && ALLOWED_NATIVE_SCHEMES.has(scheme);
}

/**
 * Build the opaque OAuth `state` for a native flow: a stable prefix, the
 * base64url-encoded redirect URI, and a random nonce. The provider echoes this
 * back on the callback, where {@link parseNativeOAuthState} recovers the redirect.
 */
export function encodeNativeOAuthState(redirectUri: string, nonce: string): string {
  return `${NATIVE_STATE_PREFIX}${toBase64Url(redirectUri)}:${nonce}`;
}

/** Decode an OAuth `state`: identify a native flow and recover its redirect URI. */
export function parseNativeOAuthState(state: string): { native: boolean; redirectUri?: string } {
  if (!state.startsWith(NATIVE_STATE_PREFIX)) return { native: false };
  const rest = state.slice(NATIVE_STATE_PREFIX.length);
  const sep = rest.indexOf(':');
  const encoded = sep >= 0 ? rest.slice(0, sep) : rest;
  try {
    const redirectUri = fromBase64Url(encoded);
    if (!redirectUri) return { native: true };
    return { native: true, redirectUri };
  } catch {
    return { native: true };
  }
}

/** The session bundle handed back to the native app via the redirect query. */
export interface NativeOAuthSession {
  token: string;
  csrfToken: string;
  expiresAt: string;
}

/**
 * Append the freshly minted session to the app's redirect URI as query params.
 * The app receives this URL directly from the in-app auth session (no proxy),
 * parses it, and persists the bearer token.
 */
export function buildNativeOAuthRedirect(redirectUri: string, session: NativeOAuthSession): string {
  const params = new URLSearchParams({
    token: session.token,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  });
  const sep = redirectUri.includes('?') ? '&' : '?';
  return `${redirectUri}${sep}${params.toString()}`;
}

/** Build a native error redirect so the app can surface a readable message. */
export function buildNativeOAuthError(redirectUri: string, error: string): string {
  const params = new URLSearchParams({ error });
  const sep = redirectUri.includes('?') ? '&' : '?';
  return `${redirectUri}${sep}${params.toString()}`;
}
