/**
 * MCP automation tools — Playwright-powered browser interaction for agents.
 *
 * Every action tool returns an updated page snapshot so the agent always knows
 * the current state after performing an operation.
 *
 * Element targeting uses a flexible scheme:
 *   • ref  — numeric ID from the most recent snapshot  (e.g. 5)
 *   • selector — CSS selector                          (e.g. '#submit-btn')
 *   • text — visible text match                        (e.g. 'Submit')
 */
import type { Tool, ToolInput, ToolOutput, ExecutionContext } from '@weaveintel/core';
import { BrowserPool } from './automation.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function ok(data: unknown): ToolOutput { return { content: JSON.stringify(data) }; }
function err(msg: string): ToolOutput  { return { content: JSON.stringify({ error: msg }), isError: true }; }

function str(inp: ToolInput, key: string): string   { return String(inp.arguments[key] ?? ''); }
function num(inp: ToolInput, key: string): number | undefined {
  const v = inp.arguments[key];
  return v != null ? Number(v) : undefined;
}

const pool = () => BrowserPool.instance();

/* ------------------------------------------------------------------ */
/*  Shared parameter schemas                                           */
/* ------------------------------------------------------------------ */

const SESSION_PARAM = { sessionId: { type: 'string' as const, description: 'Session ID returned by browser.open' } };

const TARGET_PARAMS = {
  ...SESSION_PARAM,
  ref:      { type: 'number' as const,  description: 'Ref number from the page snapshot (preferred)' },
  selector: { type: 'string' as const,  description: 'CSS selector (alternative to ref)' },
  text:     { type: 'string' as const,  description: 'Visible text to match (alternative to ref)' },
};

function target(inp: ToolInput) {
  return {
    ref: num(inp, 'ref'),
    selector: str(inp, 'selector') || undefined,
    text: str(inp, 'text') || undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  Tool definitions                                                   */
/* ------------------------------------------------------------------ */

export function createAutomationTools(): Tool[] {
  return [

    /* ==================== Session ==================== */

    {
      schema: {
        name: 'browser.open',
        description: 'Launch a headless browser and navigate to a URL. Returns a session ID and a text snapshot of the page showing all interactive elements with ref numbers. Use the ref numbers in subsequent actions. Always start here before interacting with any website.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full URL to open (e.g. https://example.com)' },
          },
          required: ['url'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const { session, snapshot } = await pool().open(str(inp, 'url'));
          return ok({ sessionId: session.id, snapshot: snapshot.text });
        } catch (e) { return err(`Failed to open browser: ${(e as Error).message}`); }
      },
    },

    {
      schema: {
        name: 'browser.close',
        description: 'Close a browser session and free resources. Always close sessions when done.',
        parameters: {
          type: 'object',
          properties: SESSION_PARAM,
          required: ['sessionId'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        await pool().close(str(inp, 'sessionId'));
        return ok({ closed: true });
      },
    },

    /* ==================== Navigation ==================== */

    {
      schema: {
        name: 'browser.navigate',
        description: 'Navigate to a new URL within an existing browser session. Returns updated page snapshot.',
        parameters: {
          type: 'object',
          properties: {
            ...SESSION_PARAM,
            url: { type: 'string', description: 'URL to navigate to' },
          },
          required: ['sessionId', 'url'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const s = pool().require(str(inp, 'sessionId'));
          await s.page.goto(str(inp, 'url'), { waitUntil: 'domcontentloaded' });
          await s.settle();
          const snap = await s.snapshot();
          return ok({ url: s.page.url(), snapshot: snap.text });
        } catch (e) { return err((e as Error).message); }
      },
    },

    {
      schema: {
        name: 'browser.back',
        description: 'Go back in browser history. Returns updated page snapshot.',
        parameters: {
          type: 'object',
          properties: SESSION_PARAM,
          required: ['sessionId'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const s = pool().require(str(inp, 'sessionId'));
          await s.page.goBack({ waitUntil: 'domcontentloaded' });
          await s.settle();
          const snap = await s.snapshot();
          return ok({ url: s.page.url(), snapshot: snap.text });
        } catch (e) { return err((e as Error).message); }
      },
    },

    {
      schema: {
        name: 'browser.forward',
        description: 'Go forward in browser history. Returns updated page snapshot.',
        parameters: {
          type: 'object',
          properties: SESSION_PARAM,
          required: ['sessionId'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const s = pool().require(str(inp, 'sessionId'));
          await s.page.goForward({ waitUntil: 'domcontentloaded' });
          await s.settle();
          const snap = await s.snapshot();
          return ok({ url: s.page.url(), snapshot: snap.text });
        } catch (e) { return err((e as Error).message); }
      },
    },

    /* ==================== Observation ==================== */

    {
      schema: {
        name: 'browser.snapshot',
        description: 'Get a text representation of the current page. Shows headings, landmarks, and interactive elements with ref numbers. Interactive elements display as: [ref] role "name" value="..." Use ref numbers to target elements in click, fill, select, etc.',
        parameters: {
          type: 'object',
          properties: SESSION_PARAM,
          required: ['sessionId'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const s = pool().require(str(inp, 'sessionId'));
          const snap = await s.snapshot();
          return ok({ url: s.page.url(), snapshot: snap.text, elementCount: snap.elements.length });
        } catch (e) { return err((e as Error).message); }
      },
    },

    {
      schema: {
        name: 'browser.screenshot',
        description: 'Take a screenshot of the current page (base64 PNG). Use this when you need to visually inspect the page — for example to read images, charts, CAPTCHAs, or complex layouts that the text snapshot cannot capture.',
        parameters: {
          type: 'object',
          properties: SESSION_PARAM,
          required: ['sessionId'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const s = pool().require(str(inp, 'sessionId'));
          const b64 = await s.screenshot();
          return ok({ format: 'png', base64: b64 });
        } catch (e) { return err((e as Error).message); }
      },
    },

    /* ==================== Interaction ==================== */

    {
      schema: {
        name: 'browser.click',
        description: 'Click an element on the page. Target by ref number (from snapshot), CSS selector, or visible text. Returns the updated page snapshot after clicking.',
        parameters: {
          type: 'object',
          properties: TARGET_PARAMS,
          required: ['sessionId'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const s = pool().require(str(inp, 'sessionId'));
          const loc = s.locator(target(inp));
          await loc.click({ timeout: 10_000 });
          await s.settle();
          const snap = await s.snapshot();
          return ok({ clicked: true, snapshot: snap.text });
        } catch (e) { return err((e as Error).message); }
      },
    },

    {
      schema: {
        name: 'browser.fill',
        description: 'Clear a text input and type a new value. Target the input by ref, selector, or label text. Returns updated snapshot.',
        parameters: {
          type: 'object',
          properties: {
            ...TARGET_PARAMS,
            value: { type: 'string', description: 'Text to fill into the input' },
          },
          required: ['sessionId', 'value'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const s = pool().require(str(inp, 'sessionId'));
          const loc = s.locator(target(inp));
          await loc.fill(str(inp, 'value'), { timeout: 10_000 });
          await s.settle();
          const snap = await s.snapshot();
          return ok({ filled: true, snapshot: snap.text });
        } catch (e) { return err((e as Error).message); }
      },
    },

    {
      schema: {
        name: 'browser.select',
        description: 'Select an option from a <select> dropdown. Target the select element by ref, selector, or label. Provide the option value or visible text. Returns updated snapshot.',
        parameters: {
          type: 'object',
          properties: {
            ...TARGET_PARAMS,
            value: { type: 'string', description: 'Option value or visible label text to select' },
          },
          required: ['sessionId', 'value'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const s = pool().require(str(inp, 'sessionId'));
          const loc = s.locator(target(inp));
          const val = str(inp, 'value');
          // try by value first, fall back to label
          await loc.selectOption(val, { timeout: 10_000 }).catch(
            () => loc.selectOption({ label: val }, { timeout: 10_000 }));
          await s.settle();
          const snap = await s.snapshot();
          return ok({ selected: true, snapshot: snap.text });
        } catch (e) { return err((e as Error).message); }
      },
    },

    {
      schema: {
        name: 'browser.type',
        description: 'Type text character-by-character into the focused or targeted element. Useful for search boxes, autocomplete fields, and inputs that react to each keystroke. Slower than fill but triggers input/keydown events.',
        parameters: {
          type: 'object',
          properties: {
            ...TARGET_PARAMS,
            value: { type: 'string', description: 'Text to type character by character' },
            delay: { type: 'number', description: 'Delay between keystrokes in ms (default: 50)' },
          },
          required: ['sessionId', 'value'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const s = pool().require(str(inp, 'sessionId'));
          const loc = s.locator(target(inp));
          await loc.pressSequentially(str(inp, 'value'), { delay: num(inp, 'delay') ?? 50, timeout: 30_000 });
          await s.settle();
          const snap = await s.snapshot();
          return ok({ typed: true, snapshot: snap.text });
        } catch (e) { return err((e as Error).message); }
      },
    },

    {
      schema: {
        name: 'browser.hover',
        description: 'Hover over an element (useful for menus, tooltips, dropdowns that appear on hover). Returns updated snapshot.',
        parameters: {
          type: 'object',
          properties: TARGET_PARAMS,
          required: ['sessionId'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const s = pool().require(str(inp, 'sessionId'));
          const loc = s.locator(target(inp));
          await loc.hover({ timeout: 10_000 });
          await s.page.waitForTimeout(500); // let hover effects render
          const snap = await s.snapshot();
          return ok({ hovered: true, snapshot: snap.text });
        } catch (e) { return err((e as Error).message); }
      },
    },

    {
      schema: {
        name: 'browser.press',
        description: 'Press a keyboard key or key combination. Useful for Enter (submit forms), Tab (focus next), Escape (close modals), shortcuts (Control+a). Returns updated snapshot.',
        parameters: {
          type: 'object',
          properties: {
            ...SESSION_PARAM,
            key: { type: 'string', description: 'Key to press: Enter, Tab, Escape, Backspace, ArrowDown, Control+a, etc.' },
          },
          required: ['sessionId', 'key'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const s = pool().require(str(inp, 'sessionId'));
          await s.page.keyboard.press(str(inp, 'key'));
          await s.settle();
          const snap = await s.snapshot();
          return ok({ pressed: str(inp, 'key'), snapshot: snap.text });
        } catch (e) { return err((e as Error).message); }
      },
    },

    {
      schema: {
        name: 'browser.scroll',
        description: 'Scroll the page up or down to reveal more content. Use direction "down" to scroll towards the bottom (load more, see below-fold content) or "up" to go back to the top. Returns updated snapshot.',
        parameters: {
          type: 'object',
          properties: {
            ...SESSION_PARAM,
            direction: { type: 'string', description: '"up" or "down" (default: "down")' },
            amount: { type: 'number', description: 'Pixels to scroll (default: 600)' },
          },
          required: ['sessionId'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const s = pool().require(str(inp, 'sessionId'));
          const dir = str(inp, 'direction') === 'up' ? -1 : 1;
          const px = (num(inp, 'amount') ?? 600) * dir;
          await s.page.mouse.wheel(0, px);
          await s.page.waitForTimeout(500); // let lazy content load
          const snap = await s.snapshot();
          return ok({ scrolled: dir > 0 ? 'down' : 'up', pixels: Math.abs(px), snapshot: snap.text });
        } catch (e) { return err((e as Error).message); }
      },
    },

    {
      schema: {
        name: 'browser.wait',
        description: 'Wait for a condition before continuing: an element to appear, a URL change, or a fixed timeout. Returns updated snapshot once the condition is met.',
        parameters: {
          type: 'object',
          properties: {
            ...SESSION_PARAM,
            selector: { type: 'string', description: 'CSS selector to wait for (element appears/becomes visible)' },
            text:     { type: 'string', description: 'Wait for this text to appear on the page' },
            url:      { type: 'string', description: 'Wait for the URL to contain this substring' },
            timeout:  { type: 'number', description: 'Max wait time in ms (default: 10000)' },
          },
          required: ['sessionId'],
        },
      },
      async invoke(_ctx: ExecutionContext, inp: ToolInput): Promise<ToolOutput> {
        try {
          const s = pool().require(str(inp, 'sessionId'));
          const t = num(inp, 'timeout') ?? 10_000;

          if (str(inp, 'selector')) {
            await s.page.locator(str(inp, 'selector')).waitFor({ state: 'visible', timeout: t });
          } else if (str(inp, 'text')) {
            await s.page.getByText(str(inp, 'text')).waitFor({ state: 'visible', timeout: t });
          } else if (str(inp, 'url')) {
            await s.page.waitForURL(`**${str(inp, 'url')}**`, { timeout: t });
          } else {
            await s.page.waitForTimeout(Math.min(t, 10_000));
          }

          const snap = await s.snapshot();
          return ok({ waited: true, url: s.page.url(), snapshot: snap.text });
        } catch (e) { return err((e as Error).message); }
      },
    },

  ];
}
