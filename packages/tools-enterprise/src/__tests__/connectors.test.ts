/**
 * @weaveintel/tools-enterprise — Connector unit tests
 *
 * Tests JiraFullProvider, ServiceNowProvider, CanvaProvider by mocking fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JiraFullProvider } from '../connectors/jira-full.js';
import { ServiceNowProvider } from '../connectors/servicenow.js';
import { CanvaProvider } from '../connectors/canva.js';
import type { EnterpriseConnectorConfig, EnterpriseQueryOptions } from '../types.js';

/* ---------- shared test config ---------- */

function jiraConfig(overrides?: Partial<EnterpriseConnectorConfig>): EnterpriseConnectorConfig {
  return {
    name: 'jira-test',
    type: 'jira',
    enabled: true,
    baseUrl: 'https://acme.atlassian.net',
    authType: 'basic',
    authConfig: { username: 'alice@co.com', password: 'api-token' },
    ...overrides,
  };
}

function snowConfig(overrides?: Partial<EnterpriseConnectorConfig>): EnterpriseConnectorConfig {
  return {
    name: 'snow-test',
    type: 'servicenow',
    enabled: true,
    baseUrl: 'https://acme.service-now.com',
    authType: 'basic',
    authConfig: { username: 'admin', password: 'pass' },
    ...overrides,
  };
}

function canvaConfig(overrides?: Partial<EnterpriseConnectorConfig>): EnterpriseConnectorConfig {
  return {
    name: 'canva-test',
    type: 'canva',
    enabled: true,
    baseUrl: 'https://api.canva.com/rest/v1',
    authType: 'bearer',
    authConfig: { accessToken: 'canva-tok' },
    ...overrides,
  };
}

/* ---------- fetch mock ---------- */
let fetchSpy: ReturnType<typeof vi.fn>;

function mockFetch(data: unknown, status = 200) {
  fetchSpy.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
}

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════════════
// Jira Full Provider
// ═══════════════════════════════════════════════════════════════

describe('JiraFullProvider', () => {
  const jira = new JiraFullProvider();

  it('has type "jira"', () => {
    expect(jira.type).toBe('jira');
  });

  describe('query (JQL search)', () => {
    it('queries issues via JQL', async () => {
      mockFetch({
        issues: [
          { id: '1', key: 'PROJ-1', fields: { summary: 'Bug fix', status: { name: 'Open' } } },
          { id: '2', key: 'PROJ-2', fields: { summary: 'Feature', status: { name: 'Done' } } },
        ],
      });

      const results = await jira.query({ query: 'project = PROJ', limit: 10 }, jiraConfig());
      expect(results).toHaveLength(2);
      expect(results[0]!.id).toBe('PROJ-1');
      expect(results[0]!.type).toBe('issue');
      expect(results[0]!.data['summary']).toBe('Bug fix');

      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toContain('/rest/api/3/search');
      expect(url).toContain('jql=project');
    });

    it('defaults to limit 50', async () => {
      mockFetch({ issues: [] });
      await jira.query({ query: 'status = Open' }, jiraConfig());
      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toContain('maxResults=50');
    });
  });

  describe('get', () => {
    it('gets an issue by key', async () => {
      mockFetch({ id: '1', key: 'PROJ-1', fields: { summary: 'Test' } });
      const result = await jira.get('PROJ-1', jiraConfig());
      expect(result).not.toBeNull();
      expect(result!.id).toBe('PROJ-1');

      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toContain('/rest/api/3/issue/PROJ-1');
    });

    it('returns null on error', async () => {
      mockFetch({}, 404);
      const result = await jira.get('NONEXIST', jiraConfig());
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('creates an issue', async () => {
      mockFetch({ id: '10', key: 'PROJ-10' });
      const data = { summary: 'New issue', project: { key: 'PROJ' }, issuetype: { name: 'Bug' } };
      const result = await jira.create(data, jiraConfig());
      expect(result.id).toBe('PROJ-10');
      expect(result.type).toBe('issue');

      const [, fetchOpts] = fetchSpy.mock.calls[0]!;
      expect(fetchOpts.method).toBe('POST');
      const body = JSON.parse(fetchOpts.body);
      expect(body.fields.summary).toBe('New issue');
    });
  });

  describe('getTransitions', () => {
    it('lists available transitions', async () => {
      mockFetch({
        transitions: [
          { id: '11', name: 'Start Progress', to: { name: 'In Progress' } },
          { id: '21', name: 'Done', to: { name: 'Done' } },
        ],
      });
      const transitions = await jira.getTransitions('PROJ-1', jiraConfig());
      expect(transitions).toHaveLength(2);
      expect(transitions[0]!.data['name']).toBe('Start Progress');
    });
  });

  describe('getComments', () => {
    it('lists comments on an issue', async () => {
      mockFetch({
        comments: [
          { id: 'c1', body: 'Hello', author: { displayName: 'Alice' }, created: '2024-01-01' },
        ],
      });
      const comments = await jira.getComments('PROJ-1', jiraConfig());
      expect(comments).toHaveLength(1);
      expect(comments[0]!.type).toBe('comment');
    });
  });

  describe('addComment', () => {
    it('adds a comment to an issue', async () => {
      mockFetch({ id: 'new-c' });
      const result = await jira.addComment('PROJ-1', { type: 'doc', content: [] }, jiraConfig());
      expect(result.id).toBe('new-c');
      expect(result.type).toBe('comment');

      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toContain('/issue/PROJ-1/comment');
    });
  });

  describe('auth headers', () => {
    it('sends Basic auth', async () => {
      mockFetch({ issues: [] });
      await jira.query({ query: 'x' }, jiraConfig());
      const [, opts] = fetchSpy.mock.calls[0]!;
      const authHeader = opts.headers['Authorization'] ?? '';
      expect(authHeader).toContain('Basic');
    });

    it('sends Bearer auth', async () => {
      mockFetch({ issues: [] });
      await jira.query({ query: 'x' }, jiraConfig({ authType: 'bearer', authConfig: { accessToken: 'tok' } }));
      const [, opts] = fetchSpy.mock.calls[0]!;
      expect(opts.headers['Authorization']).toBe('Bearer tok');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// ServiceNow Provider
// ═══════════════════════════════════════════════════════════════

describe('ServiceNowProvider', () => {
  const snow = new ServiceNowProvider();

  it('has type "servicenow"', () => {
    expect(snow.type).toBe('servicenow');
  });

  describe('query (table API)', () => {
    it('queries the incident table by default', async () => {
      mockFetch({
        result: [
          { sys_id: 'inc-1', short_description: 'Server down', state: '1' },
          { sys_id: 'inc-2', short_description: 'Disk full', state: '2' },
        ],
      });

      const results = await snow.query({ query: 'state=1' }, snowConfig());
      expect(results).toHaveLength(2);
      expect(results[0]!.id).toBe('inc-1');
      expect(results[0]!.type).toBe('incident');

      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toContain('/api/now/table/incident');
      expect(url).toContain('sysparm_query=state');
    });

    it('queries a custom table', async () => {
      mockFetch({ result: [{ sys_id: 'cr-1' }] });
      const opts = { query: 'active=true', table: 'change_request' } as unknown as EnterpriseQueryOptions;
      const results = await snow.query(opts, snowConfig());
      expect(results).toHaveLength(1);

      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toContain('/api/now/table/change_request');
    });
  });

  describe('get', () => {
    it('gets a record by sys_id', async () => {
      mockFetch({ result: { sys_id: 'inc-1', short_description: 'Issue' } });
      const result = await snow.get('inc-1', snowConfig());
      expect(result).not.toBeNull();
      expect(result!.id).toBe('inc-1');

      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toContain('/api/now/table/incident/inc-1');
    });

    it('returns null on error', async () => {
      mockFetch({}, 404);
      const result = await snow.get('bad-id', snowConfig());
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('creates a record with __table routing', async () => {
      mockFetch({ result: { sys_id: 'new-inc', short_description: 'Created' } });
      const result = await snow.create(
        { __table: 'incident', short_description: 'New incident', urgency: '1' },
        snowConfig(),
      );
      expect(result.id).toBe('new-inc');
      expect(result.type).toBe('incident');

      const [url, opts] = fetchSpy.mock.calls[0]!;
      expect(url).toContain('/api/now/table/incident');
      const body = JSON.parse(opts.body);
      // __table should be removed from payload
      expect(body['__table']).toBeUndefined();
      expect(body['short_description']).toBe('New incident');
    });

    it('defaults to incident table', async () => {
      mockFetch({ result: { sys_id: 'x' } });
      await snow.create({ short_description: 'test' }, snowConfig());
      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toContain('/api/now/table/incident');
    });
  });

  describe('listIncidents / createIncident', () => {
    it('listIncidents delegates to query', async () => {
      mockFetch({ result: [{ sys_id: 'i1' }] });
      const results = await snow.listIncidents(snowConfig(), 'active=true', 10);
      expect(results).toHaveLength(1);
    });

    it('createIncident routes to incident table', async () => {
      mockFetch({ result: { sys_id: 'i2', short_description: 'Fire' } });
      const result = await snow.createIncident({ short_description: 'Fire' }, snowConfig());
      expect(result.type).toBe('incident');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Canva Provider
// ═══════════════════════════════════════════════════════════════

describe('CanvaProvider', () => {
  const canva = new CanvaProvider();

  it('has type "canva"', () => {
    expect(canva.type).toBe('canva');
  });

  describe('query (search designs)', () => {
    it('searches designs', async () => {
      mockFetch({
        items: [
          { id: 'd1', title: 'My Design', thumbnail: { url: 'https://...' } },
          { id: 'd2', title: 'Other Design' },
        ],
      });
      const results = await canva.query({ query: 'banner' }, canvaConfig());
      expect(results).toHaveLength(2);
      expect(results[0]!.id).toBe('d1');
      expect(results[0]!.type).toBe('design');

      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toContain('/designs?');
      expect(url).toContain('query=banner');
    });
  });

  describe('get', () => {
    it('gets a design by ID', async () => {
      mockFetch({ id: 'd1', title: 'My Design' });
      const result = await canva.get('d1', canvaConfig());
      expect(result).not.toBeNull();
      expect(result!.id).toBe('d1');
      expect(result!.source).toBe('canva');
    });

    it('returns null on error', async () => {
      mockFetch({}, 404);
      const result = await canva.get('bad', canvaConfig());
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('creates a design', async () => {
      mockFetch({ id: 'new-d', title: 'Created' });
      const result = await canva.create(
        { design_type: 'Presentation', title: 'Created' },
        canvaConfig(),
      );
      expect(result.id).toBe('new-d');
      expect(result.type).toBe('design');
    });
  });

  describe('listDesigns', () => {
    it('returns items and continuation token', async () => {
      mockFetch({
        items: [{ id: 'd1' }, { id: 'd2' }],
        continuation: 'next-page-token',
      });
      const result = await canva.listDesigns(canvaConfig(), 10);
      expect(result.items).toHaveLength(2);
      expect(result.continuation).toBe('next-page-token');
    });
  });

  describe('createExport', () => {
    it('creates a design export', async () => {
      mockFetch({ id: 'exp-1', status: 'in_progress' });
      const result = await canva.createExport('d1', 'pdf', canvaConfig());
      expect(result.id).toBe('exp-1');
      expect(result.type).toBe('export');

      const [url, opts] = fetchSpy.mock.calls[0]!;
      expect(url).toContain('/exports');
      const body = JSON.parse(opts.body);
      expect(body.design_id).toBe('d1');
      expect(body.format).toBe('pdf');
    });
  });

  describe('listAssets', () => {
    it('lists assets with pagination', async () => {
      mockFetch({
        items: [{ id: 'a1', name: 'Logo.png' }],
        continuation: 'cont-tok',
      });
      const result = await canva.listAssets(canvaConfig(), 25, 'prev-tok');
      expect(result.items).toHaveLength(1);
      expect(result.continuation).toBe('cont-tok');

      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toContain('continuation=prev-tok');
    });
  });

  describe('getUser', () => {
    it('returns user profile', async () => {
      mockFetch({ id: 'u1', display_name: 'Alice' });
      const result = await canva.getUser(canvaConfig());
      expect(result.data['display_name']).toBe('Alice');
    });
  });
});
