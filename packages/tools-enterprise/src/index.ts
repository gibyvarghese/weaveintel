/**
 * @weaveintel/tools-enterprise — Enterprise system connectors
 *
 * Providers: Jira (full), Confluence, Salesforce, Notion, ServiceNow (full), Canva (full)
 * Auth: Universal auth system (OAuth 2.0, OIDC, basic, API key, client credentials)
 */
export type { EnterpriseConnectorConfig, EnterpriseRecord, EnterpriseQueryOptions, EnterpriseProvider } from './types.js';
export { BaseEnterpriseProvider } from './base.js';

// Legacy connectors
export { JiraProvider } from './connectors/jira.js';
export { ConfluenceProvider } from './connectors/confluence.js';
export { SalesforceProvider } from './connectors/salesforce.js';
export { NotionProvider } from './connectors/notion.js';

// Full API connectors
export { JiraFullProvider } from './connectors/jira-full.js';
export { ServiceNowProvider } from './connectors/servicenow.js';
export { CanvaProvider } from './connectors/canva.js';

// Auth system
export { AuthManager } from './auth/manager.js';
export type { AuthMethod, TokenState, AuthProfile, TokenResponse, AuthEvents } from './auth/types.js';
export {
  jiraBasicAuth, jiraOAuth2,
  serviceNowBasicAuth, serviceNowOAuth2, serviceNowClientCredentials,
  facebookOAuth2, instagramOAuth2, canvaOAuth2,
} from './auth/profiles.js';

// MCP tool factory
export { createEnterpriseTools, createEnterpriseToolGroups, type EnterpriseToolsOptions, type EnterpriseToolGroup } from './mcp.js';

// Convenience aliases
export { createEnterpriseTools as weaveEnterpriseTools } from './mcp.js';
