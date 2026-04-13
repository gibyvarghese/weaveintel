/**
 * Universal authentication profile types
 *
 * Supports OAuth 2.0 (Authorization Code, Client Credentials, OIDC),
 * Basic Auth, API Key, Bearer Token, and Service Account.
 */

export type AuthMethod =
  | 'oauth2_authorization_code'
  | 'oauth2_client_credentials'
  | 'oidc'
  | 'basic'
  | 'api_key'
  | 'bearer'
  | 'service_account';

/** Stored token state persisted between requests */
export interface TokenState {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: number; // epoch ms
  idToken?: string;   // OIDC
  scope?: string;
}

/** Configuration for an authentication profile */
export interface AuthProfile {
  /** Unique identifier for this profile */
  id: string;
  /** Human-readable label */
  label: string;
  /** Which authentication method to use */
  method: AuthMethod;
  /**
   * Base domain or first part of the URL supplied by the user.
   * Example: "mycompany" → resolved to "mycompany.atlassian.net"
   * The connector decides how to turn this into a full URL.
   */
  domain: string;

  // --- OAuth 2.0 / OIDC fields ---
  clientId?: string;
  clientSecret?: string;
  /** Authorization endpoint. Supports {{domain}} placeholder. */
  authorizationUrl?: string;
  /** Token endpoint. Supports {{domain}} placeholder. */
  tokenUrl?: string;
  /** OIDC userinfo endpoint. Supports {{domain}} placeholder. */
  userinfoUrl?: string;
  /** Scopes (space-separated or array) */
  scopes?: string[];
  /** Redirect URI for authorization-code flow */
  redirectUri?: string;

  // --- Basic auth ---
  username?: string;
  password?: string;

  // --- API key / Bearer ---
  apiKey?: string;
  /** Where to place the API key: 'header' | 'query'. Default header. */
  apiKeyPlacement?: 'header' | 'query';
  /** Header name for API key. Default X-API-Key. */
  apiKeyHeaderName?: string;

  // --- Service account ---
  serviceAccountJson?: string;

  // --- Extra ---
  /** Additional static headers to attach to every request */
  extraHeaders?: Record<string, string>;

  // --- Token state (managed by the auth manager) ---
  tokenState?: TokenState;
}

/** Result of a token exchange or refresh */
export interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

/** Events emitted by the auth manager */
export interface AuthEvents {
  onTokenRefreshed?: (profileId: string, tokenState: TokenState) => void;
  onTokenError?: (profileId: string, error: Error) => void;
}
