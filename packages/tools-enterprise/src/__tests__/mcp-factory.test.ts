/**
 * @weaveintel/tools-enterprise — MCP tool factory tests
 *
 * Tests createEnterpriseTools generates the correct number and naming of tools.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createEnterpriseTools } from '../mcp.js';
import type { EnterpriseConnectorConfig } from '../types.js';

/* We don't invoke the tools (that requires fetch), just verify tool generation */

describe('createEnterpriseTools', () => {
  it('returns empty array for no configs', () => {
    const tools = createEnterpriseTools([]);
    expect(tools).toHaveLength(0);
  });

  it('skips disabled configs', () => {
    const configs: EnterpriseConnectorConfig[] = [{
      name: 'disabled-jira', type: 'jira', enabled: false,
      baseUrl: 'https://x.atlassian.net', authType: 'basic', authConfig: {},
    }];
    const tools = createEnterpriseTools(configs);
    expect(tools).toHaveLength(0);
  });

  it('generates Jira tools with correct prefix and count (28)', () => {
    const configs: EnterpriseConnectorConfig[] = [{
      name: 'jira-prod', type: 'jira', enabled: true,
      baseUrl: 'https://acme.atlassian.net', authType: 'basic',
      authConfig: { username: 'a', password: 'b' },
    }];
    const tools = createEnterpriseTools(configs);
    // 3 base (query, get, create) + 25 extended = 28
    expect(tools.length).toBe(28);
    // All should have the correct prefix
    for (const t of tools) {
      expect(t.schema.name).toMatch(/^enterprise\.jira-prod\./);
    }
    // Check some specific tool names
    const names = tools.map(t => t.schema.name);
    expect(names).toContain('enterprise.jira-prod.query');
    expect(names).toContain('enterprise.jira-prod.get');
    expect(names).toContain('enterprise.jira-prod.create');
    expect(names).toContain('enterprise.jira-prod.update');
    expect(names).toContain('enterprise.jira-prod.delete');
    expect(names).toContain('enterprise.jira-prod.transitions');
    expect(names).toContain('enterprise.jira-prod.comments');
    expect(names).toContain('enterprise.jira-prod.projects');
    expect(names).toContain('enterprise.jira-prod.boards');
    expect(names).toContain('enterprise.jira-prod.sprints');
    expect(names).toContain('enterprise.jira-prod.myself');
    expect(names).toContain('enterprise.jira-prod.fields');
    expect(names).toContain('enterprise.jira-prod.labels');
  });

  it('generates ServiceNow tools (17)', () => {
    const configs: EnterpriseConnectorConfig[] = [{
      name: 'snow-prod', type: 'servicenow', enabled: true,
      baseUrl: 'https://acme.service-now.com', authType: 'basic',
      authConfig: { username: 'a', password: 'b' },
    }];
    const tools = createEnterpriseTools(configs);
    expect(tools.length).toBe(17);
    const names = tools.map(t => t.schema.name);
    expect(names).toContain('enterprise.snow-prod.query');
    expect(names).toContain('enterprise.snow-prod.get');
    expect(names).toContain('enterprise.snow-prod.create');
    expect(names).toContain('enterprise.snow-prod.update');
    expect(names).toContain('enterprise.snow-prod.patch');
    expect(names).toContain('enterprise.snow-prod.delete');
    expect(names).toContain('enterprise.snow-prod.incidents');
    expect(names).toContain('enterprise.snow-prod.createIncident');
    expect(names).toContain('enterprise.snow-prod.changeRequests');
    expect(names).toContain('enterprise.snow-prod.knowledge');
    expect(names).toContain('enterprise.snow-prod.catalog');
    expect(names).toContain('enterprise.snow-prod.aggregate');
  });

  it('generates Canva tools (21)', () => {
    const configs: EnterpriseConnectorConfig[] = [{
      name: 'canva-team', type: 'canva', enabled: true,
      baseUrl: 'https://api.canva.com/rest/v1', authType: 'bearer',
      authConfig: { accessToken: 'tok' },
    }];
    const tools = createEnterpriseTools(configs);
    expect(tools.length).toBe(21);
    const names = tools.map(t => t.schema.name);
    expect(names).toContain('enterprise.canva-team.query');
    expect(names).toContain('enterprise.canva-team.get');
    expect(names).toContain('enterprise.canva-team.create');
    expect(names).toContain('enterprise.canva-team.designs');
    expect(names).toContain('enterprise.canva-team.export');
    expect(names).toContain('enterprise.canva-team.getExport');
    expect(names).toContain('enterprise.canva-team.assets');
    expect(names).toContain('enterprise.canva-team.getAsset');
    expect(names).toContain('enterprise.canva-team.uploadAsset');
    expect(names).toContain('enterprise.canva-team.deleteAsset');
    expect(names).toContain('enterprise.canva-team.folders');
    expect(names).toContain('enterprise.canva-team.getFolder');
    expect(names).toContain('enterprise.canva-team.createFolder');
    expect(names).toContain('enterprise.canva-team.updateFolder');
    expect(names).toContain('enterprise.canva-team.deleteFolder');
    expect(names).toContain('enterprise.canva-team.comments');
    expect(names).toContain('enterprise.canva-team.addComment');
    expect(names).toContain('enterprise.canva-team.replyComment');
    expect(names).toContain('enterprise.canva-team.brandTemplates');
    expect(names).toContain('enterprise.canva-team.getBrandTemplate');
    expect(names).toContain('enterprise.canva-team.user');
  });

  it('generates combined tools from multiple configs', () => {
    const configs: EnterpriseConnectorConfig[] = [
      { name: 'jira-1', type: 'jira', enabled: true, baseUrl: 'https://a.atlassian.net', authType: 'basic', authConfig: {} },
      { name: 'snow-1', type: 'servicenow', enabled: true, baseUrl: 'https://a.service-now.com', authType: 'basic', authConfig: {} },
      { name: 'canva-1', type: 'canva', enabled: true, baseUrl: 'https://api.canva.com/rest/v1', authType: 'bearer', authConfig: {} },
    ];
    const tools = createEnterpriseTools(configs);
    // 28 + 17 + 21 = 66
    expect(tools.length).toBe(66);
  });

  it('generates legacy tools for confluence', () => {
    const configs: EnterpriseConnectorConfig[] = [{
      name: 'conf-1', type: 'confluence', enabled: true,
      baseUrl: 'https://acme.atlassian.net/wiki', authType: 'basic',
      authConfig: { username: 'a', password: 'b' },
    }];
    const tools = createEnterpriseTools(configs);
    // Legacy: 3 tools (query, get, create)
    expect(tools.length).toBe(3);
    const names = tools.map(t => t.schema.name);
    expect(names).toContain('enterprise.conf-1.query');
    expect(names).toContain('enterprise.conf-1.get');
    expect(names).toContain('enterprise.conf-1.create');
  });

  it('all tools have schema with name, description, and parameters', () => {
    const configs: EnterpriseConnectorConfig[] = [{
      name: 'test', type: 'jira', enabled: true,
      baseUrl: 'https://x.atlassian.net', authType: 'basic', authConfig: {},
    }];
    const tools = createEnterpriseTools(configs);
    for (const tool of tools) {
      expect(tool.schema.name).toBeTruthy();
      expect(tool.schema.description).toBeTruthy();
      expect(tool.schema.parameters).toBeDefined();
      expect(typeof tool.invoke).toBe('function');
    }
  });
});
