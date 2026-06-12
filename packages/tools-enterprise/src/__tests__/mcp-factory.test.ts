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
    // All should have the correct prefix (dots normalized to underscores for MCP-safe names)
    for (const t of tools) {
      expect(t.schema.name).toMatch(/^enterprise_jira-prod_/);
    }
    // Check some specific tool names
    const names = tools.map(t => t.schema.name);
    expect(names).toContain('enterprise_jira-prod_query');
    expect(names).toContain('enterprise_jira-prod_get');
    expect(names).toContain('enterprise_jira-prod_create');
    expect(names).toContain('enterprise_jira-prod_update');
    expect(names).toContain('enterprise_jira-prod_delete');
    expect(names).toContain('enterprise_jira-prod_transitions');
    expect(names).toContain('enterprise_jira-prod_comments');
    expect(names).toContain('enterprise_jira-prod_projects');
    expect(names).toContain('enterprise_jira-prod_boards');
    expect(names).toContain('enterprise_jira-prod_sprints');
    expect(names).toContain('enterprise_jira-prod_myself');
    expect(names).toContain('enterprise_jira-prod_fields');
    expect(names).toContain('enterprise_jira-prod_labels');
  });

  it('generates ServiceNow tools (17)', () => {
    const configs: EnterpriseConnectorConfig[] = [{
      name: 'snow-prod', type: 'servicenow', enabled: true,
      baseUrl: 'https://acme.service-now.com', authType: 'basic',
      authConfig: { username: 'a', password: 'b' },
    }];
    const tools = createEnterpriseTools(configs);
    // 17 base/inline tools + ~266 extended (Phases 0-13) = 283
    expect(tools.length).toBe(283);
    const names = tools.map(t => t.schema.name);
    expect(names).toContain('enterprise_snow-prod_query');
    expect(names).toContain('enterprise_snow-prod_get');
    expect(names).toContain('enterprise_snow-prod_create');
    expect(names).toContain('enterprise_snow-prod_update');
    expect(names).toContain('enterprise_snow-prod_patch');
    expect(names).toContain('enterprise_snow-prod_delete');
    expect(names).toContain('enterprise_snow-prod_incidents');
    expect(names).toContain('enterprise_snow-prod_createIncident');
    expect(names).toContain('enterprise_snow-prod_changeRequests');
    expect(names).toContain('enterprise_snow-prod_knowledge');
    expect(names).toContain('enterprise_snow-prod_catalog');
    expect(names).toContain('enterprise_snow-prod_aggregate');
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
    expect(names).toContain('enterprise_canva-team_query');
    expect(names).toContain('enterprise_canva-team_get');
    expect(names).toContain('enterprise_canva-team_create');
    expect(names).toContain('enterprise_canva-team_designs');
    expect(names).toContain('enterprise_canva-team_export');
    expect(names).toContain('enterprise_canva-team_getExport');
    expect(names).toContain('enterprise_canva-team_assets');
    expect(names).toContain('enterprise_canva-team_getAsset');
    expect(names).toContain('enterprise_canva-team_uploadAsset');
    expect(names).toContain('enterprise_canva-team_deleteAsset');
    expect(names).toContain('enterprise_canva-team_folders');
    expect(names).toContain('enterprise_canva-team_getFolder');
    expect(names).toContain('enterprise_canva-team_createFolder');
    expect(names).toContain('enterprise_canva-team_updateFolder');
    expect(names).toContain('enterprise_canva-team_deleteFolder');
    expect(names).toContain('enterprise_canva-team_comments');
    expect(names).toContain('enterprise_canva-team_addComment');
    expect(names).toContain('enterprise_canva-team_replyComment');
    expect(names).toContain('enterprise_canva-team_brandTemplates');
    expect(names).toContain('enterprise_canva-team_getBrandTemplate');
    expect(names).toContain('enterprise_canva-team_user');
  });

  it('generates combined tools from multiple configs', () => {
    const configs: EnterpriseConnectorConfig[] = [
      { name: 'jira-1', type: 'jira', enabled: true, baseUrl: 'https://a.atlassian.net', authType: 'basic', authConfig: {} },
      { name: 'snow-1', type: 'servicenow', enabled: true, baseUrl: 'https://a.service-now.com', authType: 'basic', authConfig: {} },
      { name: 'canva-1', type: 'canva', enabled: true, baseUrl: 'https://api.canva.com/rest/v1', authType: 'bearer', authConfig: {} },
    ];
    const tools = createEnterpriseTools(configs);
    // 28 (jira) + 283 (servicenow) + 21 (canva) = 332
    expect(tools.length).toBe(332);
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
    expect(names).toContain('enterprise_conf-1_query');
    expect(names).toContain('enterprise_conf-1_get');
    expect(names).toContain('enterprise_conf-1_create');
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
