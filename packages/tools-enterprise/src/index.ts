/**
 * @weaveintel/tools-enterprise — Enterprise system connectors (Jira, Confluence, Salesforce, Notion)
 */
export type { EnterpriseConnectorConfig, EnterpriseRecord, EnterpriseQueryOptions, EnterpriseProvider } from './types.js';
export { BaseEnterpriseProvider } from './base.js';
export { JiraProvider } from './connectors/jira.js';
export { ConfluenceProvider } from './connectors/confluence.js';
export { SalesforceProvider } from './connectors/salesforce.js';
export { NotionProvider } from './connectors/notion.js';
export { createEnterpriseTools } from './mcp.js';

// Convenience aliases
export { createEnterpriseTools as weaveEnterpriseTools } from './mcp.js';
