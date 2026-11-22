/**
 * @weaveintel/connect — the shared words of the connector framework.
 *
 * Why: a connector is data (operations, mappings, credential kinds) run by a small amount of generic code. Every part
 * of that code — credential appliers, the operation runner, inbound verifiers, the replay kit — speaks these types,
 * so a host can wire them to its own door, store and tables without any part knowing about the others.
 *
 * The network is ALWAYS the caller's: nothing in this package opens a socket or calls `fetch`. A host passes a
 * {@link Send} that goes through its own outbound door (address rules, log line before anything leaves, redirect
 * checks). That keeps one way out per host.
 */

/** A JSON value. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json }

/** One request as it will leave. Header names are lower case. */
export interface WireRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string | undefined
}

/** How a request ended, as the caller's door reports it. Never throws: a refusal is an answer. */
export type SendResult =
  | { readonly ok: true; readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string; readonly callRef?: string | undefined }
  | {
      readonly ok: false
      /** `refused`: nothing left. `timeout` / `unreachable`: it may have reached the other side. `too_large`: it did. */
      readonly kind: 'refused' | 'timeout' | 'unreachable' | 'too_large'
      /** The door's own code, for logs. */
      readonly code: string
      /** The door's plain sentence, safe to show. */
      readonly sentence: string
      readonly callRef?: string | undefined
    }

/** The one way out, supplied by the host. */
export type Send = (request: WireRequest) => Promise<SendResult>

/**
 * The normalised result of one call. A model, a flow or a person sees the outcome and a platform sentence; the
 * vendor's own error text goes to the log only.
 */
export const OUTCOMES = ['ok', 'not_found', 'conflict', 'invalid', 'forbidden', 'throttled', 'unavailable', 'unknown', 'refused'] as const
/** One outcome. */
export type Outcome = (typeof OUTCOMES)[number]

/** Whether a value is one of the outcomes. */
export function isOutcome(v: unknown): v is Outcome {
  return (OUTCOMES as readonly unknown[]).includes(v)
}

/**
 * The outcome an answer code means when an operation declares nothing more specific.
 * @param status The answer's status code.
 */
export function outcomeForStatus(status: number): Outcome {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 404 || status === 410) return 'not_found'
  if (status === 409 || status === 412) return 'conflict'
  if (status === 401 || status === 403) return 'forbidden'
  if (status === 429) return 'throttled'
  if (status >= 500) return 'unavailable'
  return 'invalid'
}

/** A refusal made before anything left, with a plain sentence. */
export interface ConnectRefusal {
  readonly ok: false
  readonly code: string
  readonly sentence: string
}

/** Make a refusal. */
export function refusal(code: string, sentence: string): ConnectRefusal {
  return { ok: false, code, sentence }
}
