/**
 * OAuth / social sign-in catalog + parsers — pure, framework-agnostic logic.
 *
 * The server is the source of truth for *which* providers are configured; this
 * module narrows the server's open string list to the ids the app knows how to
 * render, in a canonical order, and parses the native callback URL the server
 * 302s back to the app scheme.
 *
 * No React / React Native / Expo imports — testable in plain Node.
 */

/** Every OAuth provider the app can render, in canonical display order. */
export const OAUTH_PROVIDER_IDS = ['google', 'github', 'microsoft', 'apple', 'facebook'] as const;

export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

const PROVIDER_LABELS: Record<OAuthProviderId, string> = {
  google: 'Continue with Google',
  github: 'Continue with GitHub',
  microsoft: 'Continue with Microsoft',
  apple: 'Continue with Apple',
  facebook: 'Continue with Facebook',
};

/** Human label shown on a provider's sign-in button. */
export function oauthProviderLabel(id: OAuthProviderId): string {
  return PROVIDER_LABELS[id];
}

/** Narrowing guard for the canonical provider ids. */
export function isOAuthProviderId(value: unknown): value is OAuthProviderId {
  return typeof value === 'string' && (OAUTH_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Normalize the server's provider list: keep only known ids, dedupe, and return
 * them in canonical order regardless of the order the server sent them.
 */
export function parseAuthProviders(raw: unknown): OAuthProviderId[] {
  const list = Array.isArray(raw) ? raw : [];
  const present = new Set<OAuthProviderId>();
  for (const item of list) {
    if (isOAuthProviderId(item)) present.add(item);
  }
  return OAUTH_PROVIDER_IDS.filter((id) => present.has(id));
}

/** A successfully parsed native OAuth callback (bearer session handed to the app). */
export interface NativeOAuthResult {
  token: string;
  csrfToken: string;
  expiresAt?: string;
}

/** A failed native OAuth callback (provider error or missing session). */
export interface NativeOAuthError {
  error: string;
}

/**
 * Parse the redirect URL the server sends back to the app scheme after a native
 * OAuth flow, e.g. `geneweave://oauth?token=...&csrfToken=...&expiresAt=...` or
 * the Expo Go equivalent `exp://host/--/oauth?...`.
 */
export function parseNativeOAuthCallback(url: string): NativeOAuthResult | NativeOAuthError {
  const queryStart = url.indexOf('?');
  const query = queryStart >= 0 ? url.slice(queryStart + 1) : '';
  const params = new URLSearchParams(query);

  const error = params.get('error');
  if (error) return { error };

  const token = params.get('token');
  const csrfToken = params.get('csrfToken');
  if (!token || !csrfToken) return { error: 'Missing session in OAuth callback' };

  const expiresAt = params.get('expiresAt');
  return { token, csrfToken, ...(expiresAt ? { expiresAt } : {}) };
}

/** Type guard distinguishing a parsed native OAuth result from an error. */
export function isNativeOAuthError(
  value: NativeOAuthResult | NativeOAuthError,
): value is NativeOAuthError {
  return 'error' in value;
}
