import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createGcalMCPServer, type GcalAdapter, type GcalEvent } from './gcal.js';

const FIXTURE_EVENT: GcalEvent = {
  id: 'event-1', summary: 'Team Standup', start: '2025-01-01T09:00:00Z', end: '2025-01-01T09:30:00Z',
  status: 'confirmed', attendees: [{ email: 'alice@example.com', responseStatus: 'accepted' }], organizer: 'bob@example.com',
};

function fixtureAdapter(): GcalAdapter {
  return {
    async listEvents() { return [FIXTURE_EVENT]; },
    async createEvent() { return FIXTURE_EVENT; },
    async updateEvent() { return FIXTURE_EVENT; },
    async rsvp() { return { ...FIXTURE_EVENT, attendees: [{ email: 'alice@example.com', responseStatus: 'accepted' }] }; },
    async subscribeChanges() { return { stop: () => {} }; },
  };
}

describe('@weaveintel/tools-gcal (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createGcalMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    const ctx = weaveContext({ metadata: { gcalAccessToken: 'test-token' } });
    callTool = async (name, args) => mc.callTool(ctx, { name, arguments: args }) as unknown as Promise<{ content: Array<{ type: string; text: string }> }>;
  });

  it('exposes 5 GCal tools', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createGcalMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    expect((await mc.listTools()).length).toBe(5);
  });

  it('gcal.list-events returns events', async () => {
    const result = await callTool('gcal.list-events', {});
    expect(JSON.parse(result.content[0]!.text)[0].summary).toBe('Team Standup');
  });

  it('gcal.create-event returns event', async () => {
    const result = await callTool('gcal.create-event', { summary: 'New Meeting', start: '2025-01-02T10:00:00Z', end: '2025-01-02T10:30:00Z' });
    expect(JSON.parse(result.content[0]!.text).id).toBe('event-1');
  });

  it('gcal.rsvp returns event', async () => {
    const result = await callTool('gcal.rsvp', { eventId: 'event-1', email: 'alice@example.com', response: 'accepted' });
    expect(JSON.parse(result.content[0]!.text).attendees[0].responseStatus).toBe('accepted');
  });

  it('rejects missing token', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createGcalMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    await expect(mc.callTool(weaveContext({}), { name: 'gcal.list-events', arguments: {} })).rejects.toThrow();
  });
});
