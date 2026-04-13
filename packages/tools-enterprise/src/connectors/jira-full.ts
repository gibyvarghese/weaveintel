/**
 * Jira Cloud REST API v3 — Full connector
 *
 * Covers: Issues (CRUD, transitions, comments, attachments, watchers, worklogs),
 * Projects, Boards, Sprints, Users, Search (JQL), Fields, Priorities, Statuses.
 *
 * Base URL pattern: https://{domain}.atlassian.net/rest/api/3/
 * Auth: Basic (email:api-token), OAuth 2.0, Bearer
 *
 * @see https://developer.atlassian.com/cloud/jira/platform/rest/v3/
 */
import { BaseEnterpriseProvider } from '../base.js';
import type { EnterpriseConnectorConfig, EnterpriseRecord, EnterpriseQueryOptions } from '../types.js';

/* ---------- internal helpers ---------- */

function api(config: EnterpriseConnectorConfig, path: string): string {
  return `${config.baseUrl}/rest/api/3${path}`;
}

function agile(config: EnterpriseConnectorConfig, path: string): string {
  return `${config.baseUrl}/rest/agile/1.0${path}`;
}

function toRecord(source: string, type: string, data: Record<string, unknown>, id?: string): EnterpriseRecord {
  return { id: String(id ?? data['key'] ?? data['id'] ?? ''), type, source, data };
}

export class JiraFullProvider extends BaseEnterpriseProvider {
  readonly type = 'jira';

  /* ===== Issue Search (JQL) ===== */

  async query(options: EnterpriseQueryOptions, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const jql = options.query;
    const params = new URLSearchParams({ jql, maxResults: String(options.limit ?? 50) });
    const data = await this.fetchJSON<{
      issues?: Array<{ id: string; key: string; fields: Record<string, unknown> }>;
    }>(api(config, `/search?${params}`), this.authHeaders(config));
    return (data.issues ?? []).map(i => toRecord('jira', 'issue', { key: i.key, ...i.fields }, i.key));
  }

  /* ===== Issues ===== */

  async get(id: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    try {
      const d = await this.fetchJSON<{ id: string; key: string; fields: Record<string, unknown> }>(
        api(config, `/issue/${id}?expand=renderedFields,transitions`), this.authHeaders(config));
      return toRecord('jira', 'issue', { key: d.key, ...d.fields }, d.key);
    } catch { return null; }
  }

  async create(data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const r = await this.fetchJSON<{ id: string; key: string }>(
      api(config, '/issue'), this.authHeaders(config), JSON.stringify({ fields: data }));
    return toRecord('jira', 'issue', { key: r.key, ...data }, r.key);
  }

  async updateIssue(id: string, fields: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<void> {
    await this.fetchWithMethod('PUT', api(config, `/issue/${id}`), this.authHeaders(config), JSON.stringify({ fields }));
  }

  async deleteIssue(id: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.fetchWithMethod('DELETE', api(config, `/issue/${id}`), this.authHeaders(config));
  }

  /* ===== Transitions ===== */

  async getTransitions(issueId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ transitions: Array<{ id: string; name: string; to: Record<string, unknown> }> }>(
      api(config, `/issue/${issueId}/transitions`), this.authHeaders(config));
    return d.transitions.map(t => toRecord('jira', 'transition', { ...t }, t.id));
  }

  async transitionIssue(issueId: string, transitionId: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.fetchJSON(api(config, `/issue/${issueId}/transitions`), this.authHeaders(config),
      JSON.stringify({ transition: { id: transitionId } }));
  }

  /* ===== Comments ===== */

  async getComments(issueId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ comments: Array<{ id: string; body: unknown; author: Record<string, unknown>; created: string }> }>(
      api(config, `/issue/${issueId}/comment`), this.authHeaders(config));
    return d.comments.map(c => toRecord('jira', 'comment', { ...c }, c.id));
  }

  async addComment(issueId: string, body: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const c = await this.fetchJSON<{ id: string }>(
      api(config, `/issue/${issueId}/comment`), this.authHeaders(config), JSON.stringify({ body }));
    return toRecord('jira', 'comment', { ...body }, c.id);
  }

  async updateComment(issueId: string, commentId: string, body: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<void> {
    await this.fetchWithMethod('PUT', api(config, `/issue/${issueId}/comment/${commentId}`), this.authHeaders(config), JSON.stringify({ body }));
  }

  async deleteComment(issueId: string, commentId: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.fetchWithMethod('DELETE', api(config, `/issue/${issueId}/comment/${commentId}`), this.authHeaders(config));
  }

  /* ===== Watchers ===== */

  async getWatchers(issueId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ watchers: Array<{ accountId: string; displayName: string }> }>(
      api(config, `/issue/${issueId}/watchers`), this.authHeaders(config));
    return d.watchers.map(w => toRecord('jira', 'watcher', { ...w }, w.accountId));
  }

  async addWatcher(issueId: string, accountId: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.fetchJSON(api(config, `/issue/${issueId}/watchers`), this.authHeaders(config), JSON.stringify(accountId));
  }

  async removeWatcher(issueId: string, accountId: string, config: EnterpriseConnectorConfig): Promise<void> {
    await this.fetchWithMethod('DELETE', api(config, `/issue/${issueId}/watchers?accountId=${accountId}`), this.authHeaders(config));
  }

  /* ===== Worklogs ===== */

  async getWorklogs(issueId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ worklogs: Array<{ id: string; timeSpent: string; author: Record<string, unknown>; started: string }> }>(
      api(config, `/issue/${issueId}/worklog`), this.authHeaders(config));
    return d.worklogs.map(w => toRecord('jira', 'worklog', { ...w }, w.id));
  }

  async addWorklog(issueId: string, data: Record<string, unknown>, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const r = await this.fetchJSON<{ id: string }>(
      api(config, `/issue/${issueId}/worklog`), this.authHeaders(config), JSON.stringify(data));
    return toRecord('jira', 'worklog', data, r.id);
  }

  /* ===== Attachments ===== */

  async getAttachments(issueId: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const issue = await this.fetchJSON<{ fields: { attachment: Array<{ id: string; filename: string; content: string; size: number }> } }>(
      api(config, `/issue/${issueId}?fields=attachment`), this.authHeaders(config));
    return (issue.fields?.attachment ?? []).map(a => toRecord('jira', 'attachment', { ...a }, a.id));
  }

  /* ===== Projects ===== */

  async listProjects(config: EnterpriseConnectorConfig, limit = 50): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ values: Array<{ id: string; key: string; name: string; projectTypeKey: string }> }>(
      api(config, `/project/search?maxResults=${limit}`), this.authHeaders(config));
    return d.values.map(p => toRecord('jira', 'project', { ...p }, p.key));
  }

  async getProject(key: string, config: EnterpriseConnectorConfig): Promise<EnterpriseRecord | null> {
    try {
      const d = await this.fetchJSON<{ id: string; key: string; name: string; description: string }>(
        api(config, `/project/${key}`), this.authHeaders(config));
      return toRecord('jira', 'project', { ...d }, d.key);
    } catch { return null; }
  }

  /* ===== Boards (Agile) ===== */

  async listBoards(config: EnterpriseConnectorConfig, limit = 50): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ values: Array<{ id: number; name: string; type: string }> }>(
      agile(config, `/board?maxResults=${limit}`), this.authHeaders(config));
    return d.values.map(b => toRecord('jira', 'board', { ...b }, String(b.id)));
  }

  async getBoardSprints(boardId: string, config: EnterpriseConnectorConfig, state = 'active'): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ values: Array<{ id: number; name: string; state: string; startDate: string; endDate: string }> }>(
      agile(config, `/board/${boardId}/sprint?state=${state}`), this.authHeaders(config));
    return d.values.map(s => toRecord('jira', 'sprint', { ...s }, String(s.id)));
  }

  /* ===== Sprints ===== */

  async getSprintIssues(sprintId: string, config: EnterpriseConnectorConfig, limit = 50): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<{ issues: Array<{ id: string; key: string; fields: Record<string, unknown> }> }>(
      agile(config, `/sprint/${sprintId}/issue?maxResults=${limit}`), this.authHeaders(config));
    return (d.issues ?? []).map(i => toRecord('jira', 'issue', { key: i.key, ...i.fields }, i.key));
  }

  /* ===== Users ===== */

  async searchUsers(query: string, config: EnterpriseConnectorConfig, limit = 20): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<Array<{ accountId: string; displayName: string; emailAddress: string; active: boolean }>>(
      api(config, `/user/search?query=${encodeURIComponent(query)}&maxResults=${limit}`), this.authHeaders(config));
    return d.map(u => toRecord('jira', 'user', { ...u }, u.accountId));
  }

  async getMyself(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord> {
    const d = await this.fetchJSON<{ accountId: string; displayName: string; emailAddress: string }>(
      api(config, '/myself'), this.authHeaders(config));
    return toRecord('jira', 'user', { ...d }, d.accountId);
  }

  /* ===== Fields / Priorities / Statuses ===== */

  async listFields(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<Array<{ id: string; name: string; schema?: Record<string, unknown> }>>(
      api(config, '/field'), this.authHeaders(config));
    return d.map(f => toRecord('jira', 'field', { ...f }, f.id));
  }

  async listPriorities(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<Array<{ id: string; name: string; iconUrl: string }>>(
      api(config, '/priority'), this.authHeaders(config));
    return d.map(p => toRecord('jira', 'priority', { ...p }, p.id));
  }

  async listStatuses(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<Array<{ id: string; name: string; statusCategory: Record<string, unknown> }>>(
      api(config, '/status'), this.authHeaders(config));
    return d.map(s => toRecord('jira', 'status', { ...s }, s.id));
  }

  async listIssueTypes(config: EnterpriseConnectorConfig): Promise<EnterpriseRecord[]> {
    const d = await this.fetchJSON<Array<{ id: string; name: string; subtask: boolean }>>(
      api(config, '/issuetype'), this.authHeaders(config));
    return d.map(t => toRecord('jira', 'issuetype', { ...t }, t.id));
  }

  /* ===== Labels ===== */

  async listLabels(config: EnterpriseConnectorConfig): Promise<string[]> {
    const d = await this.fetchJSON<{ values: string[] }>(
      api(config, '/label'), this.authHeaders(config));
    return d.values ?? [];
  }

  /* ===== HTTP method helper ===== */

  protected async fetchWithMethod(method: string, url: string, headers: Record<string, string>, body?: string): Promise<void> {
    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    if (!resp.ok && resp.status !== 204) {
      throw new Error(`jira: ${method} ${resp.status} ${resp.statusText}`);
    }
  }
}
