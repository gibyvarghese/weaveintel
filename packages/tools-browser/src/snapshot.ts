/**
 * Page snapshot — captures a compact, LLM-friendly text representation of a web page.
 *
 * Interactive elements are assigned ref IDs (injected as data-pw-ref attributes)
 * so the agent can target them by number in subsequent actions.
 */
import type { Page } from 'playwright-core';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SnapshotElement {
  ref: number;
  role: string;
  name: string;
  tag: string;
  type?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  options?: { text: string; value: string; selected: boolean }[];
  href?: string;
}

export interface PageSnapshot {
  title: string;
  url: string;
  /** Human-readable text tree */
  text: string;
  /** Structured interactive-element list */
  elements: SnapshotElement[];
}

/* ------------------------------------------------------------------ */
/*  In-page capture script (runs inside the browser via page.evaluate) */
/* ------------------------------------------------------------------ */

const CAPTURE_SCRIPT = /* js */ `(() => {
  /* remove old refs */
  document.querySelectorAll('[data-pw-ref]').forEach(e => e.removeAttribute('data-pw-ref'));

  let nextRef = 0;
  const MAX_REFS = 250;
  const MAX_TEXT   = 120;
  const elements   = [];
  const lines      = [];

  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','PATH','META','LINK','HEAD','BR','HR','TEMPLATE']);
  const LANDMARK_MAP = {NAV:'navigation',MAIN:'main',ASIDE:'complementary',FOOTER:'contentinfo',HEADER:'banner',FORM:'form',DIALOG:'dialog',SECTION:'region',ARTICLE:'article'};
  const INTERACTIVE_TAGS = new Set(['A','BUTTON','INPUT','TEXTAREA','SELECT','DETAILS','SUMMARY']);
  const INTERACTIVE_ROLES = new Set(['button','link','tab','menuitem','checkbox','radio','switch','textbox','combobox','searchbox','slider','option','treeitem','spinbutton']);

  function vis(el) {
    if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.getClientRects().length === 0) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  function accName(el) {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.getAttribute('aria-labelledby')) {
      const ids = el.getAttribute('aria-labelledby').split(/\\s+/);
      const t = ids.map(id => { const e = document.getElementById(id); return e ? e.textContent.trim() : ''; }).filter(Boolean).join(' ');
      if (t) return t;
    }
    if (el.id) { const lbl = document.querySelector('label[for="'+CSS.escape(el.id)+'"]'); if (lbl) return lbl.textContent.trim(); }
    const pl = el.closest('label');
    if (pl) { const lt = Array.from(pl.childNodes).filter(n => n !== el && n.nodeType === 3).map(n => n.textContent.trim()).filter(Boolean).join(' '); if (lt) return lt; }
    if (el.title) return el.title;
    if (el.placeholder) return el.placeholder;
    const inner = (el.innerText || '').trim();
    if (inner && inner.length < 100) return inner;
    return '';
  }

  function role(el) {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'A')        return 'link';
    if (tag === 'BUTTON')   return 'button';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT')   return 'combobox';
    if (tag === 'DETAILS')  return 'group';
    if (tag === 'SUMMARY')  return 'button';
    if (tag === 'INPUT') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio')    return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'file')     return 'file';
      if (type === 'range')    return 'slider';
      return 'textbox';
    }
    return tag.toLowerCase();
  }

  function getOpts(el) {
    if (el.tagName !== 'SELECT') return undefined;
    return Array.from(el.options).slice(0, 30).map(o => ({ text: o.text, value: o.value, selected: o.selected }));
  }

  function getVal(el) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return el.value;
    if (tag === 'SELECT' && el.options[el.selectedIndex]) return el.options[el.selectedIndex].text;
    return undefined;
  }

  function isInteractive(el) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    const r = el.getAttribute('role');
    if (r && INTERACTIVE_ROLES.has(r)) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    if (el.getAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;
    return false;
  }

  function walk(node, depth) {
    if (node.nodeType === 3) {
      const t = node.textContent.trim();
      if (t && t.length > 2) {
        lines.push({ d: depth, t: 'text', c: t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '…' : t });
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.tagName;
    if (SKIP.has(tag)) return;
    if (!vis(el)) return;

    /* landmarks */
    const lm = LANDMARK_MAP[tag] || (['navigation','main','complementary','contentinfo','banner','form','dialog','region','search'].includes(el.getAttribute('role') || '') ? el.getAttribute('role') : null);
    if (lm) {
      const n = el.getAttribute('aria-label') || el.getAttribute('name') || '';
      lines.push({ d: depth, t: 'landmark', l: lm, n: n });
    }

    /* headings */
    const hMatch = /^H([1-6])$/.exec(tag);
    if (hMatch) {
      lines.push({ d: depth, t: 'heading', lvl: parseInt(hMatch[1]), c: (el.innerText || '').trim().slice(0, 200) });
    }

    /* interactive element */
    if (isInteractive(el) && nextRef < MAX_REFS) {
      nextRef++;
      el.setAttribute('data-pw-ref', String(nextRef));
      const info = {
        ref: nextRef,
        role: role(el),
        name: accName(el),
        tag: tag.toLowerCase(),
        type: el.getAttribute('type') || undefined,
        value: getVal(el),
        checked: el.checked || undefined,
        disabled: el.disabled || undefined,
        required: el.required || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        options: getOpts(el),
        href: tag === 'A' ? el.getAttribute('href') : undefined,
      };
      elements.push(info);
      lines.push({ d: depth, t: 'interactive', ...info });
    }

    /* recurse */
    const childDepth = lm || hMatch ? depth + 1 : depth;
    for (const child of el.childNodes) walk(child, childDepth);
  }

  walk(document.body, 0);

  return { title: document.title, url: location.href, lines: lines, elements: elements };
})()`;

/* ------------------------------------------------------------------ */
/*  Format raw capture into human-readable text                        */
/* ------------------------------------------------------------------ */

interface RawLine {
  d: number;
  t: string;
  /* landmark */  l?: string; n?: string;
  /* heading */   lvl?: number;
  /* text/heading */ c?: string;
  /* interactive */ ref?: number; role?: string; name?: string;
  value?: string; placeholder?: string; checked?: boolean;
  disabled?: boolean; required?: boolean;
  options?: { text: string; selected: boolean }[];
  href?: string;
}

interface RawCapture {
  title: string;
  url: string;
  lines: RawLine[];
  elements: SnapshotElement[];
}

function formatSnapshot(raw: RawCapture): string {
  const out: string[] = [`[Page] ${raw.title} | ${raw.url}`, ''];
  const MAX_LINES = 500;

  for (let i = 0; i < raw.lines.length && out.length < MAX_LINES; i++) {
    const item = raw.lines[i]!;
    const pad = '  '.repeat(item.d);
    switch (item.t) {
      case 'landmark':
        out.push(`${pad}--- ${item.l}${item.n ? ' "' + item.n + '"' : ''} ---`);
        break;
      case 'heading':
        out.push(`${pad}heading (h${item.lvl}) "${item.c}"`);
        break;
      case 'text':
        out.push(`${pad}${item.c}`);
        break;
      case 'interactive': {
        let line = `${pad}[${item.ref}] ${item.role}`;
        if (item.name) line += ` "${item.name}"`;
        if (item.value !== undefined && item.value !== '') line += ` value="${item.value}"`;
        if (item.placeholder) line += ` placeholder="${item.placeholder}"`;
        if (item.checked) line += ' [checked]';
        if (item.disabled) line += ' [disabled]';
        if (item.required) line += ' [required]';
        if (item.options) {
          const opts = item.options.map(o => (o.selected ? '»' : '') + `"${o.text}"`).join(', ');
          line += ` options=[${opts}]`;
        }
        if (item.href) line += ` → ${item.href}`;
        out.push(line);
        break;
      }
    }
  }

  if (raw.lines.length > MAX_LINES) {
    out.push(`\n... truncated (${raw.lines.length - MAX_LINES} more items). Use browser.snapshot with compact=true.`);
  }

  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export async function captureSnapshot(page: Page): Promise<PageSnapshot> {
  const raw: RawCapture = await page.evaluate(CAPTURE_SCRIPT);
  return {
    title: raw.title,
    url: raw.url,
    text: formatSnapshot(raw),
    elements: raw.elements,
  };
}

/* ------------------------------------------------------------------ */
/*  Login / auth detection                                             */
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

/**
 * Heuristic analysis of a page snapshot to detect login forms, CAPTCHAs, 2FA prompts.
 */
export function detectLoginForm(snapshot: PageSnapshot): LoginFormDetection {
  const els = snapshot.elements;
  const text = snapshot.text.toLowerCase();

  // Find password and username fields
  const passwordEl = els.find(e => e.type === 'password' || e.name?.toLowerCase().includes('password'));
  const usernameEl = els.find(e =>
    (e.tag === 'input' && (e.type === 'text' || e.type === 'email')) &&
    (e.name?.toLowerCase().includes('user') || e.name?.toLowerCase().includes('email') ||
     e.name?.toLowerCase().includes('login') || e.placeholder?.toLowerCase().includes('email') ||
     e.placeholder?.toLowerCase().includes('username')),
  );

  // Find submit button
  const submitEl = els.find(e =>
    (e.role === 'button' || e.tag === 'button' || (e.tag === 'input' && e.type === 'submit')) &&
    (e.name?.toLowerCase().includes('sign in') || e.name?.toLowerCase().includes('log in') ||
     e.name?.toLowerCase().includes('login') || e.name?.toLowerCase().includes('submit') ||
     e.name?.toLowerCase().includes('continue')),
  );

  // CAPTCHA detection
  const captchaPresent = text.includes('captcha') || text.includes('recaptcha') ||
    text.includes('hcaptcha') || text.includes('i\'m not a robot') ||
    text.includes('verify you are human') || text.includes('cloudflare');

  // 2FA detection
  const twoFactorPresent = text.includes('two-factor') || text.includes('2fa') ||
    text.includes('verification code') || text.includes('authenticator') ||
    text.includes('one-time') || text.includes('otp') ||
    els.some(e => e.name?.toLowerCase().includes('otp') || e.name?.toLowerCase().includes('verification'));

  // OAuth button detection
  const oauthKeywords = ['google', 'github', 'microsoft', 'facebook', 'apple', 'twitter', 'sso', 'saml'];
  const oauthButtons = els
    .filter(e => (e.role === 'button' || e.role === 'link') &&
      oauthKeywords.some(k => e.name?.toLowerCase().includes(k) &&
        (e.name?.toLowerCase().includes('sign') || e.name?.toLowerCase().includes('log') || e.name?.toLowerCase().includes('continue'))))
    .map(e => e.name);

  // Determine page type
  if (captchaPresent) {
    return { detected: true, type: 'captcha', captchaPresent, twoFactorPresent, oauthButtons };
  }
  if (twoFactorPresent && !passwordEl) {
    return { detected: true, type: '2fa', captchaPresent, twoFactorPresent, oauthButtons };
  }
  if (oauthButtons.length > 0 && !passwordEl) {
    return { detected: true, type: 'oauth_prompt', oauthButtons, captchaPresent, twoFactorPresent };
  }
  if (passwordEl) {
    return {
      detected: true,
      type: 'login',
      usernameRef: usernameEl?.ref,
      passwordRef: passwordEl.ref,
      submitRef: submitEl?.ref,
      captchaPresent,
      twoFactorPresent,
      oauthButtons,
    };
  }

  return { detected: false, type: 'unknown', captchaPresent, twoFactorPresent, oauthButtons };
}
