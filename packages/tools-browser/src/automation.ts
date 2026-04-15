/**
 * Browser session pool — manages browser instances for agent automation.
 *
 * Sessions are identified by UUID and expire after a configurable idle timeout.
 * A single global pool is shared across all tool invocations.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { existsSync } from 'node:fs';
import { captureSnapshot, type PageSnapshot } from './snapshot.js';
import type { BrowserAuthConfig, HandoffState, CookieAuth, HeaderAuth } from './auth-types.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface BrowserPoolOptions {
  maxSessions?: number;
  /** Idle timeout in ms (default: 5 min) */
  sessionTimeoutMs?: number;
  headless?: boolean;
  executablePath?: string;
  viewport?: { width: number; height: number };
}

export interface SessionInfo {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
}

interface ResolvedBrowserPoolOptions {
  maxSessions: number;
  sessionTimeoutMs: number;
  headless: boolean;
  executablePath?: string;
  viewport: { width: number; height: number };
}

/* ------------------------------------------------------------------ */
/*  BrowserSession                                                     */
/* ------------------------------------------------------------------ */

export class BrowserSession {
  readonly id: string;
  readonly browser: Browser;
  readonly context: BrowserContext;
  page: Page;
  readonly createdAt: number;
  lastActivityAt: number;
  handoffState: HandoffState = 'none';

  constructor(id: string, browser: Browser, context: BrowserContext, page: Page) {
    this.id = id;
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
  }

  touch(): void { this.lastActivityAt = Date.now(); }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }

  /** Wait for the page to settle after an action */
  async settle(): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  }

  /** Take snapshot of current page */
  async snapshot(): Promise<PageSnapshot> {
    this.touch();
    return captureSnapshot(this.page);
  }

  /** Take screenshot as base64 PNG */
  async screenshot(): Promise<string> {
    this.touch();
    const buf = await this.page.screenshot({ type: 'png', fullPage: false });
    return buf.toString('base64');
  }

  /** Resolve an element locator from ref, selector, or text */
  locator(target: { ref?: number; selector?: string; text?: string }) {
    if (target.ref != null) return this.page.locator(`[data-pw-ref="${target.ref}"]`);
    if (target.selector) return this.page.locator(target.selector);
    if (target.text) return this.page.getByText(target.text, { exact: false });
    throw new Error('Provide one of: ref (number), selector (CSS), or text');
  }
}

/* ------------------------------------------------------------------ */
/*  BrowserPool (singleton)                                            */
/* ------------------------------------------------------------------ */

let _pool: BrowserPool | null = null;

function readHeadlessDefault(): boolean {
  const raw = (process.env['PLAYWRIGHT_HEADLESS'] ?? '').trim().toLowerCase();
  if (!raw) return true;
  return !(raw === 'false' || raw === '0' || raw === 'no' || raw === 'off');
}

function readBrowserExecutablePath(): string | undefined {
  const configuredPath = (process.env['PLAYWRIGHT_BROWSER_PATH'] ?? '').trim();
  if (configuredPath) return configuredPath;

  const preferredBrowser = (process.env['PLAYWRIGHT_BROWSER'] ?? '').trim().toLowerCase();
  if (preferredBrowser !== 'chrome') return undefined;

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    `${process.env['HOME'] ?? ''}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

export class BrowserPool {
  private sessions = new Map<string, BrowserSession>();
  private opts: ResolvedBrowserPoolOptions;
  private timer: ReturnType<typeof setInterval> | null;

  constructor(options: BrowserPoolOptions = {}) {
    this.opts = {
      maxSessions: options.maxSessions ?? 3,
      sessionTimeoutMs: options.sessionTimeoutMs ?? 5 * 60 * 1000,
      headless: options.headless ?? readHeadlessDefault(),
      executablePath: options.executablePath ?? readBrowserExecutablePath(),
      viewport: options.viewport ?? { width: 1280, height: 720 },
    };
    this.timer = setInterval(() => void this.cleanup(), 30_000);
  }

  static instance(options?: BrowserPoolOptions): BrowserPool {
    if (!_pool) _pool = new BrowserPool(options);
    return _pool;
  }

  /** Launch a new browser, navigate to URL, return session + initial snapshot */
  async open(url: string): Promise<{ session: BrowserSession; snapshot: PageSnapshot }> {
    return this._open(url);
  }

  /** Launch a browser with authentication pre-configured (cookies or headers injected before navigation) */
  async openWithAuth(url: string, auth: BrowserAuthConfig): Promise<{ session: BrowserSession; snapshot: PageSnapshot }> {
    return this._open(url, auth);
  }

  private async _open(url: string, auth?: BrowserAuthConfig): Promise<{ session: BrowserSession; snapshot: PageSnapshot }> {
    // evict oldest if at capacity
    if (this.sessions.size >= this.opts.maxSessions) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
      if (oldest) await this.close(oldest.id);
    }

    const id = crypto.randomUUID();
    const browser = await chromium.launch({
      headless: this.opts.headless,
      ...(this.opts.executablePath ? { executablePath: this.opts.executablePath } : {}),
    });
    const context = await browser.newContext({
      viewport: this.opts.viewport,
      userAgent: 'WeaveIntel-Browser/1.0',
      ...(auth?.method === 'header' ? {
        extraHTTPHeaders: { 'Authorization': (auth as HeaderAuth).authorization },
      } : {}),
    });

    // Inject cookies before navigation if cookie auth
    if (auth?.method === 'cookie') {
      const cookieAuth = auth as CookieAuth;
      await context.addCookies(cookieAuth.cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path ?? '/',
        secure: c.secure ?? false,
        httpOnly: c.httpOnly ?? false,
        sameSite: c.sameSite ?? 'Lax',
        expires: c.expires ?? -1,
      })));
    }

    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(30_000);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    const session = new BrowserSession(id, browser, context, page);
    this.sessions.set(id, session);

    const snapshot = await session.snapshot();
    return { session, snapshot };
  }

  get(id: string): BrowserSession | undefined {
    const s = this.sessions.get(id);
    if (s) s.touch();
    return s;
  }

  require(id: string): BrowserSession {
    const s = this.get(id);
    if (!s) throw new Error(`Browser session "${id}" not found. Open a new one with browser.open.`);
    return s;
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) {
      await s.close();
      this.sessions.delete(id);
    }
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map(s => ({
      id: s.id,
      url: s.page.url(),
      title: '',
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
    }));
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      // Don't expire sessions during handoff — the human may be working
      if (s.handoffState !== 'none') continue;
      if (now - s.lastActivityAt > this.opts.sessionTimeoutMs) {
        await this.close(id);
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const id of [...this.sessions.keys()]) await this.close(id);
    _pool = null;
  }
}
