import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createOutlookCalMCPServer, type OutlookCalAdapter, type OutlookCalEvent } from './outlook-cal.js';

const FIXTURE_EVENT: OutlookCalEvent = {
  id: 'oc-event-1', subject: 'Sprint Review', start: '2025-01-03T14:00:00Z', end: '2025-01-03T15:00:00Z',
  status: 'busy', attendees: [{ email: 'carol@example.com', name: 'Carol', response: 'accepted' }], organizer: 'dave@example.com',
};

function fixtureAdapter(): OutlookCalAdapter {
  return {
    async listEvents() { return [FIXTURE_EVENT]; },
    async createEvent() { return FIXTURE_EVENT; },
    async updateEvent() { return FIXTURE_EVENT; },
    async rsvp() { return; },
    async subscribeChanges() { return { stop: () => {} }; },
  };
}

describe('@weaveintel/tools-outlook-cal (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createOutlookCalMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    const ctx = weaveContext({ metadata: { outlookCalAccessToken: 'test-token' } });
    callTool = async (name, args) => mc.callTool(ctx, { name, arguments: args }) as unknown as Promise<{ content: Array<{ type: string; text: string }> }>;
  });

  it('exposes 5 Outlook Calendar tools', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createOutlookCalMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    expect((await mc.listTools()).length).toBe(5);
  });

  it('outlook-cal.list-events returns events', async () => {
    const result = await callTool('outlook-cal.list-events', {});
    expect(JSON.parse(result.content[0]!.text)[0].subject).toBe('Sprint Review');
  });

  it('outlook-cal.create-event returns event', async () => {
    const result = await callTool('outlook-cal.create-event', { subject: 'Demo', start: '2025-01-04T10:00:00Z', end: '2025-01-04T11:00:00Z' });
    expect(JSON.parse(result.content[0]!.text).id).toBe('oc-event-1');
  });

  it('rejects missing token', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createOutlookCalMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    await expect(mc.callTool(weaveContext({}), { name: 'outlook-cal.list-events', arguments: {} })).rejects.toThrow();
  });
});
