/**
 * @weaveintel/a2a — push notification configs through the outbound guard.
 *
 * A client asks the agent to POST task updates to a webhook URL. Without a check that URL is a request the
 * agent makes on the client's behalf to anywhere, cloud metadata and the agent's own network included. So a
 * config is checked when it is created (`validatePushNotificationConfig`, called by the dispatcher before it
 * stores anything) and again at every delivery (the name may resolve elsewhere by then):
 *
 *   - the URL parses, is at most 2048 characters, carries no user name or password;
 *   - https only (http only to loopback, and loopback only when the caller allows it, for a local test receiver);
 *   - when an allow list is given, the host matches it (an empty list allows nothing);
 *   - `@weaveintel/core`'s outbound guard: cloud metadata names refused, the name is resolved and EVERY address
 *     must be public unicast (private, loopback, link-local, CGNAT, ULA and the rest refused), a name that does
 *     not resolve is refused.
 *
 * Delivery connects to the address that was checked (core's pinned fetch) and does not follow redirects.
 */

import type { A2APushNotificationConfig, OutboundUrlPolicy } from '@weaveintel/core';
import { assertSafeOutboundUrl } from '@weaveintel/core';

export interface A2APushPolicy {
  /**
   * Hosts a webhook may be on (suffix match: `partner.example` allows `hooks.partner.example`). When given, a
   * host not on it is refused, and an empty list refuses every host. When absent, only the guard applies.
   */
  readonly allowedHosts?: readonly string[];
  /** Outbound guard settings (a resolver for tests, `allowLoopback` for a local receiver). Never the allow list. */
  readonly outbound?: Omit<OutboundUrlPolicy, 'allowedHosts' | 'errorTag'>;
}

export type A2APushConfigErrorCode = 'INVALID_CONFIG' | 'HOST_NOT_ALLOWED' | 'UNSAFE_URL';

export class A2APushConfigError extends Error {
  constructor(
    readonly code: A2APushConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'A2APushConfigError';
  }
}

export const A2A_PUSH_URL_MAX_LENGTH = 2048;

function hostMatches(host: string, rule: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const r = rule
    .toLowerCase()
    .replace(/^\*?\./, '')
    .replace(/\.$/, '');
  return r !== '' && (h === r || h.endsWith(`.${r}`));
}

/**
 * Check a push config and return it. Throws `A2APushConfigError` (code `INVALID_CONFIG`, `HOST_NOT_ALLOWED` or
 * `UNSAFE_URL`) when the URL may not receive pushes.
 */
export async function validatePushNotificationConfig(
  config: A2APushNotificationConfig,
  policy: A2APushPolicy = {},
): Promise<A2APushNotificationConfig> {
  const url = (config as { url?: unknown } | null | undefined)?.url;
  if (typeof url !== 'string' || url === '')
    throw new A2APushConfigError('INVALID_CONFIG', 'push config: url is required');
  if (url.length > A2A_PUSH_URL_MAX_LENGTH) {
    throw new A2APushConfigError(
      'INVALID_CONFIG',
      `push config: url is longer than ${A2A_PUSH_URL_MAX_LENGTH} characters`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new A2APushConfigError('INVALID_CONFIG', 'push config: url is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new A2APushConfigError(
      'INVALID_CONFIG',
      `push config: url scheme ${parsed.protocol} is not allowed`,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new A2APushConfigError(
      'INVALID_CONFIG',
      'push config: url must not carry a user name or password',
    );
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (
    policy.allowedHosts !== undefined &&
    !policy.allowedHosts.some((rule) => hostMatches(host, rule))
  ) {
    throw new A2APushConfigError(
      'HOST_NOT_ALLOWED',
      `push config: host ${host} is not on the allow list`,
    );
  }
  try {
    await assertSafeOutboundUrl(url, { ...(policy.outbound ?? {}), errorTag: 'a2a-push' });
  } catch (err) {
    throw new A2APushConfigError('UNSAFE_URL', err instanceof Error ? err.message : String(err));
  }
  return config;
}
