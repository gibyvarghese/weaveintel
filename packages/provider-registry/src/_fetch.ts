// SPDX-License-Identifier: MIT
/**
 * The one way out to the network for every adapter in this package.
 *
 * In plain terms: adapters describe a request; this file sends it. Before
 * anything is sent the address is checked. Addresses on the machine itself
 * (loopback) or on a private network are REFUSED unless an operator has
 * explicitly allowed that exact host and port for this provider.
 *
 * This is deliberately stricter than the library's default guard, which lets
 * loopback through. The guard itself (`@weaveintel/core` net-guard) is not
 * changed; this file only chooses which policy to hand it.
 */

import { createHardenedFetch, type OutboundUrlPolicy } from '@weaveintel/core';
import type { PrivateEndpointAllowance } from './types.js';

const client = createHardenedFetch({
  errorTag: 'provider-registry',
  timeoutMs: 60_000,
  maxBytes: 50 * 1024 * 1024,
  policy: { allowLoopback: false, allowPrivateNetwork: false },
});

/** The policy for a public address: nothing local, nothing private. */
const PUBLIC_ONLY: OutboundUrlPolicy = { allowLoopback: false, allowPrivateNetwork: false };

/** The port a URL will connect to (the scheme's default when none is written). */
function effectivePort(url: URL): number {
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'http:' ? 80 : 443;
}

/** Hostname as the guard sees it: lower case, no IPv6 brackets. */
function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

/**
 * Decide the guard policy for one URL.
 *
 * @returns the public-only policy, or — only when the URL's host AND port
 * exactly match an operator allowance — a policy that admits that one host,
 * with redirects refused so a permitted host cannot bounce the call elsewhere.
 */
export function policyFor(
  rawUrl: string,
  allowances: readonly PrivateEndpointAllowance[],
): { policy: OutboundUrlPolicy; redirect: RequestRedirect; allowed: boolean } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { policy: PUBLIC_ONLY, redirect: 'manual', allowed: false };
  }
  const host = bareHost(url.hostname);
  const port = effectivePort(url);
  const match = allowances.some((a) => bareHost(a.host) === host && a.port === port);
  if (!match) return { policy: PUBLIC_ONLY, redirect: 'manual', allowed: false };
  return {
    policy: { allowLoopback: true, allowPrivateNetwork: true, allowedHosts: [host] },
    redirect: 'error',
    allowed: true,
  };
}

export interface GuardedSendOptions {
  readonly allowances: readonly PrivateEndpointAllowance[];
  readonly timeoutMs?: number;
  /** True for a streaming endpoint: no outer timeout and no size cap on the body. */
  readonly streaming?: boolean;
}

/** Send one request through the guard. The only network call in this package. */
export async function guardedSend(
  url: string,
  init: RequestInit,
  opts: GuardedSendOptions,
): Promise<Response> {
  const { policy, redirect } = policyFor(url, opts.allowances);
  return client.fetch(url, init, {
    policy,
    redirect,
    ...(opts.streaming ? { timeoutMs: 0, maxBytes: 0 } : opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}
