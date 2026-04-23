/**
 * @weaveintel/tools-gcal — Google Calendar MCP server
 * Uses Google Calendar API v3. Credentials: ctx.metadata.gcalAccessToken
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';

export interface GcalCredentials { accessToken: string; calendarId?: string; }

export interface GcalEvent {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  status: string;
  attendees: Array<{ email: string; responseStatus: string }>;
  organizer: string;
  htmlLink?: string;
}

export interface GcalAdapter {
  listEvents(creds: GcalCredentials, timeMin: string, timeMax: string, maxResults: number): Promise<GcalEvent[]>;
  createEvent(creds: GcalCredentials, event: Partial<GcalEvent>): Promise<GcalEvent>;
  updateEvent(creds: GcalCredentials, eventId: string, patch: Partial<GcalEvent>): Promise<GcalEvent>;
  rsvp(creds: GcalCredentials, eventId: string, email: string, response: string): Promise<GcalEvent>;
  subscribeChanges(creds: GcalCredentials, onEvent: (e: GcalEvent) => Promise<void>): Promise<{ stop: () => void }>;
}

function extractCredentials(ctx: ExecutionContext): GcalCredentials {
  const token = ctx.metadata?.['gcalAccessToken'] as string | undefined;
  if (!token) throw new Error('Google Calendar access token missing from ctx.metadata.gcalAccessToken');
  return { accessToken: token, calendarId: (ctx.metadata?.['gcalCalendarId'] as string) ?? 'primary' };
}

const GCAL_BASE = 'https://www.googleapis.com/calendar/v3';

async function calFetch(token: string, url: string, init?: RequestInit): Promise<unknown> {
  const resp = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) } });
  if (!resp.ok) throw new Error(`Calendar API ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
  if (resp.status === 204) return {};
  return resp.json();
}

function parseEvent(raw: Record<string, unknown>): GcalEvent {
  const startObj = raw['start'] as Record<string, string> | undefined;
  const endObj = raw['end'] as Record<string, string> | undefined;
  const organizer = (raw['organizer'] as Record<string, string> | undefined)?.['email'] ?? '';
  return {
    id: raw['id'] as string,
    summary: raw['summary'] as string ?? '(no title)',
    description: raw['description'] as string | undefined,
    start: startObj?.['dateTime'] ?? startObj?.['date'] ?? '',
    end: endObj?.['dateTime'] ?? endObj?.['date'] ?? '',
    status: raw['status'] as string ?? 'confirmed',
    attendees: ((raw['attendees'] as Array<Record<string, string>>) ?? []).map((a) => ({ email: a['email'] ?? '', responseStatus: a['responseStatus'] ?? 'needsAction' })),
    organizer,
    htmlLink: raw['htmlLink'] as string | undefined,
  };
}

export const liveGcalAdapter: GcalAdapter = {
  async listEvents(creds, timeMin, timeMax, maxResults) {
    const calId = encodeURIComponent(creds.calendarId ?? 'primary');
    const data = await calFetch(creds.accessToken, `${GCAL_BASE}/calendars/${calId}/events?timeMin=${timeMin}&timeMax=${timeMax}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`) as Record<string, unknown>;
    return ((data['items'] as Array<Record<string, unknown>>) ?? []).map(parseEvent);
  },
  async createEvent(creds, event) {
    const calId = encodeURIComponent(creds.calendarId ?? 'primary');
    const body = { summary: event.summary, description: event.description, start: { dateTime: event.start }, end: { dateTime: event.end }, attendees: event.attendees?.map((a) => ({ email: a.email })) };
    const raw = await calFetch(creds.accessToken, `${GCAL_BASE}/calendars/${calId}/events`, { method: 'POST', body: JSON.stringify(body) }) as Record<string, unknown>;
    return parseEvent(raw);
  },
  async updateEvent(creds, eventId, patch) {
    const calId = encodeURIComponent(creds.calendarId ?? 'primary');
    const raw = await calFetch(creds.accessToken, `${GCAL_BASE}/calendars/${calId}/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', body: JSON.stringify(patch) }) as Record<string, unknown>;
    return parseEvent(raw);
  },
  async rsvp(creds, eventId, email, response) {
    const calId = encodeURIComponent(creds.calendarId ?? 'primary');
    const raw = await calFetch(creds.accessToken, `${GCAL_BASE}/calendars/${calId}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: 'PATCH', body: JSON.stringify({ attendees: [{ email, responseStatus: response }] }) }) as Record<string, unknown>;
    return parseEvent(raw);
  },
  async subscribeChanges() { return { stop: () => {} }; },
};

export interface GcalMCPServerOptions { adapter?: GcalAdapter; }

export function createGcalMCPServer(opts: GcalMCPServerOptions = {}) {
  const adapter = opts.adapter ?? liveGcalAdapter;
  const server = weaveMCPServer(
    { name: 'gcal', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  describeT('gcal.list-events', 'List Google Calendar events', 'read-only');
  describeT('gcal.create-event', 'Create a Google Calendar event', 'write');
  describeT('gcal.update-event', 'Update a Google Calendar event', 'write');
  describeT('gcal.rsvp', 'RSVP to a Google Calendar event', 'write');
  describeT('gcal.subscribe', 'Subscribe to Google Calendar changes', 'read-only');

  server.addTool({ name: 'gcal.list-events', description: 'List calendar events within a time range.', inputSchema: { type: 'object', properties: { timeMin: { type: 'string' }, timeMax: { type: 'string' }, maxResults: { type: 'number', default: 20 } } } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 7 * 86400_000).toISOString();
    const events = await adapter.listEvents(creds, String(args['timeMin'] ?? now), String(args['timeMax'] ?? future), Number(args['maxResults'] ?? 20));
    return { content: [{ type: 'text', text: JSON.stringify(events) }] };
  });

  server.addTool({ name: 'gcal.create-event', description: 'Create a new calendar event.', inputSchema: { type: 'object', properties: { summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, description: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'start', 'end'] } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    const attendees = (args['attendees'] as string[] | undefined)?.map((email) => ({ email, responseStatus: 'needsAction' as const }));
    const event = await adapter.createEvent(creds, { summary: String(args['summary']), start: String(args['start']), end: String(args['end']), description: args['description'] as string | undefined, attendees });
    return { content: [{ type: 'text', text: JSON.stringify(event) }] };
  });

  server.addTool({ name: 'gcal.update-event', description: 'Update an existing calendar event.', inputSchema: { type: 'object', properties: { eventId: { type: 'string' }, summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } }, required: ['eventId'] } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    const event = await adapter.updateEvent(creds, String(args['eventId']), { summary: args['summary'] as string, start: args['start'] as string, end: args['end'] as string });
    return { content: [{ type: 'text', text: JSON.stringify(event) }] };
  });

  server.addTool({ name: 'gcal.rsvp', description: 'RSVP to a calendar event.', inputSchema: { type: 'object', properties: { eventId: { type: 'string' }, email: { type: 'string' }, response: { type: 'string', enum: ['accepted', 'declined', 'tentative'] } }, required: ['eventId', 'email', 'response'] } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    const event = await adapter.rsvp(creds, String(args['eventId']), String(args['email']), String(args['response']));
    return { content: [{ type: 'text', text: JSON.stringify(event) }] };
  });

  server.addTool({ name: 'gcal.subscribe', description: 'Subscribe to calendar change notifications.', inputSchema: { type: 'object', properties: {} } }, async (ctx) => {
    extractCredentials(ctx);
    return { content: [{ type: 'text', text: JSON.stringify({ subscribed: true }) }] };
  });

  return server;
}
