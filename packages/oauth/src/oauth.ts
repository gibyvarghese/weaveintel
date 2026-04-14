/**
 * @weaveintel/oauth — OAuth 2.0 provider integration
 *
 * Generic OAuth 2.0 authorization code flow with support for:
 *   • Google, GitHub, Microsoft, Apple, Facebook
 * 
 * Handles token exchange, PKCE, and user claims extraction.
 * App-level integration handles session creation and account linking.
 */

/* ================================================================== */
/*  OAuth Provider Types                                              */
/* ================================================================== */

export type OAuthProviderName = 'google' | 'github' | 'microsoft' | 'apple' | 'facebook';

export interface OAuthProvider {
  name: OAuthProviderName;
  clientId: string;
  clientSecret: string;
  redirectUri: string;  // https://yourapp.com/api/auth/oauth/callback?provider=google
  scopes: string[];
  endpoints: {
    authorization: string;   // OAuth authorization endpoint
    token: string;           // Token exchange endpoint
    userinfo: string;        // User profile endpoint
  };
}

export interface OAuthAuthorizationRequest {
  provider: OAuthProviderName;
  state: string;         // CSRF protection, random 32-char string
  codeChallenge: string; // PKCE SHA256(codeVerifier) base64url
  scope: string;         // space-separated scopes
  redirectUri: string;
}

export interface OAuthCallbackData {
  provider: OAuthProviderName;
  code: string;          // Authorization code from provider
  state: string;         // Must verify matches
  codeVerifier: string;  // PKCE original verifier
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;       // Bearer
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;        // JWT (OpenID) for Google/Microsoft/Apple
}

export interface OAuthUserProfile {
  id: string;              // Provider-specific user ID
  email: string;
  name: string;
  picture?: string;
  provider: OAuthProviderName;
  raw?: Record<string, unknown>;  // Full response for debugging
}

export interface OAuthLinkedAccount {
  providerId: string;      // provider:id (e.g., "google:123456789")
  provider: OAuthProviderName;
  providerUserId: string;
  email: string;
  name: string;
  picture?: string;
  linkedAt: Date;
  lastUsedAt?: Date;
}

/* ================================================================== */
/*  OAuth State Management (in-memory for CSRF/PKCE)                 */
/* ================================================================== */

export interface OAuthStateStore {
  set(key: string, data: { codeVerifier: string; expiresAt: number }): void;
  get(key: string): { codeVerifier: string; expiresAt: number } | null;
  delete(key: string): void;
}

export class InMemoryOAuthStateStore implements OAuthStateStore {
  private store = new Map<string, { codeVerifier: string; expiresAt: number }>();

  set(key: string, data: { codeVerifier: string; expiresAt: number }): void {
    this.store.set(key, data);
    // Auto-cleanup expired entries
    setTimeout(() => this.store.delete(key), (data.expiresAt - Date.now()) + 1000);
  }

  get(key: string): { codeVerifier: string; expiresAt: number } | null {
    const data = this.store.get(key);
    if (!data) return null;
    if (Date.now() > data.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return data;
  }

  delete(key: string): void {
    this.store.delete(key);
  }
}

/* ================================================================== */
/*  PKCE Support (RFC 7636)                                           */
/* ================================================================== */

export function generateCodeVerifier(): string {
  // 43-128 characters, unreserved characters
  const bytes = new Uint8Array(32);
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else if (typeof global !== 'undefined' && global.crypto?.getRandomValues) {
    global.crypto.getRandomValues(bytes);
  } else {
    // Fallback for Node.js
    const crypto = require('crypto');
    crypto.randomFillSync(bytes);
  }
  return Array.from(bytes)
    .map(b => String.fromCharCode(b))
    .join('')
    .split('')
    .map(c => {
      const code = c.charCodeAt(0);
      return code.toString(16).padStart(2, '0');
    })
    .join('')
    .slice(0, 128);
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  // SHA256(verifier) base64url-encoded
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Buffer.from(hash).toString('base64url');
  } else if (typeof global !== 'undefined' && global.crypto?.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await global.crypto.subtle.digest('SHA-256', data);
    return Buffer.from(hash).toString('base64url');
  } else {
    // Node.js
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(verifier).digest();
    return Buffer.from(hash).toString('base64url');
  }
}

/* ================================================================== */
/*  OAuth Provider Configurations                                     */
/* ================================================================== */

export function createOAuthProvider(
  name: OAuthProviderName,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): OAuthProvider {
  const baseConfigs: Record<OAuthProviderName, Omit<OAuthProvider, 'clientId' | 'clientSecret' | 'redirectUri'>> = {
    google: {
      name: 'google',
      scopes: ['openid', 'email', 'profile'],
      endpoints: {
        authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token',
        userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
      },
    },
    github: {
      name: 'github',
      scopes: ['user:email', 'read:user'],
      endpoints: {
        authorization: 'https://github.com/login/oauth/authorize',
        token: 'https://github.com/login/oauth/access_token',
        userinfo: 'https://api.github.com/user',
      },
    },
    microsoft: {
      name: 'microsoft',
      scopes: ['openid', 'email', 'profile'],
      endpoints: {
        authorization: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        userinfo: 'https://graph.microsoft.com/v1.0/me',
      },
    },
    apple: {
      name: 'apple',
      scopes: ['openid', 'email', 'name'],
      endpoints: {
        authorization: 'https://appleid.apple.com/auth/authorize',
        token: 'https://appleid.apple.com/auth/token',
        userinfo: 'https://appleid.apple.com/auth/token',  // returned in id_token
      },
    },
    facebook: {
      name: 'facebook',
      scopes: ['email', 'public_profile'],
      endpoints: {
        authorization: 'https://www.facebook.com/v18.0/dialog/oauth',
        token: 'https://graph.instagram.com/v18.0/oauth/access_token',
        userinfo: 'https://graph.instagram.com/me?fields=id,name,email,picture',
      },
    },
  };

  const config = baseConfigs[name];
  return {
    ...config,
    clientId,
    clientSecret,
    redirectUri,
  };
}

/* ================================================================== */
/*  OAuth Client (authorization code flow)                           */
/* ================================================================== */

export class OAuthClient {
  private stateStore: OAuthStateStore;

  constructor(stateStore?: OAuthStateStore) {
    this.stateStore = stateStore ?? new InMemoryOAuthStateStore();
  }

  /**
   * Generate the authorization URL to redirect the user to.
   * Returns the URL and stores PKCE code verifier for later validation.
   */
  async generateAuthorizationUrl(provider: OAuthProvider, state: string): Promise<{ authUrl: string; codeVerifier: string }> {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Store for later validation
    this.stateStore.set(state, {
      codeVerifier,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    });

    const params = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: provider.redirectUri,
      response_type: 'code',
      scope: provider.scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256', // PKCE
    });

    // Provider-specific parameters
    if (provider.name === 'apple') {
      params.set('response_mode', 'form_post');
    }

    const authUrl = `${provider.endpoints.authorization}?${params.toString()}`;
    return { authUrl, codeVerifier };
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(
    provider: OAuthProvider,
    code: string,
    state: string,
  ): Promise<{ token: OAuthTokenResponse; codeVerifier: string }> {
    const stored = this.stateStore.get(state);
    if (!stored) throw new Error('Invalid or expired OAuth state');

    const { codeVerifier } = stored;
    this.stateStore.delete(state); // One-time use

    const params = new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: provider.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });

    const response = await fetch(provider.endpoints.token, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OAuth token exchange failed: ${response.status} ${error}`);
    }

    const token: OAuthTokenResponse = await response.json();
    return { token, codeVerifier };
  }

  /**
   * Fetch user profile from OAuth provider
   */
  async getUserProfile(provider: OAuthProvider, accessToken: string): Promise<OAuthUserProfile> {
    const response = await fetch(provider.endpoints.userinfo, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch user profile: ${response.status}`);
    }

    const data = await response.json();
    return this.extractUserProfile(provider.name, data);
  }

  /**
   * Extract standardized user profile from provider-specific response
   */
  private extractUserProfile(provider: OAuthProviderName, data: Record<string, unknown>): OAuthUserProfile {
    switch (provider) {
      case 'google':
        return {
          id: String(data['sub']),
          email: String(data['email']),
          name: String(data['name'] ?? ''),
          picture: String(data['picture'] ?? ''),
          provider,
          raw: data,
        };
      case 'github':
        return {
          id: String(data['id']),
          email: String(data['email'] ?? ''),
          name: String(data['name'] ?? data['login'] ?? ''),
          picture: String(data['avatar_url'] ?? ''),
          provider,
          raw: data,
        };
      case 'microsoft':
        return {
          id: String(data['id']),
          email: String(data['userPrincipalName'] ?? data['mail'] ?? ''),
          name: String(data['displayName'] ?? ''),
          picture: '',
          provider,
          raw: data,
        };
      case 'apple':
        return {
          id: String(data['sub']),
          email: String(data['email'] ?? ''),
          name: String(data['name']?.['firstName'] ? `${data['name']['firstName']} ${data['name']['lastName']}` : ''),
          picture: '',
          provider,
          raw: data,
        };
      case 'facebook':
        return {
          id: String(data['id']),
          email: String(data['email'] ?? ''),
          name: String(data['name'] ?? ''),
          picture: String(data['picture']?.['data']?.['url'] ?? ''),
          provider,
          raw: data,
        };
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }
}

/* ================================================================== */
/*  Exports                                                            */
/* ================================================================== */

export { OAuthProvider, OAuthAuthorizationRequest, OAuthCallbackData, OAuthTokenResponse, OAuthUserProfile, OAuthLinkedAccount, OAuthProviderName };
