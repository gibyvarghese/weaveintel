// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  MCP_PROTOCOL_VERSION_2025_11_25,
  MCP_PROTOCOL_VERSION_2026_07_28,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  MCP_META_PROTOCOL_VERSION,
  negotiateMcpProtocolVersion,
} from './protocol-versions.js';

describe('negotiateMcpProtocolVersion', () => {
  it('supports 2026-07-28 beside the session-era revisions', () => {
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).toEqual(
      expect.arrayContaining(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']),
    );
  });

  it('initialize echoes a session-era version the client asks for', () => {
    expect(
      negotiateMcpProtocolVersion({ rpcMethod: 'initialize', initializeAsk: '2025-06-18' }),
    ).toEqual({ ok: true, version: '2025-06-18', era: 'session' });
  });
  it('initialize with an unknown version answers our latest session-era version', () => {
    expect(
      negotiateMcpProtocolVersion({ rpcMethod: 'initialize', initializeAsk: '1999-01-01' }),
    ).toMatchObject({ ok: true, version: MCP_PROTOCOL_VERSION_2025_11_25 });
  });
  it('initialize never negotiates 2026-07-28, which has no handshake', () => {
    expect(
      negotiateMcpProtocolVersion({ rpcMethod: 'initialize', initializeAsk: '2026-07-28' }),
    ).toMatchObject({ ok: true, version: MCP_PROTOCOL_VERSION_2025_11_25, era: 'session' });
  });

  it('a 2026-07-28 header selects the stateless era', () => {
    expect(negotiateMcpProtocolVersion({ rpcMethod: 'tools/list', header: '2026-07-28' })).toEqual({
      ok: true,
      version: MCP_PROTOCOL_VERSION_2026_07_28,
      era: 'stateless',
    });
  });
  it('a 2026-07-28 version in _meta selects the stateless era', () => {
    expect(
      negotiateMcpProtocolVersion({
        rpcMethod: 'tools/list',
        meta: { [MCP_META_PROTOCOL_VERSION]: '2026-07-28' },
      }),
    ).toMatchObject({ ok: true, era: 'stateless' });
  });
  it('a session-era header keeps the session era', () => {
    expect(negotiateMcpProtocolVersion({ rpcMethod: 'tools/list', header: '2025-11-25' })).toEqual({
      ok: true,
      version: '2025-11-25',
      era: 'session',
    });
  });
  it('no version at all is read as 2025-03-26, as the 2025 transport says', () => {
    expect(negotiateMcpProtocolVersion({ rpcMethod: 'tools/list' })).toEqual({
      ok: true,
      version: '2025-03-26',
      era: 'session',
    });
  });

  it('refuses an unknown version', () => {
    expect(
      negotiateMcpProtocolVersion({ rpcMethod: 'tools/list', header: '2030-01-01' }),
    ).toMatchObject({ ok: false });
  });
  it('refuses a header and a _meta version that disagree', () => {
    expect(
      negotiateMcpProtocolVersion({
        rpcMethod: 'tools/list',
        header: '2025-11-25',
        meta: { [MCP_META_PROTOCOL_VERSION]: '2026-07-28' },
      }),
    ).toMatchObject({ ok: false });
  });
  it('refuses a version the server switched off', () => {
    expect(
      negotiateMcpProtocolVersion({
        rpcMethod: 'tools/list',
        header: '2026-07-28',
        enabled: ['2025-11-25'],
      }),
    ).toMatchObject({ ok: false });
    expect(
      negotiateMcpProtocolVersion({
        rpcMethod: 'initialize',
        initializeAsk: '2025-11-25',
        enabled: ['2026-07-28'],
      }),
    ).toMatchObject({ ok: false });
  });
  it('server/discover is answered in the stateless era whatever the header says', () => {
    expect(negotiateMcpProtocolVersion({ rpcMethod: 'server/discover' })).toMatchObject({
      ok: true,
      era: 'stateless',
      version: '2026-07-28',
    });
  });
});
