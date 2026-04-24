import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface OutboundNetworkPolicy {
  allowedHosts?: string[];
  blockedHosts?: string[];
  allowPrivateNetwork?: boolean;
  blockedHostnames?: string[];
}

const DEFAULT_BLOCKED_HOSTNAMES = [
  'metadata.google.internal',
  'metadata.azure.internal',
  'metadata.aws.internal',
  'instance-data',
  '169.254.169.254',
];

function matchesHostRule(host: string, rule: string): boolean {
  const normalizedRule = rule.toLowerCase().trim();
  if (!normalizedRule) return false;
  if (host === normalizedRule) return true;
  return host.endsWith(`.${normalizedRule}`);
}

function hostInRules(host: string, rules: string[]): boolean {
  return rules.some((rule) => matchesHostRule(host, rule));
}

function isPrivateIPv4(ip: string): boolean {
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  const match172 = /^172\.(\d{1,3})\./.exec(ip);
  if (!match172) return false;
  const secondOctet = Number.parseInt(match172[1] ?? '0', 10);
  return secondOctet >= 16 && secondOctet <= 31;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('::ffff:')) {
    const mappedV4 = normalized.slice('::ffff:'.length);
    if (isIP(mappedV4) === 4) return isPrivateIPv4(mappedV4);
  }
  return false;
}

export function isPrivateHostLiteral(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (normalized.endsWith('.local')) return true;
  const kind = isIP(normalized);
  if (kind === 4) return isPrivateIPv4(normalized);
  if (kind === 6) return isPrivateIPv6(normalized);
  return false;
}

export async function validateOutboundUrl(rawUrl: string, policy: OutboundNetworkPolicy = {}): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must use http or https');
  }

  const host = parsed.hostname.toLowerCase();
  const blockedHostnames = [
    ...DEFAULT_BLOCKED_HOSTNAMES,
    ...(policy.blockedHostnames ?? []),
  ];

  if (hostInRules(host, blockedHostnames)) {
    throw new Error(`Blocked outbound host: ${host}`);
  }

  const blockedHosts = policy.blockedHosts ?? [];
  if (blockedHosts.length > 0 && hostInRules(host, blockedHosts)) {
    throw new Error(`Blocked outbound host: ${host}`);
  }

  const allowedHosts = policy.allowedHosts ?? [];
  if (allowedHosts.length > 0 && !hostInRules(host, allowedHosts)) {
    throw new Error(`Outbound host is not in allow list: ${host}`);
  }

  if (policy.allowPrivateNetwork !== true) {
    if (isPrivateHostLiteral(host)) {
      throw new Error(`Private network host is not allowed: ${host}`);
    }
    try {
      const resolved = await lookup(host, { all: true });
      if (resolved.some((entry) => isPrivateHostLiteral(entry.address))) {
        throw new Error('Resolved private network address is not allowed');
      }
    } catch (error) {
      if (error instanceof Error && /ENOTFOUND|EAI_AGAIN|EAI_FAIL|ENODATA/i.test(error.message)) {
        return parsed;
      }
      throw error;
    }
  }

  return parsed;
}

export async function readResponseTextLimited(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const safeLimit = Math.max(1, maxBytes);
  const len = response.headers.get('content-length');
  if (len) {
    const size = Number.parseInt(len, 10);
    if (Number.isFinite(size) && size > safeLimit) {
      throw new Error(`Response exceeds max size of ${safeLimit} bytes`);
    }
  }

  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error('Request timed out');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > safeLimit) {
        throw new Error(`Response exceeds max size of ${safeLimit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // noop
    }
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}