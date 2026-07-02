// SPDX-License-Identifier: MIT
/**
 * @weaveintel/artifacts — content REDACTION for safe publishing (weaveNotes Phase 4).
 *
 * Before a document is turned into a PUBLIC artifact (a shareable link anyone can
 * open), it should be scanned for things you almost never mean to publish — API
 * keys, tokens, private keys — and, for sensitive documents, personal data (emails,
 * phone numbers, card/SSN-like numbers). This is the mid-2026 "DLP before share"
 * best practice: classify by sensitivity, then redact accordingly, so a stray
 * secret in a note never leaks the moment it is shared.
 *
 * --- For someone new to this ---
 * "Redaction" means blacking-out sensitive bits of text before others see it (like
 * the black bars on a released government document). Here we replace a detected
 * secret/PII with a clearly-marked placeholder such as `[REDACTED-SECRET]`. "PII" is
 * Personally Identifiable Information — emails, phone numbers, etc. This module is
 * PURE (no I/O), deterministic, and zero-dependency, so it is easy to test and runs
 * anywhere.
 *
 * It is intentionally conservative, not a replacement for a full DLP engine: it
 * catches the common, high-signal shapes (so we never claim more than it does).
 */

/** How aggressively to redact. `secrets` ⊂ `pii` (pii also redacts everything secrets does). */
export type RedactionLevel = 'none' | 'secrets' | 'pii';

export interface RedactionResult {
  /** The redacted text. */
  text: string;
  /** How many spans were redacted. */
  redactions: number;
  /** The distinct kinds redacted (e.g. `['api-key','email']`) — useful for an audit note. */
  kinds: string[];
}

interface Pattern { kind: string; level: Exclude<RedactionLevel, 'none'>; re: RegExp; mask: string }

// Ordered most-specific first. `g` flag is required (we use String.replace with a global regex).
const PATTERNS: Pattern[] = [
  // ── Secrets (always scrubbed when level is at least `secrets`) ──────────────
  { kind: 'private-key', level: 'secrets', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, mask: '[REDACTED-PRIVATE-KEY]' },
  { kind: 'jwt',         level: 'secrets', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, mask: '[REDACTED-JWT]' },
  { kind: 'api-key',     level: 'secrets', re: /\b(?:sk-[A-Za-z0-9]{16,}|rk_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, mask: '[REDACTED-SECRET]' },
  { kind: 'bearer',      level: 'secrets', re: /\bBearer\s+[A-Za-z0-9._-]{16,}/g, mask: 'Bearer [REDACTED-TOKEN]' },
  // ── PII (scrubbed only when level is `pii`) ─────────────────────────────────
  { kind: 'email',       level: 'pii', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, mask: '[REDACTED-EMAIL]' },
  { kind: 'ssn',         level: 'pii', re: /\b\d{3}-\d{2}-\d{4}\b/g, mask: '[REDACTED-SSN]' },
  { kind: 'credit-card', level: 'pii', re: /\b(?:\d[ -]?){15,16}\b/g, mask: '[REDACTED-CARD]' },
  { kind: 'phone',       level: 'pii', re: /\b(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, mask: '[REDACTED-PHONE]' },
];

const ORDER: RedactionLevel[] = ['none', 'secrets', 'pii'];

/**
 * Redact secret/PII spans from `text` at the given `level` (default `secrets`).
 * Returns the redacted text plus a count + the kinds found (for an audit trail).
 * `none` returns the text unchanged.
 */
export function redactText(text: string, level: RedactionLevel = 'secrets'): RedactionResult {
  if (level === 'none' || !text) return { text, redactions: 0, kinds: [] };
  const maxIdx = ORDER.indexOf(level);
  let out = text;
  let redactions = 0;
  const kinds = new Set<string>();
  for (const p of PATTERNS) {
    if (ORDER.indexOf(p.level) > maxIdx) continue; // skip kinds above the requested level
    out = out.replace(p.re, () => { redactions++; kinds.add(p.kind); return p.mask; });
  }
  return { text: out, redactions, kinds: [...kinds] };
}

// ─── Publish policy by sensitivity ───────────────────────────────────────────

/** A document's sensitivity classification (matches the geneWeave note model). */
export type PublishSensitivity = 'normal' | 'confidential' | 'restricted';

export interface PublishPolicy {
  /** Whether the document may be published as an artifact at all. */
  allowed: boolean;
  /** How hard to redact its content before publishing. */
  redactionLevel: RedactionLevel;
  /** Why publishing was refused (when `allowed` is false). */
  reason?: string;
}

/**
 * Decide whether a document of the given sensitivity may be published, and how hard
 * to redact it:
 *   - `restricted`   → refused outright (cannot be turned into a public artifact);
 *   - `confidential` → allowed, but redact PII **and** secrets (aggressive);
 *   - `normal`       → allowed; still scrub obvious SECRETS as a safety net, so a
 *                       stray API key in a note never leaks when it is shared.
 */
export function publishPolicyForSensitivity(s: PublishSensitivity): PublishPolicy {
  switch (s) {
    case 'restricted':   return { allowed: false, redactionLevel: 'none', reason: 'restricted notes cannot be published' };
    case 'confidential': return { allowed: true, redactionLevel: 'pii' };
    case 'normal':
    default:             return { allowed: true, redactionLevel: 'secrets' };
  }
}
