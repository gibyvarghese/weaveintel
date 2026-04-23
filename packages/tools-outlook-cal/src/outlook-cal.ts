/**
 * @weaveintel/tools-outlook-cal — Microsoft Outlook Calendar MCP server
 * Uses Microsoft Graph API /me/calendar/events. Credentials: ctx.metadata.outlookCalAccessToken
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';

export interface OutlookCalCredentials { accessToken: string; userId?: string; refreshAccessToken?: () => Promise<string | undefined>; }
export interface OutlookCalTokenProvider {
  getToken(ctx: ExecutionContext): Promise<string | undefined>;
  refreshToken(ctx: ExecutionContext): Promise<string | undefined>;
}

export interface OutlookCalEvent {
  id: string;
  subject: string;
  body?: string;
  start: string;
  end: string;
  status: string;
  attendees: Array<{ email: string; name?: string; response: string }>;
  organizer: string;
  webLink?: string;
}

export interface OutlookCalAdapter {
  listEvents(creds: OutlookCalCredentials, start: string, end: string, top: number): Promise<OutlookCalEvent[]>;
  createEvent(creds: OutlookCalCredentials, event: Partial<OutlookCalEvent>): Promise<OutlookCalEvent>;
  updateEvent(creds: OutlookCalCredentials, eventId: string, patch: Partial<OutlookCalEvent>): Promise<OutlookCalEvent>;
  rsvp(creds: OutlookCalCredentials, eventId: string, response: 'accept' | 'decline' | 'tentativelyAccept'): Promise<void>;
  subscribeChanges(creds: OutlookCalCredentials, onEvent: (e: OutlookCalEvent) => Promise<void>): Promise<{ stop: () => void }>;
}

function createMetadataTokenProvider(): OutlookCalTokenProvider {
  return {
    async getToken(ctx) {
      return ctx.metadata?.['outlookCalAccessToken'] as string | undefined;
    },
    async refreshToken(ctx) {
      return ctx.metadata?.['outlookCalRefreshAccessToken'] as string | undefined;
    },
  };
}

async function extractCredentials(ctx: ExecutionContext, provider: OutlookCalTokenProvider): Promise<OutlookCalCredentials> {
  const token = await provider.getToken(ctx);
  if (!token) throw new Error('Outlook Calendar access token missing from ctx.metadata.outlookCalAccessToken');
  return { accessToken: token, userId: ctx.metadata?.['outlookCalUserId'] as string | undefined };
}

function graphCalBase(userId?: string) {
  const id = userId && userId !== 'me' ? `users/${encodeURIComponent(userId)}` : 'me';
  return `https://graph.microsoft.com/v1.0/${id}`;
}

async function graphFetch(
  token: string,
  url: string,
  init?: RequestInit,
  refreshToken?: () => Promise<string | undefined>,
): Promise<unknown> {
  let activeToken = token;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resp = await fetch(url, { ...init, headers: { Authorization: `Bearer ${activeToken}`, 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) } });
    if (resp.status === 401 && attempt === 0 && refreshToken) {
      const refreshed = await refreshToken();
      if (refreshed) {
        activeToken = refreshed;
        continue;
      }
    }
    if (!resp.ok) throw new Error(`Graph Calendar ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
    if (resp.status === 204) return {};
    return resp.json();
  }
  throw new Error('Graph Calendar request failed after token refresh attempt');
}

function parseEvent(raw: Record<string, unknown>): OutlookCalEvent {
  const startObj = raw['start'] as Record<string, string> | undefined;
  const endObj = raw['end'] as Record<string, string> | undefined;
  const organizer = (raw['organizer'] as Record<string, unknown> | undefined)?.['emailAddress'] as { address?: string } | undefined;
  return {
    id: raw['id'] as string,
    subject: raw['subject'] as string ?? '(no title)',
    body: (raw['body'] as Record<string, string> | undefined)?.['content'],
    start: startObj?.['dateTime'] ?? '',
    end: endObj?.['dateTime'] ?? '',
    status: raw['showAs'] as string ?? 'busy',
    attendees: ((raw['attendees'] as Array<Record<string, unknown>>) ?? []).map((a) => {
      const ea = (a['emailAddress'] as Record<string, string>) ?? {};
      const status = (a['status'] as Record<string, string>) ?? {};
      return { email: ea['address'] ?? '', name: ea['name'], response: status['response'] ?? 'none' };
    }),
    organizer: organizer?.address ?? '',
    webLink: raw['webLink'] as string | undefined,
  };
}

export const liveOutlookCalAdapter: OutlookCalAdapter = {
  async listEvents(creds, start, end, top) {
    const base = graphCalBase(creds.userId);
    const data = await graphFetch(creds.accessToken, `${base}/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=${top}`, undefined, creds.refreshAccessToken) as Record<string, unknown>;
    return ((data['value'] as Array<Record<string, unknown>>) ?? []).map(parseEvent);
  },
  async createEvent(creds, event) {
    const base = graphCalBase(creds.userId);
    const body = { subject: event.subject, body: { contentType: 'Text', content: event.body ?? '' }, start: { dateTime: event.start, timeZone: 'UTC' }, end: { dateTime: event.end, timeZone: 'UTC' }, attendees: event.attendees?.map((a) => ({ emailAddress: { address: a.email, name: a.name }, type: 'required' })) };
    const raw = await graphFetch(creds.accessToken, `${base}/events`, { method: 'POST', body: JSON.stringify(body) }, creds.refreshAccessToken) as Record<string, unknown>;
    return parseEvent(raw);
  },
  async updateEvent(creds, eventId, patch) {
    const base = graphCalBase(creds.userId);
    const body: Record<string, unknown> = {};
    if (patch.subject) body['subject'] = patch.subject;
    if (patch.start) body['start'] = { dateTime: patch.start, timeZone: 'UTC' };
    if (patch.end) body['end'] = { dateTime: patch.end, timeZone: 'UTC' };
    const raw = await graphFetch(creds.accessToken, `${base}/events/${encodeURIComponent(eventId)}`, { method: 'PATCH', body: JSON.stringify(body) }, creds.refreshAccessToken) as Record<string, unknown>;
    return parseEvent(raw);
  },
  async rsvp(creds, eventId, response) {
    const base = graphCalBase(creds.userId);
    await graphFetch(creds.accessToken, `${base}/events/${encodeURIComponent(eventId)}/${response}`, { method: 'POST', body: JSON.stringify({ sendResponse: true }) }, creds.refreshAccessToken);
  },
  async subscribeChanges() { return { stop: () => {} }; },
};

export interface OutlookCalMCPServerOptions { adapter?: OutlookCalAdapter; tokenProvider?: OutlookCalTokenProvider; }

export function createOutlookCalMCPServer(opts: OutlookCalMCPServerOptions = {}) {
  const adapter = opts.adapter ?? liveOutlookCalAdapter;
  const tokenProvider = opts.tokenProvider ?? createMetadataTokenProvider();
  const server = weaveMCPServer(
    { name: 'outlook-cal', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  describeT('outlook-cal.list-events', 'List Outlook Calendar events', 'read-only');
  describeT('outlook-cal.create-event', 'Create an Outlook Calendar event', 'write');
  describeT('outlook-cal.update-event', 'Update an Outlook Calendar event', 'write');
  describeT('outlook-cal.rsvp', 'RSVP to an Outlook Calendar event', 'write');
  describeT('outlook-cal.subscribe', 'Subscribe to Outlook Calendar changes', 'read-only');

  server.addTool({ name: 'outlook-cal.list-events', description: 'List Outlook Calendar events in a time range.', inputSchema: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' }, top: { type: 'number', default: 20 } } } }, async (ctx, args) => {
    const creds = await extractCredentials(ctx, tokenProvider);
    creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 7 * 86400_000).toISOString();
    const events = await adapter.listEvents(creds, String(args['start'] ?? now), String(args['end'] ?? future), Number(args['top'] ?? 20));
    return { content: [{ type: 'text', text: JSON.stringify(events) }] };
  });

  server.addTool({ name: 'outlook-cal.create-event', description: 'Create a new Outlook Calendar event.', inputSchema: { type: 'object', properties: { subject: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, body: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } } }, required: ['subject', 'start', 'end'] } }, async (ctx, args) => {
    const creds = await extractCredentials(ctx, tokenProvider);
    creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
    const attendees = (args['attendees'] as string[] | undefined)?.map((email) => ({ email, response: 'none' as const }));
    const event = await adapter.createEvent(creds, { subject: String(args['subject']), start: String(args['start']), end: String(args['end']), body: args['body'] as string | undefined, attendees });
    return { content: [{ type: 'text', text: JSON.stringify(event) }] };
  });

  server.addTool({ name: 'outlook-cal.update-event', description: 'Update an Outlook Calendar event.', inputSchema: { type: 'object', properties: { eventId: { type: 'string' }, subject: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } }, required: ['eventId'] } }, async (ctx, args) => {
    const creds = await extractCredentials(ctx, tokenProvider);
    creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
    const event = await adapter.updateEvent(creds, String(args['eventId']), { subject: args['subject'] as string, start: args['start'] as string, end: args['end'] as string });
    return { content: [{ type: 'text', text: JSON.stringify(event) }] };
  });

  server.addTool({ name: 'outlook-cal.rsvp', description: 'RSVP to an Outlook Calendar event.', inputSchema: { type: 'object', properties: { eventId: { type: 'string' }, response: { type: 'string', enum: ['accept', 'decline', 'tentativelyAccept'] } }, required: ['eventId', 'response'] } }, async (ctx, args) => {
    const creds = await extractCredentials(ctx, tokenProvider);
    creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
    await adapter.rsvp(creds, String(args['eventId']), args['response'] as 'accept' | 'decline' | 'tentativelyAccept');
    return { content: [{ type: 'text', text: 'RSVP sent.' }] };
  });

  server.addTool({ name: 'outlook-cal.subscribe', description: 'Subscribe to Outlook Calendar changes.', inputSchema: { type: 'object', properties: {} } }, async (ctx) => {
    await extractCredentials(ctx, tokenProvider);
    return { content: [{ type: 'text', text: JSON.stringify({ subscribed: true }) }] };
  });

  return server;
}
