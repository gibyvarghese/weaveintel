import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createOnedriveMCPServer, type OnedriveAdapter, type OnedriveItem } from './onedrive.js';

const FIXTURE_ITEM: OnedriveItem = { id: 'item-1', name: 'notes.txt', lastModifiedDateTime: '2025-01-01T00:00:00Z', size: 50 };

function fixtureAdapter(): OnedriveAdapter {
  return {
    async listItems() { return [FIXTURE_ITEM]; },
    async readItem() { return { item: FIXTURE_ITEM, content: 'hello onedrive' }; },
    async createItem() { return FIXTURE_ITEM; },
    async updateItem() { return FIXTURE_ITEM; },
    async shareItem() { return { shareLink: 'https://1drv.ms/share' }; },
    async subscribeChanges() { return { stop: () => {} }; },
  };
}

describe('@weaveintel/tools-onedrive (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createOnedriveMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    const ctx = weaveContext({ metadata: { onedriveAccessToken: 'test-token' } });
    callTool = async (name, args) => mc.callTool(ctx, { name, arguments: args }) as unknown as Promise<{ content: Array<{ type: string; text: string }> }>;
  });

  it('exposes 6 OneDrive tools', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createOnedriveMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    expect((await mc.listTools()).length).toBe(6);
  });

  it('onedrive.list returns items', async () => {
    const result = await callTool('onedrive.list', {});
    expect(JSON.parse(result.content[0]!.text)[0].name).toBe('notes.txt');
  });

  it('onedrive.share returns link', async () => {
    const result = await callTool('onedrive.share', { itemId: 'item-1', email: 'bob@example.com' });
    expect(JSON.parse(result.content[0]!.text).shareLink).toContain('1drv.ms');
  });

  it('rejects missing token', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createOnedriveMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    await expect(mc.callTool(weaveContext({}), { name: 'onedrive.list', arguments: {} })).rejects.toThrow();
  });
});
