import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createDropboxMCPServer, type DropboxAdapter, type DropboxEntry } from './dropbox.js';

const FIXTURE_ENTRY: DropboxEntry = { id: 'id:abc123', name: 'readme.txt', path: '/readme.txt', size: 80, isFolder: false };

function fixtureAdapter(): DropboxAdapter {
  return {
    async listFolder() { return [FIXTURE_ENTRY]; },
    async readFile() { return { entry: FIXTURE_ENTRY, content: 'hello dropbox' }; },
    async createFile() { return FIXTURE_ENTRY; },
    async updateFile() { return FIXTURE_ENTRY; },
    async shareFile() { return { url: 'https://www.dropbox.com/s/abc/readme.txt?dl=0' }; },
    async subscribeChanges() { return { stop: () => {} }; },
  };
}

describe('@weaveintel/tools-dropbox (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createDropboxMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    const ctx = weaveContext({ metadata: { dropboxAccessToken: 'test-token' } });
    callTool = async (name, args) => mc.callTool(ctx, { name, arguments: args }) as unknown as Promise<{ content: Array<{ type: string; text: string }> }>;
  });

  it('exposes 6 Dropbox tools', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createDropboxMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    expect((await mc.listTools()).length).toBe(6);
  });

  it('dropbox.list returns entries', async () => {
    const result = await callTool('dropbox.list', {});
    expect(JSON.parse(result.content[0]!.text)[0].name).toBe('readme.txt');
  });

  it('dropbox.share returns url', async () => {
    const result = await callTool('dropbox.share', { path: '/readme.txt' });
    expect(JSON.parse(result.content[0]!.text).url).toContain('dropbox.com');
  });

  it('rejects missing token', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createDropboxMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    await expect(mc.callTool(weaveContext({}), { name: 'dropbox.list', arguments: {} })).rejects.toThrow();
  });
});
