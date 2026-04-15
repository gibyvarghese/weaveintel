/**
 * MCP browser auth & handoff tools — credential-based login, cookie management,
 * auth detection, and human-in-the-loop browser handoff.
 *
 * These tools extend the core browser automation with authentication awareness:
 *   • browser_detect_auth  — analyze page for login forms, CAPTCHA, 2FA
 *   • browser_login        — auto-login using stored credentials (form-fill, cookie, header)
 *   • browser_save_cookies — export session cookies for later reuse
 *   • browser_handoff_request — signal that agent is stuck, needs human help
 *   • browser_handoff_resume  — resume after human completes their action
 */
import type { Tool, ToolInput, ToolOutput, ExecutionContext } from '@weaveintel/core';
import { BrowserPool } from './automation.js';
import { detectLoginForm } from './snapshot.js';
import type { BrowserAuthConfig, FormFillAuth, HandoffRequest, SSOPassThroughAuth } from './auth-types.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function ok(data: unknown): ToolOutput { return { content: JSON.stringify(data) }; }
function err(msg: string): ToolOutput  { return { content: JSON.stringify({ error: msg }), isError: true }; }

function str(inp: ToolInput, key: string): string   { return String(inp.arguments[key] ?? ''); }

const pool = () => BrowserPool.instance();

const SESSION_PARAM = { sessionId: { type: 'string' as const, description: 'Session ID returned by browser_open' } };

/* ------------------------------------------------------------------ */
/*  Pending handoff requests (in-memory, keyed by taskId)              */
/* ------------------------------------------------------------------ */

const pendingHandoffs = new Map<string, HandoffRequest>();

export function getPendingHandoff(taskId: string): HandoffRequest | undefined {
  return pendingHandoffs.get(taskId);
}

export function resolvePendingHandoff(taskId: string): boolean {
  return pendingHandoffs.delete(taskId);
}

export function listPendingHandoffs(): HandoffRequest[] {
  return [...pendingHandoffs.values()];
}

/* ------------------------------------------------------------------ */
/*  Auth context — set by the app layer per-request                    */
/* ------------------------------------------------------------------ */

export interface BrowserAuthProvider {
  /** Look up stored credentials for a URL and return decrypted config */
  getCredential(url: string, userId?: string): Promise<BrowserAuthConfig | null>;
  /** Called when a handoff is requested — the app layer emits SSE events etc. */
  onHandoffRequest?(request: HandoffRequest): void;
  /** Look up a linked SSO identity provider session (cookies from IdP domain) */
  getSSOSession?(identityProvider: string, userId?: string): Promise<SSOPassThroughAuth | null>;
  /** Save a captured SSO session for reuse across sites */
  saveSSOSession?(session: SSOPassThroughAuth, userId?: string): Promise<void>;
  /** List all linked SSO identity providers */
  listSSOProviders?(userId?: string): Promise<Array<{ provider: string; email?: string; linkedAt: string }>>;
}

function inferProviderFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
    if (host === 'google.com' || host.endsWith('.google.com')) return 'google';
    if (host.endsWith('.microsoft.com') || host.endsWith('.live.com') || host === 'login.microsoftonline.com') return 'microsoft';
    if (host.endsWith('.apple.com') || host.endsWith('.icloud.com')) return 'apple';
    if (host === 'facebook.com' || host.endsWith('.facebook.com')) return 'facebook';
  } catch {
    // Ignore malformed URLs.
  }
  return null;
}

let _authProvider: BrowserAuthProvider | null = null;

export function setBrowserAuthProvider(provider: BrowserAuthProvider): void {
  _authProvider = provider;
}

/* ------------------------------------------------------------------ */
/*  Tool definitions                                                   */
/* ------------------------------------------------------------------ */

export function createBrowserAuthTools(): Tool[] {
  return [

    /* ==================== Detect Auth ==================== */

    {
      schema: {
        name: 'browser_detect_auth',
        description: 'Analyze the current page to detect if it contains a login form, CAPTCHA, 2FA prompt, or OAuth buttons. Returns detection details including element refs for username/password fields. Use this before attempting to log in.',
        parameters: {
          type: 'object',
          properties: { ...SESSION_PARAM },
          required: ['sessionId'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const session = pool().require(str(inp, 'sessionId'));
          const snapshot = await session.snapshot();
          const detection = detectLoginForm(snapshot);
          return ok(detection);
        } catch (e) { return err((e as Error).message); }
      },
    },

    /* ==================== Login ==================== */

    {
      schema: {
        name: 'browser_login',
        description: 'Attempt to log into the current page using stored credentials. For form_fill auth: auto-detects or uses provided username/password field refs and submits. For cookie/header auth: credentials are injected at the browser context level. Requires credentials to be stored first via the credential vault. Passwords are never returned in the output.',
        parameters: {
          type: 'object',
          properties: {
            ...SESSION_PARAM,
            credentialId: { type: 'string', description: 'Optional: specific credential ID to use. If omitted, auto-matches by current page URL.' },
            usernameRef: { type: 'number', description: 'Optional: ref of username field (from browser_detect_auth). Auto-detected if omitted.' },
            passwordRef: { type: 'number', description: 'Optional: ref of password field (from browser_detect_auth). Auto-detected if omitted.' },
            submitRef: { type: 'number', description: 'Optional: ref of submit button. Auto-detected if omitted.' },
          },
          required: ['sessionId'],
        },
      },
      async invoke(ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          if (!_authProvider) return err('No credential provider configured. Store credentials first via the admin UI.');
          const session = pool().require(str(inp, 'sessionId'));
          const pageUrl = session.page.url();

          const authConfig = await _authProvider.getCredential(pageUrl, ctx.userId);
          if (!authConfig) {
            // If no website credential exists, try SSO pass-through by URL provider.
            const inferredProvider = inferProviderFromUrl(pageUrl);
            if (inferredProvider && _authProvider.getSSOSession) {
              const ssoSession = await _authProvider.getSSOSession(inferredProvider, ctx.userId);
              if (ssoSession && ssoSession.cookies.length > 0) {
                await session.context.addCookies(ssoSession.cookies.map(c => ({
                  name: c.name,
                  value: c.value,
                  domain: c.domain,
                  path: c.path ?? '/',
                  secure: c.secure ?? false,
                  httpOnly: c.httpOnly ?? false,
                  sameSite: (c.sameSite ?? 'Lax') as 'Strict' | 'Lax' | 'None',
                  expires: c.expires ?? -1,
                })));
                await session.page.reload({ waitUntil: 'domcontentloaded' });
                await session.settle();
                const newSnapshot = await session.snapshot();
                return ok({
                  success: true,
                  postLoginUrl: session.page.url(),
                  authMethod: 'sso_passthrough',
                  provider: inferredProvider,
                  snapshot: newSnapshot.text,
                });
              }
            }
            return err(`No stored credentials found for ${pageUrl}. Add credentials in Settings → Website Credentials, or capture an SSO session for pass-through.`);
          }

          if (authConfig.method === 'form_fill') {
            const formAuth = authConfig as FormFillAuth;
            const snapshot = await session.snapshot();
            const detection = detectLoginForm(snapshot);

            // Resolve field refs
            const usernameRef = inp.arguments['usernameRef'] as number | undefined
              ?? detection.usernameRef
              ?? (formAuth.selectors?.username ? undefined : undefined);
            const passwordRef = inp.arguments['passwordRef'] as number | undefined
              ?? detection.passwordRef;
            const submitRef = inp.arguments['submitRef'] as number | undefined
              ?? detection.submitRef;

            if (passwordRef == null) return err('Could not find password field. Use browser_detect_auth and provide passwordRef manually.');

            // Fill username
            if (usernameRef != null) {
              const usernameLocator = session.locator({ ref: usernameRef });
              await usernameLocator.fill(formAuth.username);
            } else if (formAuth.selectors?.username) {
              await session.page.locator(formAuth.selectors.username).fill(formAuth.username);
            }

            // Fill password
            const passwordLocator = session.locator({ ref: passwordRef });
            await passwordLocator.fill(formAuth.password);

            // Submit
            if (submitRef != null) {
              const submitLocator = session.locator({ ref: submitRef });
              await submitLocator.click();
            } else if (formAuth.selectors?.submit) {
              await session.page.locator(formAuth.selectors.submit).click();
            } else {
              // Try pressing Enter on the password field
              await passwordLocator.press('Enter');
            }

            // Wait for navigation
            await session.settle();
            const newSnapshot = await session.snapshot();

            // Check if still on login page
            const postDetection = detectLoginForm(newSnapshot);

            return ok({
              success: !postDetection.detected || postDetection.type !== 'login',
              postLoginUrl: session.page.url(),
              authMethod: 'form_fill',
              snapshot: newSnapshot.text,
              // Never expose credentials in output
            });
          }

          if (authConfig.method === 'cookie' || authConfig.method === 'header') {
            // These are already injected at BrowserContext level via openWithAuth.
            // If the user opened without auth, we can reload with cookie injection.
            if (authConfig.method === 'cookie') {
              const cookieAuth = authConfig as import('./auth-types.js').CookieAuth;
              await session.context.addCookies(cookieAuth.cookies.map(c => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path ?? '/',
                secure: c.secure ?? false,
                httpOnly: c.httpOnly ?? false,
                sameSite: (c.sameSite ?? 'Lax') as 'Strict' | 'Lax' | 'None',
                expires: c.expires ?? -1,
              })));
              await session.page.reload({ waitUntil: 'domcontentloaded' });
              await session.settle();
            }
            const newSnapshot = await session.snapshot();
            return ok({
              success: true,
              postLoginUrl: session.page.url(),
              authMethod: authConfig.method,
              snapshot: newSnapshot.text,
            });
          }

          return err(`Auth method '${authConfig.method}' is not yet supported for browser_login. For SSO/OAuth, use browser_sso_login instead.`);
        } catch (e) { return err((e as Error).message); }
      },
    },

    /* ==================== Save Cookies ==================== */

    {
      schema: {
        name: 'browser_save_cookies',
        description: 'Export all cookies from the current browser session. Useful for saving an authenticated session to reuse later without re-login. Returns the cookies array (which can be stored in the credential vault).',
        parameters: {
          type: 'object',
          properties: { ...SESSION_PARAM },
          required: ['sessionId'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const session = pool().require(str(inp, 'sessionId'));
          const cookies = await session.context.cookies();
          return ok({
            cookieCount: cookies.length,
            domains: [...new Set(cookies.map(c => c.domain))],
            cookies: cookies.map(c => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              secure: c.secure,
              httpOnly: c.httpOnly,
              sameSite: c.sameSite,
              expires: c.expires,
            })),
          });
        } catch (e) { return err((e as Error).message); }
      },
    },

    /* ==================== Handoff Request ==================== */

    {
      schema: {
        name: 'browser_handoff_request',
        description: 'Request human assistance with the browser session. Use this when you encounter something you cannot handle: CAPTCHA, 2FA verification, complex OAuth flows, or any situation requiring human judgment. The browser session will be paused and the user will be notified with a screenshot and your reason. Wait for the handoff to be resolved before continuing.',
        parameters: {
          type: 'object',
          properties: {
            ...SESSION_PARAM,
            reason: { type: 'string', description: 'Why you need human help (e.g. "CAPTCHA detected", "2FA code required", "Cannot identify the correct button")' },
          },
          required: ['sessionId', 'reason'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const session = pool().require(str(inp, 'sessionId'));
          const reason = str(inp, 'reason');

          if (session.handoffState !== 'none') {
            return err(`Session already has a pending handoff (state: ${session.handoffState}).`);
          }

          // Take screenshot for user context
          const screenshot = await session.screenshot();
          const taskId = crypto.randomUUID();

          session.handoffState = 'pending';

          const request: HandoffRequest = {
            taskId,
            sessionId: session.id,
            reason,
            screenshot,
            pageUrl: session.page.url(),
            createdAt: new Date().toISOString(),
          };

          pendingHandoffs.set(taskId, request);

          // Notify app layer
          _authProvider?.onHandoffRequest?.(request);

          return ok({
            taskId,
            status: 'pending',
            message: `Handoff requested. The user has been notified. Reason: ${reason}. Wait for the user to complete the action, then call browser_handoff_resume with this taskId.`,
          });
        } catch (e) { return err((e as Error).message); }
      },
    },

    /* ==================== Handoff Resume ==================== */

    {
      schema: {
        name: 'browser_handoff_resume',
        description: 'Resume control of a browser session after human assistance. Call this after the user has completed their action (e.g. solved CAPTCHA, entered 2FA code). Returns a fresh page snapshot showing the current state.',
        parameters: {
          type: 'object',
          properties: {
            ...SESSION_PARAM,
            taskId: { type: 'string', description: 'The taskId returned by browser_handoff_request' },
          },
          required: ['sessionId', 'taskId'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const session = pool().require(str(inp, 'sessionId'));
          const taskId = str(inp, 'taskId');

          // Clean up handoff state
          pendingHandoffs.delete(taskId);
          session.handoffState = 'none';
          session.touch();

          // Wait for any pending navigations
          await session.settle();
          const snapshot = await session.snapshot();

          return ok({
            status: 'resumed',
            pageUrl: session.page.url(),
            snapshot: snapshot.text,
          });
        } catch (e) { return err((e as Error).message); }
      },
    },

    /* ==================== SSO Login ==================== */

    {
      schema: {
        name: 'browser_sso_login',
        description: 'Attempt SSO/OAuth login on the current page using a linked identity provider session (Google, GitHub, Microsoft, etc.). Injects the IdP session cookies, then clicks the matching SSO button. The OAuth redirect should complete automatically since the user is already "signed in" to the IdP. If no linked session exists for the detected IdP, returns an error suggesting browser_capture_sso.',
        parameters: {
          type: 'object',
          properties: {
            ...SESSION_PARAM,
            provider: { type: 'string', description: 'Identity provider to use: google, github, microsoft, apple, facebook. If omitted, auto-detects from OAuth buttons on the page.' },
            buttonRef: { type: 'number', description: 'Optional: ref of the SSO button to click (from browser_detect_auth). Auto-detected if omitted.' },
          },
          required: ['sessionId'],
        },
      },
      async invoke(ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          if (!_authProvider?.getSSOSession) return err('SSO pass-through not configured. Link an identity provider session first via the admin UI or browser_capture_sso.');
          const session = pool().require(str(inp, 'sessionId'));
          let provider = str(inp, 'provider').toLowerCase();

          // Auto-detect OAuth provider from page if not specified
          if (!provider) {
            const snapshot = await session.snapshot();
            const detection = detectLoginForm(snapshot);
            if (detection.oauthButtons.length === 0) return err('No SSO/OAuth buttons detected on this page. Use browser_login for form-based login instead.');
            // Pick the first recognized provider
            const providerKeywords = ['google', 'github', 'microsoft', 'apple', 'facebook'];
            for (const btn of detection.oauthButtons) {
              const found = providerKeywords.find(k => btn.toLowerCase().includes(k));
              if (found) { provider = found; break; }
            }
            if (!provider) return err(`Found OAuth buttons (${detection.oauthButtons.join(', ')}) but could not identify a supported identity provider.`);
          }

          // Look up the linked SSO session
          const ssoSession = await _authProvider.getSSOSession(provider, ctx.userId);
          if (!ssoSession) {
            return err(`No linked ${provider} session found. Use browser_capture_sso after completing a manual ${provider} login to capture the session for future SSO pass-through.`);
          }

          // Inject IdP cookies into the browser context
          if (ssoSession.cookies.length > 0) {
            await session.context.addCookies(ssoSession.cookies.map(c => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path ?? '/',
              secure: c.secure ?? false,
              httpOnly: c.httpOnly ?? false,
              sameSite: (c.sameSite ?? 'Lax') as 'Strict' | 'Lax' | 'None',
              expires: c.expires ?? -1,
            })));
          }

          // Find and click the SSO button
          const snapshot = await session.snapshot();
          const detection = detectLoginForm(snapshot);
          let targetRef = inp.arguments['buttonRef'] as number | undefined;

          if (targetRef == null) {
            // Find the button matching this provider
            const allEls = snapshot.elements ?? [];
            const target = allEls.find((e: { role?: string; name?: string; ref?: number }) =>
              (e.role === 'button' || e.role === 'link') &&
              e.name?.toLowerCase().includes(provider) &&
              (e.name?.toLowerCase().includes('sign') || e.name?.toLowerCase().includes('log') || e.name?.toLowerCase().includes('continue')),
            );
            if (target) targetRef = target.ref;
          }

          if (targetRef == null) return err(`Could not find a "${provider}" SSO button on the page. Available buttons: ${detection.oauthButtons.join(', ')}`);

          // Click the SSO button
          const btnLocator = session.locator({ ref: targetRef });
          await btnLocator.click();

          // Wait for OAuth redirect chain to complete
          await session.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
          await session.settle();

          const newSnapshot = await session.snapshot();
          const postDetection = detectLoginForm(newSnapshot);
          const success = !postDetection.detected || postDetection.type !== 'login';

          return ok({
            success,
            provider,
            postLoginUrl: session.page.url(),
            authMethod: 'sso_passthrough',
            email: ssoSession.email,
            snapshot: newSnapshot.text,
            ...(success ? {} : { hint: 'SSO redirect may have required re-authentication. Try browser_capture_sso to refresh the IdP session, or use browser_handoff_request for human assistance.' }),
          });
        } catch (e) { return err((e as Error).message); }
      },
    },

    /* ==================== Capture SSO Session ==================== */

    {
      schema: {
        name: 'browser_capture_sso',
        description: 'Capture the current browser\'s identity provider session cookies for SSO pass-through reuse. Call this AFTER a successful login to an identity provider (Google, GitHub, Microsoft, etc.) — either via manual login or HITL handoff. The captured cookies will be stored in the vault so future SSO/OAuth logins to any site using this provider complete automatically.',
        parameters: {
          type: 'object',
          properties: {
            ...SESSION_PARAM,
            provider: { type: 'string', description: 'Identity provider being captured: google, github, microsoft, apple, facebook' },
            email: { type: 'string', description: 'Optional: the email/account used for this provider' },
          },
          required: ['sessionId', 'provider'],
        },
      },
      async invoke(ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          if (!_authProvider?.saveSSOSession) return err('SSO session storage not configured.');
          const session = pool().require(str(inp, 'sessionId'));
          const provider = str(inp, 'provider').toLowerCase();
          const email = str(inp, 'email') || undefined;
          if (!ctx.userId) return err('No authenticated user context available to save SSO session.');

          // Map provider to known IdP domains
          const idpDomains: Record<string, string[]> = {
            google: ['accounts.google.com', 'myaccount.google.com', 'google.com', '.google.com'],
            github: ['github.com', '.github.com'],
            microsoft: ['login.microsoftonline.com', 'login.live.com', '.microsoft.com', '.live.com'],
            apple: ['appleid.apple.com', '.apple.com', '.icloud.com'],
            facebook: ['.facebook.com', 'facebook.com'],
          };

          const domains = idpDomains[provider];
          if (!domains) return err(`Unknown identity provider: ${provider}. Supported: google, github, microsoft, apple, facebook`);

          // Get all cookies from the browser context
          const allCookies = await session.context.cookies();

          // Filter to only IdP-relevant cookies
          const idpCookies = allCookies.filter(c =>
            domains.some(d => d.startsWith('.') ? c.domain.endsWith(d) || c.domain === d.slice(1) : c.domain === d || c.domain === '.' + d),
          );

          if (idpCookies.length === 0) {
            return err(`No ${provider} session cookies found in the browser. Make sure you have logged into ${provider} in this browser session first.`);
          }

          const ssoAuth: SSOPassThroughAuth = {
            method: 'sso_passthrough',
            identityProvider: provider,
            email,
            cookies: idpCookies.map(c => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              secure: c.secure,
              httpOnly: c.httpOnly,
              sameSite: c.sameSite as 'Strict' | 'Lax' | 'None',
              expires: c.expires,
            })),
          };

          await _authProvider.saveSSOSession(ssoAuth, ctx.userId);

          return ok({
            success: true,
            provider,
            email,
            cookiesCaptured: idpCookies.length,
            domains: [...new Set(idpCookies.map(c => c.domain))],
            message: `${provider} session captured with ${idpCookies.length} cookies. Future SSO logins using "${provider}" will be automatic.`,
          });
        } catch (e) { return err((e as Error).message); }
      },
    },

  ];
}
