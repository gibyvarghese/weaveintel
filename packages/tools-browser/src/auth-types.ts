/**
 * @weaveintel/tools-browser — Browser authentication types
 *
 * Defines the auth strategies an agent can use to log into websites:
 *   • form_fill  — fill username/password fields and submit
 *   • cookie     — inject saved cookies into the browser context
 *   • header     — set Authorization header on all requests
 *   • oauth      — automated OAuth browser flow
 */

/* ------------------------------------------------------------------ */
/*  Auth config variants                                               */
/* ------------------------------------------------------------------ */

export interface FormFillAuth {
  method: 'form_fill';
  username: string;
  password: string;
  /** CSS selectors to override auto-detection */
  selectors?: {
    username?: string;
    password?: string;
    submit?: string;
  };
}

export interface CookieAuth {
  method: 'cookie';
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    expires?: number;
  }>;
}

export interface HeaderAuth {
  method: 'header';
  /** e.g. 'Bearer xxx' or 'Basic base64...' */
  authorization: string;
}

export interface OAuthFlowAuth {
  method: 'oauth';
  provider: string;
  username: string;
  password: string;
}

/**
 * SSO pass-through auth — reuses a captured identity provider session
 * (Google, GitHub, Microsoft, etc.) to auto-complete OAuth/SSO flows.
 * The cookies from the IdP domain are injected before clicking the
 * "Sign in with …" button, so the OAuth redirect completes automatically.
 */
export interface SSOPassThroughAuth {
  method: 'sso_passthrough';
  /** Identity provider name: 'google' | 'github' | 'microsoft' | 'apple' | 'facebook' */
  identityProvider: string;
  /** Cookies captured from the IdP domain (e.g. accounts.google.com) */
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    expires?: number;
  }>;
  /** The email/account used with this provider */
  email?: string;
}

export type BrowserAuthConfig = FormFillAuth | CookieAuth | HeaderAuth | OAuthFlowAuth | SSOPassThroughAuth;

/* ------------------------------------------------------------------ */
/*  Credential record (decrypted)                                      */
/* ------------------------------------------------------------------ */

export interface WebsiteCredential {
  id: string;
  userId: string;
  siteName: string;
  siteUrlPattern: string;
  authMethod: BrowserAuthConfig['method'];
  /** The decrypted auth config */
  config: BrowserAuthConfig;
  lastUsedAt?: string;
  status: 'active' | 'expired' | 'needs_reauth';
}

/* ------------------------------------------------------------------ */
/*  Handoff state                                                      */
/* ------------------------------------------------------------------ */

export type HandoffState = 'none' | 'pending' | 'active';

export interface HandoffRequest {
  taskId: string;
  sessionId: string;
  reason: string;
  screenshot?: string;
  pageUrl: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/*  Login detection result                                             */
/* ------------------------------------------------------------------ */

export interface LoginFormDetection {
  detected: boolean;
  type: 'login' | 'captcha' | '2fa' | 'oauth_prompt' | 'unknown';
  usernameRef?: number;
  passwordRef?: number;
  submitRef?: number;
  captchaPresent: boolean;
  twoFactorPresent: boolean;
  oauthButtons: string[];
}
