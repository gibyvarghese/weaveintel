/**
 * @weaveintel/encryption — VaultTransitProvider.
 *
 * Wraps tenant KEKs under a HashiCorp Vault Transit Engine key using direct
 * HTTP calls to `/v1/{mount}/encrypt/{key}` and `/v1/{mount}/decrypt/{key}`.
 * No SDK is required; the provider uses `fetch` (Node 18+).
 *
 * Tenant config: `{ address: 'https://vault:8200', mount?: 'transit',
 * keyName: 'tenant-kek', token?: '...', namespace?: '...' }`.
 *
 * Token resolution order: explicit `opts.token` -> `opts.tokenEnv` env var ->
 * `VAULT_TOKEN` env var. Missing token throws KmsUnavailableError on first use.
 */

import { hardenedFetch } from '@weaveintel/core';
import { AeadError, KmsUnavailableError } from '../errors.js';
import type { KmsProvider, WrappedKey } from '../kms.js';

export interface VaultTransitProviderOptions {
  /** Vault address, e.g. 'https://vault.example.com:8200'. */
  readonly address: string;
  /** Transit engine mount path. Default: 'transit'. */
  readonly mount?: string;
  /** Transit key name. */
  readonly keyName: string;
  /** Vault token. Falls back to `tokenEnv` then `VAULT_TOKEN`. */
  readonly token?: string;
  /** Env var name to read the token from. Default: 'VAULT_TOKEN'. */
  readonly tokenEnv?: string;
  /** Vault namespace (Enterprise). */
  readonly namespace?: string;
  /** Custom fetch implementation (testing). */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 15000. */
  readonly timeoutMs?: number;
  /**
   * Allow non-HTTPS `address`. Default `false`. HTTP is permitted only for
   * loopback (localhost / 127.0.0.1 / ::1) regardless of this flag; this
   * option is required to allow plaintext HTTP to a non-loopback host.
   */
  readonly allowInsecureHttp?: boolean;
}

interface VaultEncryptResponse {
  data?: { ciphertext?: string };
}

interface VaultDecryptResponse {
  data?: { plaintext?: string };
}

export class VaultTransitProvider implements KmsProvider {
  readonly id = 'vault';
  readonly #address: string;
  readonly #mount: string;
  readonly #keyName: string;
  readonly #explicitToken: string | null;
  readonly #tokenEnv: string;
  readonly #namespace: string | null;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: VaultTransitProviderOptions) {
    if (!opts.address) throw new KmsUnavailableError('VaultTransitProvider requires opts.address');
    if (!opts.keyName) throw new KmsUnavailableError('VaultTransitProvider requires opts.keyName');
    this.#address = opts.address.replace(/\/+$/, '');
    assertSafeVaultAddress(this.#address, opts.allowInsecureHttp === true);
    this.#mount = (opts.mount ?? 'transit').replace(/^\/+|\/+$/g, '');
    this.#keyName = opts.keyName;
    this.#explicitToken = opts.token ?? null;
    this.#tokenEnv = opts.tokenEnv ?? 'VAULT_TOKEN';
    this.#namespace = opts.namespace ?? null;
    const defaultFetch: typeof fetch = (input, init) =>
      hardenedFetch(typeof input === 'string' ? input : input.toString(), init, {
        errorTag: 'encryption-vault',
        // The provider attaches its own AbortSignal.timeout per call and
        // caps body size by reading JSON itself, so disable the outer
        // timeout / size cap. enforceHttps is delegated to
        // assertSafeVaultAddress above (which honors allowInsecureHttp).
        timeoutMs: 0,
        maxBytes: 0,
        enforceHttps: false,
      });
    this.#fetch = opts.fetchImpl ?? defaultFetch;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async rootKeyId(_tenantId: string): Promise<string> {
    return `${this.#mount}/${this.#keyName}`;
  }

  async wrap(rootKeyId: string, plaintextKey: Buffer): Promise<WrappedKey> {
    if (plaintextKey.length !== 32) {
      throw new AeadError(`plaintext key must be 32 bytes, got ${plaintextKey.length}`);
    }
    const url = `${this.#address}/v1/${this.#mount}/encrypt/${encodeURIComponent(this.#keyName)}`;
    const body = JSON.stringify({ plaintext: plaintextKey.toString('base64') });
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: 'POST',
        headers: this.#headers(),
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new KmsUnavailableError(`Vault encrypt request failed: ${(err as Error).message}`, err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new KmsUnavailableError(`Vault encrypt returned ${res.status}: ${text}`);
    }
    const json = (await res.json()) as VaultEncryptResponse;
    const ct = json?.data?.ciphertext;
    if (!ct || typeof ct !== 'string') {
      throw new KmsUnavailableError('Vault encrypt returned no ciphertext');
    }
    return {
      rootKeyId,
      alg: 'KMS-NATIVE',
      // Vault returns "vault:vN:<base64>" — store the whole envelope verbatim.
      ciphertext: Buffer.from(ct, 'utf8'),
    };
  }

  async unwrap(wrapped: WrappedKey): Promise<Buffer> {
    if (wrapped.alg !== 'KMS-NATIVE') {
      throw new AeadError(`VaultTransitProvider expected alg=KMS-NATIVE, got ${wrapped.alg}`);
    }
    const url = `${this.#address}/v1/${this.#mount}/decrypt/${encodeURIComponent(this.#keyName)}`;
    const body = JSON.stringify({ ciphertext: wrapped.ciphertext.toString('utf8') });
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: 'POST',
        headers: this.#headers(),
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new AeadError(`Vault decrypt request failed: ${(err as Error).message}`, err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AeadError(`Vault decrypt returned ${res.status}: ${text}`);
    }
    const json = (await res.json()) as VaultDecryptResponse;
    const pt = json?.data?.plaintext;
    if (!pt || typeof pt !== 'string') {
      throw new AeadError('Vault decrypt returned no plaintext');
    }
    return Buffer.from(pt, 'base64');
  }

  #headers(): Record<string, string> {
    const token = this.#resolveToken();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-vault-token': token,
    };
    if (this.#namespace) headers['x-vault-namespace'] = this.#namespace;
    return headers;
  }

  #resolveToken(): string {
    if (this.#explicitToken) return this.#explicitToken;
    const fromEnv = process.env[this.#tokenEnv];
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    throw new KmsUnavailableError(
      `VaultTransitProvider has no token (set opts.token or env ${this.#tokenEnv})`,
    );
  }
}

function assertSafeVaultAddress(address: string, allowInsecureHttp: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new KmsUnavailableError(`VaultTransitProvider: invalid address '${address}'`);
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol !== 'http:') {
    throw new KmsUnavailableError(
      `VaultTransitProvider: address must be https:// (got ${parsed.protocol}//)`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (isLoopback) return;
  if (!allowInsecureHttp) {
    throw new KmsUnavailableError(
      `VaultTransitProvider: refusing plaintext http:// to non-loopback host '${host}'. ` +
        `Use https:// or set opts.allowInsecureHttp=true (not recommended).`,
    );
  }
}
