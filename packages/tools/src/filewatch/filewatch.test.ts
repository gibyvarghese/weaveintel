import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createFilewatchMCPServer, type FilewatchAdapter } from './filewatch.js';

function fixtureAdapter(): FilewatchAdapter {
  return {
    async list() { return [{ path: '/tmp/a.txt', isDirectory: false, size: 4, mtimeMs: 0 }]; },
    async read() { return 'data'; },
    async write(_creds, _path, content) { return { writtenBytes: content.length }; },
    async subscribe(_creds, path) { return { subscribed: true, path }; },
  };
}

describe('@weaveintel/tools-filewatch (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createFilewatchMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    const ctx = weaveContext({ metadata: { filewatchBasePath: '/tmp' } });
    callTool = async (name, args) => mc.callTool(ctx, { name, arguments: args }) as unknown as Promise<{ content: Array<{ type: string; text: string }> }>;
  });

  it('exposes 4 filewatch tools', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createFilewatchMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    expect((await mc.listTools()).length).toBe(4);
  });

  it('filewatch.read returns text', async () => {
    const result = await callTool('filewatch.read', { path: 'a.txt' });
    expect(result.content[0]!.text).toBe('data');
  });

  it('filewatch.write returns byte count', async () => {
    const result = await callTool('filewatch.write', { path: 'a.txt', content: 'hello' });
    expect(JSON.parse(result.content[0]!.text).writtenBytes).toBe(5);
  });
});
