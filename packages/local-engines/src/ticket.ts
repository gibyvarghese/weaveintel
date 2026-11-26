// SPDX-License-Identifier: MIT
/**
 * Routing tickets: what the issuing server lets one device try, in order, for one task on one record.
 *
 * A ticket carries no record content. It names the fields the device may read, the steps of the chain, and two
 * hashes: one over the field list, one over the chain. The server computes both with the functions below when it
 * issues the ticket (and stores them), and recomputes them when a result comes back. The device recomputes them before
 * it walks the chain and refuses a ticket whose hashes do not match: a ticket altered on the way (an extra step, a
 * lowered confidence floor, another field) is never walked.
 *
 * The server's signature is the authority. The device can check it too when the host hands it a verifier (a public
 * key), but the server never trusts the device to have done so: it checks the ticket again on every result.
 */

import { base64UrlDecode, canonicalJson, sha256Hex } from './canonical.js';
import {
  ENGINE_CLASSES,
  ENGINES_NEVER_ON_SHELL,
  HOSTED_ENGINE_CLASSES,
  type EngineClass,
  type Shell,
} from './constants.js';

/** A file a step must load, pinned by size and hash (empty for built-in and hosted steps). */
export interface TicketFile {
  readonly name: string;
  /** Lower-case hex SHA-256 of the file's bytes. */
  readonly sha256: string;
  readonly bytes: number;
}

/** One step of a chain, as a ticket lists it. */
export interface ChainStep {
  readonly position: number;
  readonly engineClass: EngineClass;
  /** A catalogue model key or a built-in engine's id. Empty for a hosted step. */
  readonly modelKey: string;
  readonly timeoutMs: number;
  /** 0 means the step needs no confidence score. */
  readonly minConfidence: number;
  /** 0 means the step may not download anything. */
  readonly maxDownloadMb: number;
  /** The step can run with no network. */
  readonly offlineOk: boolean;
  readonly files: readonly TicketFile[];
}

/** The ticket without its hashes and signature: what the server builds before sealing. */
export interface TicketBody {
  readonly ticketId: string;
  readonly tenantId: string;
  readonly person: string;
  readonly task: string;
  readonly record: { readonly table: string; readonly id: string };
  /** The fields the device may read, already filtered by the person's rights and the task's local ceiling. */
  readonly fields: readonly string[];
  readonly steps: readonly ChainStep[];
  readonly policyVersion: number;
  /** ISO 8601. */
  readonly expiresAt: string;
  /** The administrator chose "local only" (with the acknowledgement): the chain has no hosted end. */
  readonly localOnly?: boolean;
}

/** A sealed ticket: the body plus the two hashes, and the server's signature when it signs. */
export interface RoutingTicket extends TicketBody {
  readonly fieldListHash: string;
  readonly chainHash: string;
  /** Base64url signature over {@link ticketSigningPayload}. */
  readonly signature?: string;
}

/** Why a ticket was refused. Nothing in a refused ticket runs. */
export const TICKET_REFUSAL_CODES = [
  'malformed',
  'expired',
  'field_list_hash_mismatch',
  'chain_hash_mismatch',
  'no_hosted_end',
  'hosted_not_last',
  'engine_not_allowed_on_shell',
  'signature_missing',
  'signature_invalid',
] as const;
export type TicketRefusalCode = (typeof TICKET_REFUSAL_CODES)[number];

export type TicketCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: TicketRefusalCode; readonly message: string };

/** Checks a signature over the canonical payload. A host builds one from its public key. */
export type TicketSignatureVerifier = (payload: Uint8Array, signature: string) => Promise<boolean>;

export interface TicketCheckOptions {
  /** Where the chain will run; engines that shell may never use refuse the ticket. */
  readonly shell: Shell;
  /** Milliseconds since the epoch, or a date. Defaults to `Date.now()`. */
  readonly now?: number | Date;
  readonly verifySignature?: TicketSignatureVerifier;
  /** Refuse a ticket that has no signature (or when no verifier was given). Default false. */
  readonly requireSignature?: boolean;
}

/**
 * Hash of the field list: sorted, de-duplicated, canonical JSON, SHA-256. Order and repeats do not change it;
 * adding or removing a field does.
 */
export async function hashFieldList(fields: readonly string[]): Promise<string> {
  const sorted = [...new Set(fields)].sort();
  return sha256Hex(canonicalJson(sorted));
}

/**
 * Hash of the chain: every step (ordered by position, files ordered by name) and the local-only flag. Any change to
 * an engine, a model, a timeout, a floor, a download limit or a file hash changes it.
 */
export async function hashChain(steps: readonly ChainStep[], localOnly = false): Promise<string> {
  return sha256Hex(canonicalJson(chainHashInput(steps, localOnly)));
}

function chainHashInput(steps: readonly ChainStep[], localOnly: boolean): unknown {
  return {
    localOnly,
    steps: [...steps]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        position: s.position,
        engineClass: s.engineClass,
        modelKey: s.modelKey,
        timeoutMs: s.timeoutMs,
        minConfidence: s.minConfidence,
        maxDownloadMb: s.maxDownloadMb,
        offlineOk: s.offlineOk,
        files: [...s.files]
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map((f) => ({ name: f.name, sha256: f.sha256.toLowerCase(), bytes: f.bytes })),
      })),
  };
}

/** Server helper: add both hashes to a ticket body. The server signs the result, then stores the hashes. */
export async function sealTicket(body: TicketBody): Promise<RoutingTicket> {
  const [fieldListHash, chainHash] = await Promise.all([
    hashFieldList(body.fields),
    hashChain(body.steps, body.localOnly === true),
  ]);
  return { ...body, fieldListHash, chainHash };
}

/** The bytes a server signs and a device verifies: canonical JSON of the sealed ticket without its signature. */
export function ticketSigningPayload(
  ticket: RoutingTicket | Omit<RoutingTicket, 'signature'>,
): Uint8Array {
  const { signature: _ignored, ...rest } = ticket as RoutingTicket;
  return new TextEncoder().encode(canonicalJson(rest));
}

/**
 * A verifier over WebCrypto for a public key the host already holds (Ed25519 or ECDSA P-256 are the usual choices).
 * The signature is base64url. A malformed signature verifies false; it never throws.
 */
export function createWebCryptoTicketVerifier(
  key: CryptoKey,
  algorithm: AlgorithmIdentifier | EcdsaParams = { name: 'Ed25519' },
): TicketSignatureVerifier {
  return async (payload, signature) => {
    try {
      const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
      if (!subtle) return false;
      const sig = base64UrlDecode(signature);
      const data = new Uint8Array(new ArrayBuffer(payload.byteLength));
      data.set(payload);
      return await subtle.verify(algorithm, key, sig, data);
    } catch {
      return false;
    }
  };
}

/**
 * Structural rules for a chain, shared by the server (when an administrator saves a task) and the device:
 * positions strictly increasing, known engine classes, hosted steps only at the end, at least one hosted step unless
 * the chain is local only (then none), and no engine the shell may never use.
 */
export function checkChain(
  steps: readonly ChainStep[],
  opts: { readonly localOnly?: boolean; readonly shell?: Shell } = {},
): TicketCheck {
  if (steps.length === 0) return refuse('malformed', 'The chain has no steps.');
  let last = -Infinity;
  let hostedSeen = false;
  let hostedCount = 0;
  for (const s of steps) {
    if (!KNOWN_CLASSES.has(s.engineClass)) {
      return refuse('malformed', `Step ${String(s.position)} names an unknown engine class.`);
    }
    if (!(s.position > last)) {
      return refuse('malformed', 'Step positions must be listed in strictly increasing order.');
    }
    last = s.position;
    const hosted = HOSTED_ENGINE_CLASSES.has(s.engineClass);
    if (hosted) {
      hostedSeen = true;
      hostedCount++;
    } else if (hostedSeen) {
      return refuse(
        'hosted_not_last',
        `Local step ${String(s.position)} comes after a hosted step.`,
      );
    }
    if (opts.shell && ENGINES_NEVER_ON_SHELL[opts.shell].has(s.engineClass)) {
      return refuse(
        'engine_not_allowed_on_shell',
        `A ${opts.shell} shell may never use the ${s.engineClass} engine.`,
      );
    }
  }
  if (opts.localOnly === true) {
    if (hostedCount > 0) return refuse('malformed', 'A local-only chain has no hosted step.');
  } else if (hostedCount === 0) {
    return refuse(
      'no_hosted_end',
      'The chain does not end at a hosted step and was not set local only.',
    );
  }
  return { ok: true };
}

/**
 * Everything a device checks before it walks a ticket: shape, expiry, the field-list hash, the chain hash, the chain
 * rules, and the signature when a verifier is given. Never throws for bad input; answers with a refusal code.
 */
export async function verifyTicket(
  ticket: unknown,
  opts: TicketCheckOptions,
): Promise<TicketCheck> {
  const shape = checkShape(ticket);
  if (!shape.ok) return shape;
  const t = ticket as RoutingTicket;

  const expires = Date.parse(t.expiresAt);
  if (Number.isNaN(expires)) return refuse('malformed', 'The ticket expiry is not a date.');
  const now =
    opts.now === undefined
      ? Date.now()
      : typeof opts.now === 'number'
        ? opts.now
        : opts.now.getTime();
  if (now >= expires) return refuse('expired', 'The ticket has expired.');

  let fieldListHash: string;
  let chainHash: string;
  try {
    [fieldListHash, chainHash] = await Promise.all([
      hashFieldList(t.fields),
      hashChain(t.steps, t.localOnly === true),
    ]);
  } catch {
    return refuse('malformed', 'The ticket cannot be hashed.');
  }
  if (fieldListHash !== t.fieldListHash.toLowerCase()) {
    return refuse('field_list_hash_mismatch', 'The field list does not match its hash.');
  }
  if (chainHash !== t.chainHash.toLowerCase()) {
    return refuse('chain_hash_mismatch', 'The chain does not match its hash.');
  }

  const chain = checkChain(t.steps, { localOnly: t.localOnly === true, shell: opts.shell });
  if (!chain.ok) return chain;

  if (t.signature === undefined || t.signature === '') {
    if (opts.requireSignature) return refuse('signature_missing', 'The ticket is not signed.');
  } else if (opts.verifySignature) {
    let valid = false;
    try {
      valid = await opts.verifySignature(ticketSigningPayload(t), t.signature);
    } catch {
      valid = false;
    }
    if (!valid) return refuse('signature_invalid', 'The ticket signature does not verify.');
  } else if (opts.requireSignature) {
    return refuse('signature_missing', 'No key was given to check the ticket signature.');
  }
  return { ok: true };
}

const KNOWN_CLASSES: ReadonlySet<string> = new Set<string>(ENGINE_CLASSES);

function refuse(code: TicketRefusalCode, message: string): TicketCheck {
  return { ok: false, code, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function checkShape(v: unknown): TicketCheck {
  const bad = (what: string) => refuse('malformed', `The ticket is malformed: ${what}.`);
  if (!isRecord(v)) return bad('not an object');
  for (const k of [
    'ticketId',
    'tenantId',
    'person',
    'task',
    'expiresAt',
    'fieldListHash',
    'chainHash',
  ]) {
    if (!isString(v[k]) || v[k] === '') return bad(k);
  }
  if (!isNumber(v['policyVersion'])) return bad('policyVersion');
  const record = v['record'];
  if (!isRecord(record) || !isString(record['table']) || !isString(record['id']))
    return bad('record');
  const fields = v['fields'];
  if (!Array.isArray(fields) || !fields.every(isString)) return bad('fields');
  if (v['localOnly'] !== undefined && typeof v['localOnly'] !== 'boolean') return bad('localOnly');
  if (v['signature'] !== undefined && !isString(v['signature'])) return bad('signature');
  const steps = v['steps'];
  if (!Array.isArray(steps) || steps.length === 0) return bad('steps');
  for (const s of steps) {
    if (!isRecord(s)) return bad('step');
    if (!isNumber(s['position']) || !isString(s['engineClass']) || !isString(s['modelKey']))
      return bad('step');
    if (!KNOWN_CLASSES.has(s['engineClass']))
      return bad(`unknown engine class ${s['engineClass']}`);
    if (!isNumber(s['timeoutMs']) || s['timeoutMs'] <= 0) return bad('step timeout');
    if (!isNumber(s['minConfidence']) || s['minConfidence'] < 0 || s['minConfidence'] > 1)
      return bad('step confidence floor');
    if (!isNumber(s['maxDownloadMb']) || s['maxDownloadMb'] < 0) return bad('step download limit');
    if (typeof s['offlineOk'] !== 'boolean') return bad('step offline flag');
    const files = s['files'];
    if (!Array.isArray(files)) return bad('step files');
    for (const f of files) {
      if (!isRecord(f) || !isString(f['name']) || !isString(f['sha256']) || !isNumber(f['bytes']))
        return bad('step file');
      if (!/^[0-9a-fA-F]{64}$/.test(f['sha256'])) return bad('step file hash');
    }
  }
  return { ok: true };
}
