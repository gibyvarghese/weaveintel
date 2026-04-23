import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createGdriveMCPServer, type GdriveAdapter, type GdriveFile } from './gdrive.js';

const FIXTURE_FILE: GdriveFile = { id: 'file-1', name: 'doc.txt', mimeType: 'text/plain', modifiedTime: '2025-01-01T00:00:00Z', size: 100 };

function fixtureAdapter(): GdriveAdapter {
  return {
    async listFiles() { return [FIXTURE_FILE]; },
    async readFile() { return { file: FIXTURE_FILE, content: 'hello world' }; },
    async createFile() { return FIXTURE_FILE; },
    async updateFile() { return FIXTURE_FILE; },
    async shareFile() {},
    async subscribeChanges() { return { stop: () => {} }; },
  };
}

describe('@weaveintel/tools-gdrive (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createGdriveMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    const ctx = weaveContext({ metadata: { gdriveAccessToken: 'test-token' } });
    callTool = async (name, args) => mc.callTool(ctx, { name, arguments: args }) as unknown as Promise<{ content: Array<{ type: string; text: string }> }>;
  });

  it('exposes 6 Drive tools', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createGdriveMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    expect((await mc.listTools()).length).toBe(6);
  });

  it('gdrive.list returns files', async () => {
    const result = await callTool('gdrive.list', {});
    expect(JSON.parse(result.content[0]!.text)[0].name).toBe('doc.txt');
  });

  it('gdrive.create returns file', async () => {
    const result = await callTool('gdrive.create', { name: 'new.txt', content: 'hi' });
    expect(JSON.parse(result.content[0]!.text).id).toBe('file-1');
  });

  it('rejects missing token', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createGdriveMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    await expect(mc.callTool(weaveContext({}), { name: 'gdrive.list', arguments: {} })).rejects.toThrow();
  });
});
