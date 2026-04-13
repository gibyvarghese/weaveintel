/**
 * MCP tool definitions for enterprise connectors
 *
 * Generates tools for: Jira (full), Confluence, Salesforce, Notion,
 * ServiceNow (full), Canva (full) — each with granular CRUD operations.
 */
import type { Tool, ToolInput, ToolOutput, ExecutionContext } from '@weaveintel/core';
import type { EnterpriseConnectorConfig, EnterpriseProvider } from './types.js';
import { JiraProvider } from './connectors/jira.js';
import { JiraFullProvider } from './connectors/jira-full.js';
import { ConfluenceProvider } from './connectors/confluence.js';
import { SalesforceProvider } from './connectors/salesforce.js';
import { NotionProvider } from './connectors/notion.js';
import { ServiceNowProvider } from './connectors/servicenow.js';
import { CanvaProvider } from './connectors/canva.js';

const BUILT_IN: EnterpriseProvider[] = [new JiraProvider(), new ConfluenceProvider(), new SalesforceProvider(), new NotionProvider()];

/* ---------- extended providers (full API) ---------- */
const JIRA_FULL = new JiraFullProvider();
const SERVICENOW = new ServiceNowProvider();
const CANVA = new CanvaProvider();

/* ---------- reusable parameter schemas ---------- */

const QUERY_PARAMS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search/query string' },
    limit: { type: 'number', description: 'Max results' },
  },
  required: ['query'],
} as const;

const GET_PARAMS = {
  type: 'object',
  properties: { id: { type: 'string', description: 'Record ID' } },
  required: ['id'],
} as const;

const ID_FIELD_PARAMS = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Record ID' },
    data: { type: 'object', description: 'Field data' },
  },
  required: ['id', 'data'],
} as const;

/* ---------- tool builder helper ---------- */
type ToolDef = { name: string; desc: string; params: Record<string, unknown>; fn: (ctx: ExecutionContext, input: ToolInput) => Promise<ToolOutput> };
function buildTool(d: ToolDef): Tool {
  return { schema: { name: d.name, description: d.desc, parameters: d.params }, invoke: d.fn };
}
function ok(data: unknown): ToolOutput { return { content: JSON.stringify(data) }; }

/* ---------- Jira extended tools ---------- */
function jiraExtendedTools(prefix: string, config: EnterpriseConnectorConfig): Tool[] {
  const p = JIRA_FULL;
  return [
    buildTool({ name: `${prefix}.update`, desc: 'Update a Jira issue', params: ID_FIELD_PARAMS,
      fn: async (_c, inp) => { await p.updateIssue(String(inp.arguments['id']), inp.arguments['data'] as Record<string, unknown>, config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.delete`, desc: 'Delete a Jira issue', params: GET_PARAMS,
      fn: async (_c, inp) => { await p.deleteIssue(String(inp.arguments['id']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.transitions`, desc: 'List available transitions for a Jira issue', params: GET_PARAMS,
      fn: async (_c, inp) => ok(await p.getTransitions(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.transition`, desc: 'Transition a Jira issue to a new status',
      params: { type: 'object', properties: { issueId: { type: 'string' }, transitionId: { type: 'string' } }, required: ['issueId', 'transitionId'] },
      fn: async (_c, inp) => { await p.transitionIssue(String(inp.arguments['issueId']), String(inp.arguments['transitionId']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.comments`, desc: 'List comments on a Jira issue', params: GET_PARAMS,
      fn: async (_c, inp) => ok(await p.getComments(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.addComment`, desc: 'Add a comment to a Jira issue',
      params: { type: 'object', properties: { issueId: { type: 'string' }, body: { type: 'object', description: 'ADF body' } }, required: ['issueId', 'body'] },
      fn: async (_c, inp) => ok(await p.addComment(String(inp.arguments['issueId']), inp.arguments['body'] as Record<string, unknown>, config)) }),
    buildTool({ name: `${prefix}.updateComment`, desc: 'Update a comment on a Jira issue',
      params: { type: 'object', properties: { issueId: { type: 'string' }, commentId: { type: 'string' }, body: { type: 'object' } }, required: ['issueId', 'commentId', 'body'] },
      fn: async (_c, inp) => { await p.updateComment(String(inp.arguments['issueId']), String(inp.arguments['commentId']), inp.arguments['body'] as Record<string, unknown>, config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.deleteComment`, desc: 'Delete a comment',
      params: { type: 'object', properties: { issueId: { type: 'string' }, commentId: { type: 'string' } }, required: ['issueId', 'commentId'] },
      fn: async (_c, inp) => { await p.deleteComment(String(inp.arguments['issueId']), String(inp.arguments['commentId']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.watchers`, desc: 'List watchers on a Jira issue', params: GET_PARAMS,
      fn: async (_c, inp) => ok(await p.getWatchers(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.addWatcher`, desc: 'Add a watcher',
      params: { type: 'object', properties: { issueId: { type: 'string' }, accountId: { type: 'string' } }, required: ['issueId', 'accountId'] },
      fn: async (_c, inp) => { await p.addWatcher(String(inp.arguments['issueId']), String(inp.arguments['accountId']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.worklogs`, desc: 'List worklogs on a Jira issue', params: GET_PARAMS,
      fn: async (_c, inp) => ok(await p.getWorklogs(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.addWorklog`, desc: 'Add a worklog',
      params: { type: 'object', properties: { issueId: { type: 'string' }, data: { type: 'object' } }, required: ['issueId', 'data'] },
      fn: async (_c, inp) => ok(await p.addWorklog(String(inp.arguments['issueId']), inp.arguments['data'] as Record<string, unknown>, config)) }),
    buildTool({ name: `${prefix}.attachments`, desc: 'List attachments on a Jira issue', params: GET_PARAMS,
      fn: async (_c, inp) => ok(await p.getAttachments(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.projects`, desc: 'List Jira projects',
      params: { type: 'object', properties: { limit: { type: 'number' } } },
      fn: async (_c, inp) => ok(await p.listProjects(config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.project`, desc: 'Get a Jira project by key', params: GET_PARAMS,
      fn: async (_c, inp) => ok(await p.getProject(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.boards`, desc: 'List Jira boards',
      params: { type: 'object', properties: { limit: { type: 'number' } } },
      fn: async (_c, inp) => ok(await p.listBoards(config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.sprints`, desc: 'List sprints for a board',
      params: { type: 'object', properties: { boardId: { type: 'string' }, state: { type: 'string' } }, required: ['boardId'] },
      fn: async (_c, inp) => ok(await p.getBoardSprints(String(inp.arguments['boardId']), config, inp.arguments['state'] as string ?? 'active')) }),
    buildTool({ name: `${prefix}.sprintIssues`, desc: 'List issues in a sprint',
      params: { type: 'object', properties: { sprintId: { type: 'string' }, limit: { type: 'number' } }, required: ['sprintId'] },
      fn: async (_c, inp) => ok(await p.getSprintIssues(String(inp.arguments['sprintId']), config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.searchUsers`, desc: 'Search Jira users',
      params: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
      fn: async (_c, inp) => ok(await p.searchUsers(String(inp.arguments['query']), config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.myself`, desc: 'Get current Jira user',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.getMyself(config)) }),
    buildTool({ name: `${prefix}.fields`, desc: 'List Jira fields',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.listFields(config)) }),
    buildTool({ name: `${prefix}.priorities`, desc: 'List Jira priorities',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.listPriorities(config)) }),
    buildTool({ name: `${prefix}.statuses`, desc: 'List Jira statuses',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.listStatuses(config)) }),
    buildTool({ name: `${prefix}.issueTypes`, desc: 'List Jira issue types',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.listIssueTypes(config)) }),
    buildTool({ name: `${prefix}.labels`, desc: 'List Jira labels',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.listLabels(config)) }),
  ];
}

/* ---------- ServiceNow extended tools ---------- */
function serviceNowTools(prefix: string, config: EnterpriseConnectorConfig): Tool[] {
  const p = SERVICENOW;
  return [
    buildTool({ name: `${prefix}.query`, desc: 'Query ServiceNow table records',
      params: { type: 'object', properties: { query: { type: 'string' }, table: { type: 'string', description: 'Table name (default: incident)' }, limit: { type: 'number' } }, required: ['query'] },
      fn: async (_c, inp) => ok(await p.query({ query: String(inp.arguments['query']), limit: inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined, ...( inp.arguments['table'] ? { table: String(inp.arguments['table']) } : {}) } as unknown as import('./types.js').EnterpriseQueryOptions, config)) }),
    buildTool({ name: `${prefix}.get`, desc: 'Get a ServiceNow record by sys_id',
      params: { type: 'object', properties: { id: { type: 'string' }, table: { type: 'string' } }, required: ['id'] },
      fn: async (_c, inp) => ok(await p.get(String(inp.arguments['id']), config, inp.arguments['table'] as string)) }),
    buildTool({ name: `${prefix}.create`, desc: 'Create a ServiceNow record',
      params: { type: 'object', properties: { table: { type: 'string' }, data: { type: 'object' } }, required: ['table', 'data'] },
      fn: async (_c, inp) => ok(await p.create({ ...(inp.arguments['data'] as Record<string, unknown>), __table: String(inp.arguments['table']) }, config)) }),
    buildTool({ name: `${prefix}.update`, desc: 'Update a ServiceNow record (full replace)',
      params: { type: 'object', properties: { id: { type: 'string' }, table: { type: 'string' }, data: { type: 'object' } }, required: ['id', 'table', 'data'] },
      fn: async (_c, inp) => ok(await p.updateRecord(String(inp.arguments['id']), String(inp.arguments['table']), inp.arguments['data'] as Record<string, unknown>, config)) }),
    buildTool({ name: `${prefix}.patch`, desc: 'Partially update a ServiceNow record',
      params: { type: 'object', properties: { id: { type: 'string' }, table: { type: 'string' }, data: { type: 'object' } }, required: ['id', 'table', 'data'] },
      fn: async (_c, inp) => ok(await p.patchRecord(String(inp.arguments['id']), String(inp.arguments['table']), inp.arguments['data'] as Record<string, unknown>, config)) }),
    buildTool({ name: `${prefix}.delete`, desc: 'Delete a ServiceNow record',
      params: { type: 'object', properties: { id: { type: 'string' }, table: { type: 'string' } }, required: ['id', 'table'] },
      fn: async (_c, inp) => { await p.deleteRecord(String(inp.arguments['id']), String(inp.arguments['table']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.incidents`, desc: 'List ServiceNow incidents',
      params: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
      fn: async (_c, inp) => ok(await p.listIncidents(config, inp.arguments['query'] as string, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.createIncident`, desc: 'Create a ServiceNow incident',
      params: { type: 'object', properties: { data: { type: 'object' } }, required: ['data'] },
      fn: async (_c, inp) => ok(await p.createIncident(inp.arguments['data'] as Record<string, unknown>, config)) }),
    buildTool({ name: `${prefix}.changeRequests`, desc: 'List ServiceNow change requests',
      params: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
      fn: async (_c, inp) => ok(await p.listChangeRequests(config, inp.arguments['query'] as string, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.createChangeRequest`, desc: 'Create a ServiceNow change request',
      params: { type: 'object', properties: { data: { type: 'object' } }, required: ['data'] },
      fn: async (_c, inp) => ok(await p.createChangeRequest(inp.arguments['data'] as Record<string, unknown>, config)) }),
    buildTool({ name: `${prefix}.problems`, desc: 'List ServiceNow problems',
      params: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
      fn: async (_c, inp) => ok(await p.listProblems(config, inp.arguments['query'] as string, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.cmdb`, desc: 'List CMDB configuration items',
      params: { type: 'object', properties: { className: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } } },
      fn: async (_c, inp) => ok(await p.listCMDBItems(config, inp.arguments['className'] as string, inp.arguments['query'] as string, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.users`, desc: 'Search ServiceNow users',
      params: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
      fn: async (_c, inp) => ok(await p.searchUsers(String(inp.arguments['query']), config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.knowledge`, desc: 'Search ServiceNow knowledge base',
      params: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
      fn: async (_c, inp) => ok(await p.searchKnowledge(String(inp.arguments['query']), config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.catalog`, desc: 'List service catalog items',
      params: { type: 'object', properties: { limit: { type: 'number' } } },
      fn: async (_c, inp) => ok(await p.listCatalogItems(config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.orderCatalog`, desc: 'Order a service catalog item',
      params: { type: 'object', properties: { id: { type: 'string' }, variables: { type: 'object' } }, required: ['id'] },
      fn: async (_c, inp) => ok(await p.orderCatalogItem(String(inp.arguments['id']), (inp.arguments['variables'] as Record<string, unknown>) ?? {}, config)) }),
    buildTool({ name: `${prefix}.aggregate`, desc: 'Run an aggregate query on a ServiceNow table',
      params: { type: 'object', properties: { table: { type: 'string' }, query: { type: 'string' }, groupBy: { type: 'string' } }, required: ['table', 'query', 'groupBy'] },
      fn: async (_c, inp) => ok(await p.aggregate(String(inp.arguments['table']), String(inp.arguments['query']), String(inp.arguments['groupBy']), config)) }),
  ];
}

/* ---------- Canva extended tools ---------- */
function canvaTools(prefix: string, config: EnterpriseConnectorConfig): Tool[] {
  const p = CANVA;
  return [
    buildTool({ name: `${prefix}.query`, desc: 'Search Canva designs', params: QUERY_PARAMS,
      fn: async (_c, inp) => ok(await p.query({ query: String(inp.arguments['query']), limit: inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined }, config)) }),
    buildTool({ name: `${prefix}.get`, desc: 'Get a Canva design', params: GET_PARAMS,
      fn: async (_c, inp) => ok(await p.get(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.create`, desc: 'Create a Canva design',
      params: { type: 'object', properties: { data: { type: 'object' } }, required: ['data'] },
      fn: async (_c, inp) => ok(await p.create(inp.arguments['data'] as Record<string, unknown>, config)) }),
    buildTool({ name: `${prefix}.designs`, desc: 'List all Canva designs',
      params: { type: 'object', properties: { limit: { type: 'number' }, continuation: { type: 'string' } } },
      fn: async (_c, inp) => ok(await p.listDesigns(config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined, inp.arguments['continuation'] as string)) }),
    buildTool({ name: `${prefix}.export`, desc: 'Export a Canva design',
      params: { type: 'object', properties: { designId: { type: 'string' }, format: { type: 'string', description: 'pdf|png|jpg|pptx|mp4|gif' } }, required: ['designId', 'format'] },
      fn: async (_c, inp) => ok(await p.createExport(String(inp.arguments['designId']), inp.arguments['format'] as 'pdf' | 'png' | 'jpg' | 'pptx' | 'mp4' | 'gif', config)) }),
    buildTool({ name: `${prefix}.getExport`, desc: 'Check export status',
      params: { type: 'object', properties: { exportId: { type: 'string' } }, required: ['exportId'] },
      fn: async (_c, inp) => ok(await p.getExport(String(inp.arguments['exportId']), config)) }),
    buildTool({ name: `${prefix}.assets`, desc: 'List Canva assets',
      params: { type: 'object', properties: { limit: { type: 'number' }, continuation: { type: 'string' } } },
      fn: async (_c, inp) => ok(await p.listAssets(config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined, inp.arguments['continuation'] as string)) }),
    buildTool({ name: `${prefix}.getAsset`, desc: 'Get a Canva asset', params: GET_PARAMS,
      fn: async (_c, inp) => ok(await p.getAsset(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.uploadAsset`, desc: 'Upload an asset to Canva',
      params: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' } }, required: ['name', 'url'] },
      fn: async (_c, inp) => ok(await p.uploadAsset(String(inp.arguments['name']), String(inp.arguments['url']), config)) }),
    buildTool({ name: `${prefix}.deleteAsset`, desc: 'Delete a Canva asset', params: GET_PARAMS,
      fn: async (_c, inp) => { await p.deleteAsset(String(inp.arguments['id']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.folders`, desc: 'List Canva folders',
      params: { type: 'object', properties: { limit: { type: 'number' }, continuation: { type: 'string' } } },
      fn: async (_c, inp) => ok(await p.listFolders(config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined, inp.arguments['continuation'] as string)) }),
    buildTool({ name: `${prefix}.getFolder`, desc: 'Get a Canva folder', params: GET_PARAMS,
      fn: async (_c, inp) => ok(await p.getFolder(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.createFolder`, desc: 'Create a Canva folder',
      params: { type: 'object', properties: { name: { type: 'string' }, parentFolderId: { type: 'string' } }, required: ['name'] },
      fn: async (_c, inp) => ok(await p.createFolder(String(inp.arguments['name']), inp.arguments['parentFolderId'] as string, config)) }),
    buildTool({ name: `${prefix}.updateFolder`, desc: 'Rename a Canva folder',
      params: { type: 'object', properties: { folderId: { type: 'string' }, name: { type: 'string' } }, required: ['folderId', 'name'] },
      fn: async (_c, inp) => ok(await p.updateFolder(String(inp.arguments['folderId']), String(inp.arguments['name']), config)) }),
    buildTool({ name: `${prefix}.deleteFolder`, desc: 'Delete a Canva folder', params: GET_PARAMS,
      fn: async (_c, inp) => { await p.deleteFolder(String(inp.arguments['id']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.comments`, desc: 'List comments on a Canva design',
      params: { type: 'object', properties: { designId: { type: 'string' }, limit: { type: 'number' } }, required: ['designId'] },
      fn: async (_c, inp) => ok(await p.listComments(String(inp.arguments['designId']), config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.addComment`, desc: 'Add a comment to a Canva design',
      params: { type: 'object', properties: { designId: { type: 'string' }, message: { type: 'string' } }, required: ['designId', 'message'] },
      fn: async (_c, inp) => ok(await p.addComment(String(inp.arguments['designId']), String(inp.arguments['message']), config)) }),
    buildTool({ name: `${prefix}.replyComment`, desc: 'Reply to a comment on a Canva design',
      params: { type: 'object', properties: { designId: { type: 'string' }, commentId: { type: 'string' }, message: { type: 'string' } }, required: ['designId', 'commentId', 'message'] },
      fn: async (_c, inp) => ok(await p.replyToComment(String(inp.arguments['designId']), String(inp.arguments['commentId']), String(inp.arguments['message']), config)) }),
    buildTool({ name: `${prefix}.brandTemplates`, desc: 'List Canva brand templates',
      params: { type: 'object', properties: { limit: { type: 'number' } } },
      fn: async (_c, inp) => ok(await p.listBrandTemplates(config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.getBrandTemplate`, desc: 'Get a Canva brand template', params: GET_PARAMS,
      fn: async (_c, inp) => ok(await p.getBrandTemplate(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.user`, desc: 'Get current Canva user',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.getUser(config)) }),
  ];
}

/* ---------- main factory ---------- */

export function createEnterpriseTools(
  configs: EnterpriseConnectorConfig[],
  extraProviders?: EnterpriseProvider[],
): Tool[] {
  const providerMap = new Map<string, EnterpriseProvider>();
  for (const p of [...BUILT_IN, ...(extraProviders ?? [])]) providerMap.set(p.type, p);

  const tools: Tool[] = [];

  for (const config of configs.filter(c => c.enabled)) {
    const prefix = `enterprise.${config.name}`;

    /* --- extended connectors with full API coverage --- */
    if (config.type === 'jira') {
      // Base query/get/create from JiraFullProvider
      const jp = JIRA_FULL;
      tools.push(buildTool({ name: `${prefix}.query`, desc: `Search Jira issues via JQL`, params: QUERY_PARAMS,
        fn: async (_c, inp) => ok(await jp.query({ query: String(inp.arguments['query']), limit: inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined }, config)) }));
      tools.push(buildTool({ name: `${prefix}.get`, desc: `Get a Jira issue`, params: GET_PARAMS,
        fn: async (_c, inp) => ok(await jp.get(String(inp.arguments['id']), config)) }));
      tools.push(buildTool({ name: `${prefix}.create`, desc: `Create a Jira issue`,
        params: { type: 'object', properties: { data: { type: 'object', description: 'Issue fields' } }, required: ['data'] },
        fn: async (_c, inp) => ok(await jp.create(inp.arguments['data'] as Record<string, unknown>, config)) }));
      tools.push(...jiraExtendedTools(prefix, config));
      continue;
    }

    if (config.type === 'servicenow') {
      tools.push(...serviceNowTools(prefix, config));
      continue;
    }

    if (config.type === 'canva') {
      tools.push(...canvaTools(prefix, config));
      continue;
    }

    /* --- legacy providers (confluence, salesforce, notion) --- */
    const provider = providerMap.get(config.type);
    if (!provider) continue;

    tools.push({
      schema: {
        name: `${prefix}.query`,
        description: `Query ${config.type} connector "${config.name}"`,
        parameters: QUERY_PARAMS,
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const args = input.arguments;
        const results = await provider.query(
          { query: String(args['query']), limit: args['limit'] ? Number(args['limit']) : undefined },
          config,
        );
        return { content: JSON.stringify(results) };
      },
    });

    tools.push({
      schema: {
        name: `${prefix}.get`,
        description: `Get a record from ${config.type} connector "${config.name}"`,
        parameters: GET_PARAMS,
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const result = await provider.get(String(input.arguments['id']), config);
        return { content: JSON.stringify(result) };
      },
    });

    tools.push({
      schema: {
        name: `${prefix}.create`,
        description: `Create a record in ${config.type} connector "${config.name}"`,
        parameters: { type: 'object', properties: { data: { type: 'object', description: 'Record data' } }, required: ['data'] },
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const data = input.arguments['data'] as Record<string, unknown>;
        const result = await provider.create(data, config);
        return { content: JSON.stringify(result) };
      },
    });
  }

  return tools;
}
