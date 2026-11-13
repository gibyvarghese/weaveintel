/**
 * @weaveintel/a2a — A2A v0.3 compatibility fields on a v1.0 agent card.
 *
 * A v1.0 card lists its endpoints in `supportedInterfaces` (each with a `protocolBinding`). A v0.3 reader looks
 * for a single `url` with a `preferredTransport`, the rest in `additionalInterfaces` (each with a `transport`),
 * a `protocolVersion`, `supportsAuthenticatedExtendedCard`, and it requires `defaultInputModes`,
 * `defaultOutputModes` and `tags` on every skill. Registration consoles that still read v0.3 cards need those
 * fields, so a published card carries both shapes: `withV03Compat` adds the v0.3 fields to a v1.0 card and
 * changes none of the v1.0 ones.
 *
 * Add the fields BEFORE signing: a signature covers every field of the card, so adding fields afterwards breaks
 * it. `withV03Compat` refuses a card that already carries signatures.
 *
 * Field names and rules follow the A2A v0.3.0 AgentCard as this package's authors know it; the specification
 * text was not available offline when this was written (see the package README, "v0.3 compatibility").
 */

import type { AgentCard, AgentSkill } from '@weaveintel/core';

export const A2A_V03_PROTOCOL_VERSION = '0.3.0';

/** v0.3 transport names. `HTTP+JSON` is v0.3's REST binding. */
export type A2AV03Transport = 'JSONRPC' | 'GRPC' | 'HTTP+JSON';

const V03_TRANSPORTS: ReadonlySet<string> = new Set<A2AV03Transport>([
  'JSONRPC',
  'GRPC',
  'HTTP+JSON',
]);

/** A v0.3 `AgentInterface`: a URL and the transport it speaks. */
export interface AgentInterfaceV03 {
  readonly url: string;
  readonly transport: A2AV03Transport;
}

/** The fields a v0.3 reader needs and a v1.0 card does not carry (or carries as optional). */
export interface AgentCardV03Fields {
  readonly protocolVersion: string;
  readonly url: string;
  readonly preferredTransport: A2AV03Transport;
  readonly additionalInterfaces: readonly AgentInterfaceV03[];
  readonly supportsAuthenticatedExtendedCard: boolean;
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
}

/** A card both a v1.0 and a v0.3 reader can read. Every skill carries `tags`. */
export type DualVersionAgentCard = Omit<
  AgentCard,
  'url' | 'defaultInputModes' | 'defaultOutputModes' | 'skills'
> &
  AgentCardV03Fields & {
    readonly skills: readonly (AgentSkill & { readonly tags: readonly string[] })[];
  };

export interface WithV03CompatOptions {
  /** Modes used when the card names none. Default `['text/plain']`. */
  readonly defaultModes?: readonly string[];
}

function absoluteUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Return a copy of `card` with the v0.3 fields added. JSON-RPC is the preferred transport when the card offers
 * it (otherwise the first interface); `additionalInterfaces` lists every interface, the preferred one included.
 *
 * Throws when the card is already signed, has no interface, or names an interface URL that is not absolute.
 */
export function withV03Compat(
  card: AgentCard,
  opts: WithV03CompatOptions = {},
): DualVersionAgentCard {
  if (Array.isArray(card.signatures) && card.signatures.length > 0) {
    throw new Error(
      'withV03Compat: the card is already signed; add the v0.3 fields before signing',
    );
  }
  const interfaces = card.supportedInterfaces ?? [];
  if (interfaces.length === 0) {
    throw new Error('withV03Compat: the card has no interface (supportedInterfaces is empty)');
  }
  for (const i of interfaces) {
    if (!absoluteUrl(i.url))
      throw new Error(
        `withV03Compat: interface URL is not an absolute http(s) URL: ${String(i.url)}`,
      );
  }
  const preferred = interfaces.find((i) => i.protocolBinding === 'JSONRPC') ?? interfaces[0]!;
  const defaultModes = opts.defaultModes ?? ['text/plain'];

  return {
    ...card,
    skills: card.skills.map((s) => ({ ...s, tags: s.tags ?? [] })),
    defaultInputModes: card.defaultInputModes ?? defaultModes,
    defaultOutputModes: card.defaultOutputModes ?? defaultModes,
    protocolVersion: A2A_V03_PROTOCOL_VERSION,
    url: preferred.url,
    preferredTransport: preferred.protocolBinding,
    additionalInterfaces: interfaces.map((i) => ({ url: i.url, transport: i.protocolBinding })),
    supportsAuthenticatedExtendedCard: card.capabilities.extendedAgentCard === true,
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * What a v0.3 reader would miss in `card`: an empty list means the v0.3 fields are all there and consistent.
 * Each entry names the field. Used by a host's test that the card it publishes is readable by v0.3 consoles.
 */
export function checkV03Card(card: unknown): readonly string[] {
  if (card === null || typeof card !== 'object' || Array.isArray(card))
    return ['card: not an object'];
  const c = card as Record<string, unknown>;
  const problems: string[] = [];

  if (typeof c['protocolVersion'] !== 'string') problems.push('protocolVersion: missing');
  else if (!c['protocolVersion'].startsWith('0.3'))
    problems.push(`protocolVersion: "${c['protocolVersion']}" is not 0.3`);

  for (const f of ['name', 'description', 'version'] as const) {
    if (typeof c[f] !== 'string' || c[f] === '') problems.push(`${f}: missing`);
  }

  if (!absoluteUrl(c['url'])) problems.push('url: missing or not an absolute http(s) URL');

  const transport = c['preferredTransport'];
  if (typeof transport !== 'string') problems.push('preferredTransport: missing');
  else if (!V03_TRANSPORTS.has(transport))
    problems.push(`preferredTransport: "${transport}" is not a v0.3 transport`);

  const additional = c['additionalInterfaces'];
  if (additional !== undefined) {
    if (!Array.isArray(additional)) problems.push('additionalInterfaces: not a list');
    else {
      additional.forEach((a: unknown, i) => {
        const ai = a as Record<string, unknown> | null;
        if (
          !ai ||
          !absoluteUrl(ai['url']) ||
          typeof ai['transport'] !== 'string' ||
          !V03_TRANSPORTS.has(ai['transport'])
        ) {
          problems.push(`additionalInterfaces[${i}]: needs an absolute url and a v0.3 transport`);
        }
      });
      const listsMain = additional.some((a: unknown) => {
        const ai = a as Record<string, unknown> | null;
        return ai?.['url'] === c['url'] && ai?.['transport'] === transport;
      });
      if (
        absoluteUrl(c['url']) &&
        typeof transport === 'string' &&
        V03_TRANSPORTS.has(transport) &&
        !listsMain
      ) {
        problems.push(
          'additionalInterfaces: does not list the main url with the preferred transport',
        );
      }
    }
  }

  if (c['capabilities'] === null || typeof c['capabilities'] !== 'object')
    problems.push('capabilities: missing');
  if (!isStringArray(c['defaultInputModes']) || c['defaultInputModes'].length === 0)
    problems.push('defaultInputModes: missing');
  if (!isStringArray(c['defaultOutputModes']) || c['defaultOutputModes'].length === 0)
    problems.push('defaultOutputModes: missing');
  if (
    c['supportsAuthenticatedExtendedCard'] !== undefined &&
    typeof c['supportsAuthenticatedExtendedCard'] !== 'boolean'
  ) {
    problems.push('supportsAuthenticatedExtendedCard: not a boolean');
  }

  if (!Array.isArray(c['skills'])) problems.push('skills: missing');
  else {
    c['skills'].forEach((s: unknown, i) => {
      const sk = s as Record<string, unknown> | null;
      if (!sk || typeof sk !== 'object') {
        problems.push(`skills[${i}]: not an object`);
        return;
      }
      for (const f of ['id', 'name', 'description'] as const) {
        if (typeof sk[f] !== 'string' || sk[f] === '') problems.push(`skills[${i}].${f}: missing`);
      }
      if (!isStringArray(sk['tags'])) problems.push(`skills[${i}].tags: missing`);
    });
  }

  return problems;
}
