// SPDX-License-Identifier: MIT
/**
 * Keeps secret values out of anything that leaves the registry.
 *
 * In plain terms: a provider's error text sometimes repeats the key it was
 * sent. Before an error, a log line or a trace event is handed to the caller,
 * every secret value used during that call is replaced with a fixed marker.
 */

import { WeaveIntelError } from '@weaveintel/core';

const MARKER = '[secret removed]';

/** The set of values that must never appear in output for one call. */
export class SecretScrubber {
  readonly #values = new Set<string>();

  /** Remember a value (and the forms it commonly travels in). */
  add(value: string | undefined): void {
    if (!value || value.length < 4) return;
    this.#values.add(value);
    this.#values.add(encodeURIComponent(value));
    this.#values.add(Buffer.from(value, 'utf8').toString('base64'));
    // A multi-line secret (a service-account file) is also protected line by
    // line, so a fragment such as the private key block cannot slip through.
    if (value.includes('\n') || value.includes('\\n') || value.length > 200 || value.trimStart().startsWith('{')) {
      for (const line of value.split(/\r?\n|\\n/)) {
        if (line.trim().length >= 16) this.#values.add(line.trim());
      }
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        for (const v of Object.values(parsed)) {
          // Addresses in the file (token and certificate URLs) are not secret and are useful in an error.
          if (typeof v === 'string' && v.length >= 16 && !/^https?:\/\//.test(v)) {
            this.#values.add(v);
            for (const line of v.split(/\r?\n/)) if (line.trim().length >= 16) this.#values.add(line.trim());
          }
        }
      } catch {
        /* not JSON: the whole-value and per-line entries above are enough */
      }
    }
  }

  /** Replace every remembered value in a string. */
  text(input: string): string {
    let out = input;
    for (const v of this.#values) {
      if (out.includes(v)) out = out.split(v).join(MARKER);
    }
    return out;
  }

  /** Replace every remembered value anywhere inside a JSON-like value. */
  deep(input: unknown, depth = 0): unknown {
    if (depth > 8) return undefined;
    if (typeof input === 'string') return this.text(input);
    if (Array.isArray(input)) return input.map((v) => this.deep(v, depth + 1));
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[this.text(k)] = this.deep(v, depth + 1);
      return out;
    }
    return input;
  }

  /**
   * Turn anything thrown into a `WeaveIntelError` with every secret removed
   * from its message and details. The original is NOT kept as `cause`, because
   * a cause is printed by loggers and may still carry the value.
   */
  error(err: unknown, provider: string): WeaveIntelError {
    if (err instanceof WeaveIntelError) {
      return new WeaveIntelError({
        code: err.code,
        message: this.text(err.message),
        provider: err.provider ?? provider,
        retryable: err.retryable,
        ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
        ...(err.details !== undefined ? { details: this.deep(err.details) as Record<string, unknown> } : {}),
      });
    }
    const e = err as { name?: string; message?: string; code?: string } | undefined;
    const message = this.text(typeof e?.message === 'string' ? e.message : String(err));
    const aborted = e?.name === 'AbortError' || e?.name === 'TimeoutError' || /timed? ?out|aborted/i.test(message);
    return new WeaveIntelError({
      code: aborted ? 'TIMEOUT' : 'PROVIDER_ERROR',
      message,
      provider,
      retryable: true,
    });
  }
}
