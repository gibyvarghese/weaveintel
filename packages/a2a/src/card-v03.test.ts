/**
 * A2A v0.3 compatibility fields on a v1.0 agent card.
 *
 * A reader that speaks v0.3 (a registration console that has not moved to v1.0) reads `protocolVersion`, `url`,
 * `preferredTransport`, `additionalInterfaces`, `supportsAuthenticatedExtendedCard`, and requires
 * `defaultInputModes`, `defaultOutputModes` and `tags` on each skill. A v1.0 reader reads `supportedInterfaces`.
 * One published card carries both.
 */

import { describe, it, expect } from 'vitest';
import type { AgentCard } from '@weaveintel/core';
import { withV03Compat, checkV03Card, A2A_V03_PROTOCOL_VERSION } from './card-v03.js';

function v1Card(over: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'Service desk agent',
    description: 'Triage incidents and report on tickets',
    version: '1.0.0',
    skills: [
      {
        id: 'triage-incident',
        name: 'Triage an incident',
        description: 'Suggest a category and priority',
      },
      {
        id: 'ticket-status',
        name: 'Status of my tickets',
        description: 'List open tickets',
        tags: ['itsm'],
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: true,
      extendedAgentCard: true,
      stateTransitionHistory: false,
    },
    supportedInterfaces: [
      {
        url: 'https://tenant-a.example.com/a2a/v1',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        tenant: 'tenant-a',
      },
      {
        url: 'https://tenant-a.example.com/a2a/grpc',
        protocolBinding: 'GRPC',
        protocolVersion: '1.0',
      },
    ],
    ...over,
  };
}

describe('[V03] withV03Compat', () => {
  it('adds the v0.3 fields from the v1.0 interfaces, JSON-RPC preferred', () => {
    const card = withV03Compat(v1Card());
    expect(card.protocolVersion).toBe(A2A_V03_PROTOCOL_VERSION);
    expect(card.url).toBe('https://tenant-a.example.com/a2a/v1');
    expect(card.preferredTransport).toBe('JSONRPC');
    expect(card.additionalInterfaces).toEqual([
      { url: 'https://tenant-a.example.com/a2a/v1', transport: 'JSONRPC' },
      { url: 'https://tenant-a.example.com/a2a/grpc', transport: 'GRPC' },
    ]);
    expect(card.supportsAuthenticatedExtendedCard).toBe(true);
    // v1.0 fields are kept as they were
    expect(card.supportedInterfaces).toHaveLength(2);
    expect(card.supportedInterfaces[0]!.tenant).toBe('tenant-a');
  });

  it('prefers JSON-RPC even when it is not listed first', () => {
    const card = withV03Compat(
      v1Card({
        supportedInterfaces: [
          { url: 'https://h.example.com/grpc', protocolBinding: 'GRPC', protocolVersion: '1.0' },
          { url: 'https://h.example.com/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        ],
      }),
    );
    expect(card.url).toBe('https://h.example.com/rpc');
    expect(card.preferredTransport).toBe('JSONRPC');
  });

  it('fills what v0.3 requires and v1.0 leaves optional (skill tags, default modes)', () => {
    const card = withV03Compat(v1Card());
    expect(card.skills[0]!.tags).toEqual([]);
    expect(card.skills[1]!.tags).toEqual(['itsm']);
    expect(card.defaultInputModes).toEqual(['text/plain']);
    expect(card.defaultOutputModes).toEqual(['text/plain']);
    const explicit = withV03Compat(
      v1Card({ defaultInputModes: ['application/json'], defaultOutputModes: ['text/markdown'] }),
    );
    expect(explicit.defaultInputModes).toEqual(['application/json']);
    expect(explicit.defaultOutputModes).toEqual(['text/markdown']);
  });

  it('passes the v0.3 reader check', () => {
    expect(checkV03Card(withV03Compat(v1Card()))).toEqual([]);
  });

  it('does not change the card it was given', () => {
    const original = v1Card();
    const before = JSON.stringify(original);
    withV03Compat(original);
    expect(JSON.stringify(original)).toBe(before);
  });

  // ── negatives ────────────────────────────────────────────────────────────────
  it('refuses a card that is already signed (fields added after signing would break the signature)', () => {
    const signed = {
      ...v1Card(),
      signatures: [{ algorithm: 'ES256', keyId: 'k', signature: 'a.b.c' }],
    };
    expect(() => withV03Compat(signed)).toThrow(/signed/);
  });

  it('refuses a card with no interface', () => {
    expect(() => withV03Compat(v1Card({ supportedInterfaces: [] }))).toThrow(/interface/);
  });

  it('refuses an interface URL that is not absolute', () => {
    expect(() =>
      withV03Compat(
        v1Card({
          supportedInterfaces: [
            { url: '/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
          ],
        }),
      ),
    ).toThrow(/absolute/);
  });
});

describe('[V03] checkV03Card (what a v0.3 reader needs)', () => {
  it('reports a v1.0-only card as missing the v0.3 fields', () => {
    const problems = checkV03Card(v1Card());
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/protocolVersion/),
        expect.stringMatching(/\burl\b/),
        expect.stringMatching(/preferredTransport/),
        expect.stringMatching(/defaultInputModes/),
        expect.stringMatching(/defaultOutputModes/),
        expect.stringMatching(/skills\[0\]\.tags/),
      ]),
    );
  });

  it('reports an unknown transport', () => {
    const card = { ...withV03Compat(v1Card()), preferredTransport: 'SOAP' };
    expect(checkV03Card(card)).toEqual([expect.stringMatching(/preferredTransport/)]);
  });

  it('reports a main url that is not among the additional interfaces', () => {
    const card = { ...withV03Compat(v1Card()), url: 'https://elsewhere.example.com/a2a' };
    expect(checkV03Card(card)).toEqual([expect.stringMatching(/additionalInterfaces/)]);
  });

  it('reports a protocol version that is not 0.3', () => {
    const card = { ...withV03Compat(v1Card()), protocolVersion: '1.0' };
    expect(checkV03Card(card)).toEqual([expect.stringMatching(/protocolVersion/)]);
  });

  it('reports a non-object', () => {
    expect(checkV03Card(null)).toEqual(['card: not an object']);
  });
});
