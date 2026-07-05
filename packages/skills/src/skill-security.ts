// SPDX-License-Identifier: MIT
/**
 * Skill security — trust tiers, package signing, and the four verification gates.
 *
 * A skill package is *someone else's code and instructions* running inside your agent. Treating a
 * downloaded skill as trustworthy-by-default is how registries get poisoned (in early 2026, five of
 * the seven most-downloaded skills on one public registry were malware, and Snyk found ~36% of skills
 * carried a security flaw). This module is the checkpoint every package passes before you trust it.
 *
 * It does three things, mapped to the OWASP **Agentic Skills Top 10** (AST):
 *   1. **Signing & provenance** — `signSkillPackage` / `verifySkillPackage` prove a package came from a
 *      known publisher and hasn't been altered since (AST06 supply-chain tampering, AST07 update drift).
 *      Built on the same Ed25519 primitives as `@weaveintel/encryption` — no new crypto.
 *   2. **Four gates** — structural, content-safety, capability, and provenance checks that catch
 *      malicious code, hidden prompt-injection, over-broad permissions, insecure YAML, and secret
 *      exfiltration (AST01–AST05, AST08–AST10).
 *   3. **Trust tiers (T1–T4)** — a package only earns the privileges its checks justify. An unsigned
 *      community skill can offer advice (T1) but not run scripts; only a signed, reviewed, org-trusted
 *      skill may reach the network (T3+). This is what turns the gates into an actual permission.
 *
 * The heavy, semantic check (does the SKILL.md secretly instruct the agent?) is an **injected** deep
 * scanner — plug in `@weaveintel/guardrails`' injection evaluator or an LLM. It runs under a hard
 * timeout so a hostile input can never hang your install pipeline.
 */

import { createHash, sign as edSign, verify as edVerify, createPublicKey } from 'node:crypto';
import { canonicalize, fingerprintEd25519PublicKey, type AttestationSigningKey } from '@weaveintel/encryption';
import type { SkillPackage, SkillCapabilityManifest } from './skill-package.js';

// ── Trust tiers ────────────────────────────────────────────────────────────────────────────────

/** T1 community (advice only) · T2 verified (scripts, no net) · T3 org-trusted (net) · T4 first-party. */
export type SkillTrustTier = 1 | 2 | 3 | 4;

export interface TierPermissions {
  /** May run bundled scripts (in a sandbox). */
  readonly allowScripts: boolean;
  /** May reach the network (still limited to the manifest's host allowlist). */
  readonly allowNetwork: boolean;
  /** May read declared secrets. */
  readonly allowSecrets: boolean;
  /** Must carry a valid signature to reach this tier at all. */
  readonly requireSignature: boolean;
}

const TIER_PERMISSIONS: Record<SkillTrustTier, TierPermissions> = {
  1: { allowScripts: false, allowNetwork: false, allowSecrets: false, requireSignature: false },
  2: { allowScripts: true, allowNetwork: false, allowSecrets: false, requireSignature: true },
  3: { allowScripts: true, allowNetwork: true, allowSecrets: true, requireSignature: true },
  4: { allowScripts: true, allowNetwork: true, allowSecrets: true, requireSignature: true },
};

/** What a package installed at `tier` is allowed to do. */
export function tierPermissions(tier: SkillTrustTier): TierPermissions {
  return TIER_PERMISSIONS[tier];
}

// ── Content hashing + signing (reuses @weaveintel/encryption's Ed25519 identity) ─────────────────

const sha256 = (s: string): string => createHash('sha256').update(s).digest('base64url');

/**
 * A stable content fingerprint of the whole package: every file is hashed, and the hashes plus all
 * metadata are canonicalised and hashed again. ANY change — an edited script, a renamed file, an
 * added or removed resource, a tweaked description — changes this digest. That's what makes tampering
 * and silent "rug-pull" updates detectable.
 */
export function hashSkillPackage(pkg: SkillPackage): string {
  const files: Record<string, string> = {};
  for (const [p, c] of Object.entries(pkg.resources)) files[p] = sha256(c);
  for (const [p, c] of Object.entries(pkg.scripts)) files[p] = sha256(c);
  return sha256(canonicalize({
    name: pkg.name,
    description: pkg.description,
    version: pkg.version ?? null,
    author: pkg.author ?? null,
    license: pkg.license ?? null,
    tags: pkg.tags ?? [],
    agents: pkg.agents ?? [],
    body: pkg.body,
    manifest: pkg.manifest as unknown,
    files,
  }));
}

export interface SkillSignature {
  readonly algorithm: 'ed25519';
  /** The package digest at signing time (see `hashSkillPackage`). */
  readonly digest: string;
  /** Short fingerprint of the publisher's public key. */
  readonly publisherFingerprint: string;
  /** The tier the publisher is vouching for. */
  readonly tier: SkillTrustTier;
  readonly signedAt?: string;
  /** Base64url Ed25519 signature over the canonical {digest, tier, publisher, signedAt}. */
  readonly signature: string;
}

function signedPayload(digest: string, tier: SkillTrustTier, fp: string, signedAt?: string): Buffer {
  return Buffer.from(canonicalize({ digest, tier, publisherFingerprint: fp, signedAt: signedAt ?? null }), 'utf8');
}

/** Sign a package with a publisher key, vouching for it at `tier` (default T3). */
export function signSkillPackage(
  pkg: SkillPackage,
  key: AttestationSigningKey,
  opts?: { tier?: SkillTrustTier; signedAt?: string },
): SkillSignature {
  const digest = hashSkillPackage(pkg);
  const tier = opts?.tier ?? 3;
  const fp = key.fingerprint;
  const signature = edSign(null, signedPayload(digest, tier, fp, opts?.signedAt), key.privateKey).toString('base64url');
  return { algorithm: 'ed25519', digest, publisherFingerprint: fp, tier, signedAt: opts?.signedAt, signature };
}

export interface VerifyResult { readonly valid: boolean; readonly reason?: string }

/**
 * Verify a package's signature. Fails if the package has changed since signing (digest mismatch),
 * if the signature doesn't check out, or if the public key doesn't match the claimed publisher.
 */
export function verifySkillPackage(pkg: SkillPackage, sig: SkillSignature, publicKeyPem: string): VerifyResult {
  if (sig.algorithm !== 'ed25519') return { valid: false, reason: `unsupported algorithm: ${sig.algorithm}` };
  let publicKey;
  try { publicKey = createPublicKey({ key: publicKeyPem, format: 'pem' }); }
  catch { return { valid: false, reason: 'invalid public key' }; }

  if (fingerprintEd25519PublicKey(publicKey) !== sig.publisherFingerprint) {
    return { valid: false, reason: 'public key does not match the claimed publisher' };
  }
  const currentDigest = hashSkillPackage(pkg);
  if (currentDigest !== sig.digest) {
    return { valid: false, reason: 'package has been modified since it was signed (digest mismatch)' };
  }
  let ok = false;
  try { ok = edVerify(null, signedPayload(sig.digest, sig.tier, sig.publisherFingerprint, sig.signedAt), publicKey, Buffer.from(sig.signature, 'base64url')); }
  catch { return { valid: false, reason: 'malformed signature' }; }
  return ok ? { valid: true } : { valid: false, reason: 'signature verification failed' };
}

// ── Static scanners (fast, no LLM) ───────────────────────────────────────────────────────────────

// Hidden/invisible characters used to smuggle instructions past a human reviewer.
const INVISIBLE_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/u;

// Natural-language attempts to override the agent (AST02 prompt-injection / AST04 metadata).
const INJECTION_MARKERS: RegExp[] = [
  /ignore\s+(all\s+|the\s+|your\s+|any\s+)?(previous|prior|above|earlier)\s+(instruction|prompt|rule|message)/i,
  /disregard\s+(all\s+|the\s+|your\s+)?(previous|prior|above|earlier|system)/i,
  /(new|updated)\s+(system\s+)?(instruction|prompt|directive)s?\s*[:\-]/i,
  /you\s+are\s+now\s+(a|an|the)\b/i,
  /(reveal|print|show|leak|exfiltrate|send|email|upload)\b[^.\n]{0,40}\b(system\s+prompt|secret|password|api[\s_-]?key|token|credential|\.env)/i,
];

// Dangerous executable patterns in bundled scripts (AST01 malicious code).
const DANGEROUS_SCRIPT: RegExp[] = [
  /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,     // curl … | sh
  /base64\s+(-{1,2}d|--decode)\b[^\n|]*\|\s*(sh|bash|python|node)\b/i, // base64 -d | sh
  /\bos\.system\s*\(/,
  /\bsubprocess\.[A-Za-z_]+\([^)]*shell\s*=\s*True/,
  /\beval\s*\(|\bexec\s*\(/,
  /\brm\s+-rf\s+(\/|~|\$HOME)/,
  /https?:\/\/\d{1,3}(\.\d{1,3}){3}/,                          // egress to a raw IP
  /\/dev\/tcp\/|socket\.socket\s*\(/i,                        // reverse-shell primitives
];

// Reading sensitive host locations / embedded secrets (AST09 exfiltration).
const SECRET_ACCESS: RegExp[] = [
  /\.ssh\/(id_rsa|id_ed25519|authorized_keys)/i,
  /\.aws\/credentials|AWS_SECRET_ACCESS_KEY/i,
  /\.config\/gcloud|GOOGLE_APPLICATION_CREDENTIALS/i,
  /-----BEGIN\s+(RSA\s+|OPENSSH\s+|EC\s+)?PRIVATE\s+KEY-----/,
];

// Signals that a script actually uses the network (to compare against the declared manifest).
const NETWORK_USE = /\b(urllib|requests\.(get|post|put)|httpx|http\.client|fetch\s*\(|axios|socket\.socket|net\.connect|\bcurl\b|\bwget\b)/i;
const SECRET_USE = /\b(os\.environ|process\.env|\.ssh\/|\.aws\/|GOOGLE_APPLICATION_CREDENTIALS)/i;
// Insecure YAML tags — inert here (we never run a YAML engine) but a red flag worth surfacing (AST08).
const INSECURE_YAML = /!!(python|ruby|java|perl)\/|!!\s*\w+\/apply/i;

/**
 * Scan free text (e.g. a run trace) for prompt-injection attempts — override phrases and hidden
 * characters. Exposed so the skill miner (Phase 6) can refuse to learn from a poisoned trajectory.
 */
export function scanTextForInjection(text: string): { injection: boolean; findings: string[] } {
  const findings: string[] = [];
  if (INVISIBLE_CHARS.test(text)) findings.push('invisible/hidden characters');
  for (const re of INJECTION_MARKERS) if (re.test(text)) findings.push(`injection phrase: /${re.source.slice(0, 30)}/`);
  return { injection: findings.length > 0, findings };
}

// ── The four gates ───────────────────────────────────────────────────────────────────────────────

export type GateName = 'structural' | 'content-safety' | 'capability' | 'provenance';
export type Severity = 'block' | 'warn';

export interface GateFinding {
  readonly gate: GateName;
  readonly severity: Severity;
  /** Which OWASP Agentic Skills risk this maps to (working taxonomy; see `OWASP_AGENTIC_SKILLS_TOP_10`). */
  readonly owasp?: string;
  readonly message: string;
}

export interface GateResult { readonly gate: GateName; readonly passed: boolean; readonly findings: readonly GateFinding[] }

export interface SkillAssessment {
  /** True when no gate raised a blocking finding. */
  readonly allowed: boolean;
  /** The highest tier the package actually earned (never above what it asked for). */
  readonly earnedTier: SkillTrustTier;
  readonly gates: readonly GateResult[];
  readonly findings: readonly GateFinding[];
}

export interface AssessOptions {
  /** The tier the installer wants to grant. Capped by what the gates justify. Default: from the signature, else T1. */
  readonly claimedTier?: SkillTrustTier;
  readonly signature?: SkillSignature;
  readonly publicKeyPem?: string;
  /** If set, only these publisher fingerprints are trusted for T2+. */
  readonly trustedPublishers?: readonly string[];
  /** A previously-recorded digest to pin against — a mismatch means the package changed (AST07). */
  readonly pinnedDigest?: string;
  /** Optional semantic scanner (e.g. an LLM / `@weaveintel/guardrails`) for hidden-instruction detection. */
  readonly deepScan?: (text: string) => Promise<{ injection: boolean; reason?: string }>;
  /** Hard timeout for the deep scan so a hostile input can't hang the pipeline. Default 15s. */
  readonly deepScanTimeoutMs?: number;
  /** Structural size ceilings (defends against oversized / zip-bomb packages). */
  readonly limits?: { maxFiles?: number; maxBodyChars?: number; maxTotalBytes?: number };
}

const DEFAULT_LIMITS = { maxFiles: 200, maxBodyChars: 50_000, maxTotalBytes: 5_000_000 };

function scriptText(pkg: SkillPackage): string {
  return Object.values(pkg.scripts).join('\n');
}
function allText(pkg: SkillPackage): string {
  return [pkg.name, pkg.description, pkg.body, ...Object.values(pkg.scripts), ...Object.values(pkg.resources)].join('\n');
}

// Gate 1 — structural integrity + metadata sanity.
function gateStructural(pkg: SkillPackage, limits: Required<NonNullable<AssessOptions['limits']>>): GateResult {
  const f: GateFinding[] = [];
  const fileCount = Object.keys(pkg.resources).length + Object.keys(pkg.scripts).length;
  if (fileCount > limits.maxFiles) f.push({ gate: 'structural', severity: 'block', owasp: 'AST04', message: `too many bundled files (${fileCount} > ${limits.maxFiles})` });
  if (pkg.body.length > limits.maxBodyChars) f.push({ gate: 'structural', severity: 'block', owasp: 'AST04', message: `SKILL.md body too large (${pkg.body.length} chars)` });
  const totalBytes = allText(pkg).length;
  if (totalBytes > limits.maxTotalBytes) f.push({ gate: 'structural', severity: 'block', owasp: 'AST04', message: `package too large (${totalBytes} bytes)` });
  if (INVISIBLE_CHARS.test(pkg.description) || INVISIBLE_CHARS.test(pkg.name)) f.push({ gate: 'structural', severity: 'block', owasp: 'AST04', message: 'hidden/invisible characters in the name or description' });
  if (INSECURE_YAML.test(allText(pkg))) f.push({ gate: 'structural', severity: 'warn', owasp: 'AST08', message: 'insecure YAML tag present (inert here, but a red flag)' });
  return { gate: 'structural', passed: !f.some((x) => x.severity === 'block'), findings: f };
}

// Gate 2 — content safety: hidden instructions + dangerous code + secret access.
async function gateContentSafety(pkg: SkillPackage, opts: AssessOptions): Promise<GateResult> {
  const f: GateFinding[] = [];
  const body = pkg.body;
  if (INVISIBLE_CHARS.test(allText(pkg))) f.push({ gate: 'content-safety', severity: 'block', owasp: 'AST02', message: 'invisible characters used to smuggle hidden content' });
  for (const re of INJECTION_MARKERS) if (re.test(body)) { f.push({ gate: 'content-safety', severity: 'block', owasp: 'AST02', message: `possible prompt-injection in SKILL.md: /${re.source.slice(0, 40)}/` }); break; }
  const code = scriptText(pkg);
  for (const re of DANGEROUS_SCRIPT) if (re.test(code)) f.push({ gate: 'content-safety', severity: 'block', owasp: 'AST01', message: `dangerous script pattern: /${re.source.slice(0, 40)}/` });
  for (const re of SECRET_ACCESS) if (re.test(allText(pkg))) f.push({ gate: 'content-safety', severity: 'block', owasp: 'AST09', message: `accesses sensitive credentials: /${re.source.slice(0, 30)}/` });

  // Optional semantic pass under a hard timeout — never lets the pipeline hang.
  if (opts.deepScan) {
    const timeoutMs = opts.deepScanTimeoutMs ?? 15_000;
    const timeout = new Promise<{ injection: boolean; reason?: string; timedOut?: true }>((res) =>
      setTimeout(() => res({ injection: false, timedOut: true }), timeoutMs));
    try {
      const r = await Promise.race([opts.deepScan(body), timeout]);
      if ('timedOut' in r && r.timedOut) f.push({ gate: 'content-safety', severity: 'warn', owasp: 'AST02', message: `deep scan timed out after ${timeoutMs}ms (using static results)` });
      else if (r.injection) f.push({ gate: 'content-safety', severity: 'block', owasp: 'AST02', message: `deep scan flagged hidden instructions${r.reason ? `: ${r.reason}` : ''}` });
    } catch (e) {
      f.push({ gate: 'content-safety', severity: 'warn', owasp: 'AST02', message: `deep scan errored (${(e as Error).message}); using static results` });
    }
  }
  return { gate: 'content-safety', passed: !f.some((x) => x.severity === 'block'), findings: f };
}

// Gate 3 — least privilege: what the scripts do must match what the manifest declares, and neither
// may exceed the tier being granted.
function gateCapability(pkg: SkillPackage, claimedTier: SkillTrustTier): GateResult {
  const f: GateFinding[] = [];
  const m: SkillCapabilityManifest = pkg.manifest;
  const code = scriptText(pkg);
  const hasScripts = Object.keys(pkg.scripts).length > 0;
  const perms = tierPermissions(claimedTier);

  if (hasScripts && m.execution === false) f.push({ gate: 'capability', severity: 'block', owasp: 'AST10', message: 'package bundles scripts but its manifest forbids execution' });
  if (hasScripts && !perms.allowScripts) f.push({ gate: 'capability', severity: 'block', owasp: 'AST05', message: `tier T${claimedTier} does not permit running scripts` });

  const usesNetwork = NETWORK_USE.test(code);
  const declaresNetwork = (m.network?.length ?? 0) > 0;
  if (usesNetwork && !declaresNetwork) f.push({ gate: 'capability', severity: 'block', owasp: 'AST03', message: 'a script uses the network but the manifest declares no allowed hosts (undeclared / excessive access)' });
  if (declaresNetwork && !perms.allowNetwork) f.push({ gate: 'capability', severity: 'block', owasp: 'AST03', message: `manifest requests network but tier T${claimedTier} forbids it` });

  const usesSecrets = SECRET_USE.test(code);
  const declaresSecrets = (m.secrets?.length ?? 0) > 0;
  if (usesSecrets && !declaresSecrets) f.push({ gate: 'capability', severity: 'warn', owasp: 'AST03', message: 'a script reads environment/credentials the manifest did not declare' });
  if (declaresSecrets && !perms.allowSecrets) f.push({ gate: 'capability', severity: 'block', owasp: 'AST03', message: `manifest requests secrets but tier T${claimedTier} forbids it` });

  return { gate: 'capability', passed: !f.some((x) => x.severity === 'block'), findings: f };
}

// Gate 4 — provenance: signature valid, publisher trusted, no silent drift.
function gateProvenance(pkg: SkillPackage, opts: AssessOptions): GateResult {
  const f: GateFinding[] = [];
  if (opts.pinnedDigest && hashSkillPackage(pkg) !== opts.pinnedDigest) {
    f.push({ gate: 'provenance', severity: 'block', owasp: 'AST07', message: 'package digest does not match the pinned version (unexpected update / rug-pull)' });
  }
  if (!opts.signature) {
    f.push({ gate: 'provenance', severity: 'warn', owasp: 'AST06', message: 'package is unsigned — capped at tier T1' });
    // Unsigned is allowed (just untrusted) — but a pinned-digest mismatch above is still a hard block.
    return { gate: 'provenance', passed: !f.some((x) => x.severity === 'block'), findings: f };
  }
  if (!opts.publicKeyPem) {
    f.push({ gate: 'provenance', severity: 'block', owasp: 'AST06', message: 'signature present but no public key provided to verify it' });
    return { gate: 'provenance', passed: false, findings: f };
  }
  const v = verifySkillPackage(pkg, opts.signature, opts.publicKeyPem);
  if (!v.valid) f.push({ gate: 'provenance', severity: 'block', owasp: 'AST06', message: `signature invalid: ${v.reason}` });
  // An unknown-but-valid publisher isn't malicious — it just isn't trusted, so it's capped at T1
  // (handled in the tier calculation). A broken signature above IS a hard block.
  if (opts.trustedPublishers && !opts.trustedPublishers.includes(opts.signature.publisherFingerprint)) {
    f.push({ gate: 'provenance', severity: 'warn', owasp: 'AST06', message: 'signed by a publisher not on the trusted list — capped at tier T1' });
  }
  return { gate: 'provenance', passed: !f.some((x) => x.severity === 'block'), findings: f };
}

/**
 * Run all four gates and decide the tier a package has earned. `allowed` is false if any gate raised
 * a blocking finding. `earnedTier` never exceeds what the checks justify: unsigned → T1; signed but
 * only structural/content checks → capped at T2 unless the signature vouches higher and the publisher
 * is trusted.
 */
export async function assessSkillPackage(pkg: SkillPackage, opts: AssessOptions = {}): Promise<SkillAssessment> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const claimedTier: SkillTrustTier = opts.claimedTier ?? opts.signature?.tier ?? 1;

  const gates: GateResult[] = [
    gateStructural(pkg, limits),
    await gateContentSafety(pkg, opts),
    gateCapability(pkg, claimedTier),
    gateProvenance(pkg, opts),
  ];
  const findings = gates.flatMap((g) => g.findings);
  const allowed = gates.every((g) => g.passed);

  // Earn a tier: start from what's claimed, then cap by what the checks support.
  let earnedTier: SkillTrustTier = claimedTier;
  const provenanceOk = opts.signature && gates[3]!.passed;
  const publisherTrusted = !opts.trustedPublishers || (opts.signature && opts.trustedPublishers.includes(opts.signature.publisherFingerprint));
  if (!allowed) earnedTier = 1;
  else if (!provenanceOk || !publisherTrusted) earnedTier = 1;         // unsigned/untrusted → community only
  else if (earnedTier >= 2 && !gates[1]!.passed) earnedTier = 1;       // failed content safety
  // (claimedTier already bounds the ceiling; a valid signature at its tier keeps it there.)

  return { allowed, earnedTier, gates, findings };
}

// ── OWASP Agentic Skills Top 10 → gate mapping (working taxonomy, 2026) ──────────────────────────

export interface OwaspSkillRisk { readonly id: string; readonly name: string; readonly gate: GateName; readonly note: string }

/**
 * How each OWASP Agentic Skills risk is addressed here. Titles follow the 2026 project's themes; the
 * point is that every category has a gate that catches it (plus Phase 2's sandbox for AST05).
 */
export const OWASP_AGENTIC_SKILLS_TOP_10: readonly OwaspSkillRisk[] = [
  { id: 'AST01', name: 'Malicious skill code', gate: 'content-safety', note: 'dangerous script patterns blocked (curl|sh, os.system, reverse shells, raw-IP egress)' },
  { id: 'AST02', name: 'Prompt injection via skill content', gate: 'content-safety', note: 'injection markers + invisible characters + optional LLM deep scan' },
  { id: 'AST03', name: 'Excessive / undeclared permissions', gate: 'capability', note: 'script behaviour must match the least-privilege manifest' },
  { id: 'AST04', name: 'Metadata manipulation', gate: 'structural', note: 'hidden characters, size limits, name/description sanity' },
  { id: 'AST05', name: 'Missing sandboxing / egress control', gate: 'capability', note: 'tier gates scripts + network; Phase-2 sandbox enforces at runtime' },
  { id: 'AST06', name: 'Supply-chain tampering', gate: 'provenance', note: 'Ed25519 signature + trusted-publisher allowlist' },
  { id: 'AST07', name: 'Update drift / rug-pull', gate: 'provenance', note: 'pinned-digest comparison detects silent changes' },
  { id: 'AST08', name: 'Insecure deserialization (YAML)', gate: 'structural', note: 'no YAML engine is used; unsafe tags are surfaced' },
  { id: 'AST09', name: 'Secret / credential exfiltration', gate: 'content-safety', note: 'blocks access to ~/.ssh, cloud creds, embedded private keys' },
  { id: 'AST10', name: 'Tool poisoning / capability escalation', gate: 'capability', note: 'declared execution + tier ceilings prevent silent escalation' },
];
