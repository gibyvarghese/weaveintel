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
import { serviceNowExtendedTools, serviceNowToolGroups, type ServiceNowToolGroup } from './servicenow-tools.js';

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

/**
 * Normalize tool arguments so handlers always see the expected nested structure.
 * LLMs sometimes send flat args ({short_description:"…", urgency:"1"}) instead of
 * nesting them ({data: {short_description:"…", urgency:"1"}}).  This helper inspects
 * the tool parameter schema: if there is exactly one 'object'-typed param whose key
 * is missing from the args, all extra (non-scalar-param) keys are wrapped under it.
 */
function normalizeArgs(params: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const props = (params as { properties?: Record<string, { type?: string }> }).properties;
  if (!props) return args;
  const objectKeys = Object.keys(props).filter(k => props[k]?.type === 'object');
  if (objectKeys.length !== 1) return args;
  const objKey = objectKeys[0]!;
  const existing = args[objKey];
  if (existing != null && typeof existing === 'object' && !Array.isArray(existing)) return args;
  const scalarKeys = new Set(Object.keys(props).filter(k => k !== objKey));
  const dataObj: Record<string, unknown> = {};
  const newArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (scalarKeys.has(k)) newArgs[k] = v;
    else if (k !== objKey) dataObj[k] = v;
  }
  if (Object.keys(dataObj).length > 0) newArgs[objKey] = dataObj;
  return newArgs;
}

function buildTool(d: ToolDef): Tool {
  const safeName = d.name.replace(/\./g, '_');
  return { schema: { name: safeName, description: d.desc, parameters: d.params },
    invoke: (ctx, inp) => d.fn(ctx, { ...inp, arguments: normalizeArgs(d.params, inp.arguments) }) };
}
function ok(data: unknown): ToolOutput { return { content: JSON.stringify(data) }; }

/* ---------- Jira extended tools ---------- */
function jiraExtendedTools(prefix: string, config: EnterpriseConnectorConfig): Tool[] {
  const p = JIRA_FULL;
  return [
    buildTool({ name: `${prefix}.update`, desc: 'Update a Jira issue. Pass the issue key (e.g. PROJ-123) and a data object with fields to update. Supports summary, description, priority, labels, components, assignee, custom fields.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Issue key (e.g. PROJ-123) or issue ID' }, data: { type: 'object', description: 'Fields to update: { fields: { summary, description, priority: { name }, labels, assignee: { accountId }, ... } }' } }, required: ['id', 'data'] },
      fn: async (_c, inp) => { await p.updateIssue(String(inp.arguments['id']), inp.arguments['data'] as Record<string, unknown>, config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.delete`, desc: 'Permanently delete a Jira issue by key or ID. This is irreversible. Sub-tasks are also deleted.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Issue key (e.g. PROJ-123) or issue ID' } }, required: ['id'] },
      fn: async (_c, inp) => { await p.deleteIssue(String(inp.arguments['id']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.transitions`, desc: 'List available status transitions for a Jira issue. Returns transition IDs and names (e.g. "In Progress", "Done"). Use the transition ID with the transition tool to move the issue.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Issue key (e.g. PROJ-123)' } }, required: ['id'] },
      fn: async (_c, inp) => ok(await p.getTransitions(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.transition`, desc: 'Transition a Jira issue to a new status (e.g. move from "To Do" to "In Progress"). First call transitions to get available transition IDs, then use the desired transitionId here.',
      params: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue key (e.g. PROJ-123)' }, transitionId: { type: 'string', description: 'Transition ID from the transitions tool response' } }, required: ['issueId', 'transitionId'] },
      fn: async (_c, inp) => { await p.transitionIssue(String(inp.arguments['issueId']), String(inp.arguments['transitionId']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.comments`, desc: 'List all comments on a Jira issue, ordered by creation date. Returns comment body (ADF or plain text), author, created/updated timestamps.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Issue key (e.g. PROJ-123)' } }, required: ['id'] },
      fn: async (_c, inp) => ok(await p.getComments(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.addComment`, desc: 'Add a comment to a Jira issue. The body should be in Atlassian Document Format (ADF) or a simple text object. For plain text: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Your comment" }] }] }.',
      params: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue key (e.g. PROJ-123)' }, body: { type: 'object', description: 'Comment body in ADF format. Minimal: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "comment text" }] }] }' } }, required: ['issueId', 'body'] },
      fn: async (_c, inp) => ok(await p.addComment(String(inp.arguments['issueId']), inp.arguments['body'] as Record<string, unknown>, config)) }),
    buildTool({ name: `${prefix}.updateComment`, desc: 'Update an existing comment on a Jira issue. Requires both the issue key and comment ID. Body must be in ADF format.',
      params: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue key (e.g. PROJ-123)' }, commentId: { type: 'string', description: 'Comment ID to update' }, body: { type: 'object', description: 'Updated comment body in ADF format' } }, required: ['issueId', 'commentId', 'body'] },
      fn: async (_c, inp) => { await p.updateComment(String(inp.arguments['issueId']), String(inp.arguments['commentId']), inp.arguments['body'] as Record<string, unknown>, config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.deleteComment`, desc: 'Delete a comment from a Jira issue. This is irreversible.',
      params: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue key (e.g. PROJ-123)' }, commentId: { type: 'string', description: 'Comment ID to delete' } }, required: ['issueId', 'commentId'] },
      fn: async (_c, inp) => { await p.deleteComment(String(inp.arguments['issueId']), String(inp.arguments['commentId']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.watchers`, desc: 'List all users watching a Jira issue. Watchers receive notifications about issue updates. Returns an array of user objects with accountId and displayName.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Issue key (e.g. PROJ-123)' } }, required: ['id'] },
      fn: async (_c, inp) => ok(await p.getWatchers(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.addWatcher`, desc: 'Add a user as a watcher on a Jira issue. The user will receive notifications about changes to this issue.',
      params: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue key (e.g. PROJ-123)' }, accountId: { type: 'string', description: 'Atlassian account ID of the user to add as watcher' } }, required: ['issueId', 'accountId'] },
      fn: async (_c, inp) => { await p.addWatcher(String(inp.arguments['issueId']), String(inp.arguments['accountId']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.worklogs`, desc: 'List all time tracking worklogs on a Jira issue. Returns time spent, author, date started, and comment for each worklog entry.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Issue key (e.g. PROJ-123)' } }, required: ['id'] },
      fn: async (_c, inp) => ok(await p.getWorklogs(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.addWorklog`, desc: 'Log time spent on a Jira issue. Pass timeSpent (e.g. "3h 30m"), started date, and optional comment. Updates the issue time tracking fields.',
      params: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue key (e.g. PROJ-123)' }, data: { type: 'object', description: 'Worklog data: { timeSpent: "2h 30m", started: "2024-01-15T10:00:00.000+0000", comment: { type: "doc", ... } }' } }, required: ['issueId', 'data'] },
      fn: async (_c, inp) => ok(await p.addWorklog(String(inp.arguments['issueId']), inp.arguments['data'] as Record<string, unknown>, config)) }),
    buildTool({ name: `${prefix}.attachments`, desc: 'List all file attachments on a Jira issue. Returns filename, size, mimeType, author, created date, and download URL for each attachment.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Issue key (e.g. PROJ-123)' } }, required: ['id'] },
      fn: async (_c, inp) => ok(await p.getAttachments(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.projects`, desc: 'List all Jira projects accessible to the current user. Returns project key, name, projectTypeKey (software/business/service_desk), lead, and URL.',
      params: { type: 'object', properties: { limit: { type: 'number', description: 'Max projects to return' } } },
      fn: async (_c, inp) => ok(await p.listProjects(config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.project`, desc: 'Get detailed information about a specific Jira project including components, versions, issue types, roles, and project lead.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Project key (e.g. PROJ) or project ID' } }, required: ['id'] },
      fn: async (_c, inp) => ok(await p.getProject(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.boards`, desc: 'List Jira agile boards (Scrum and Kanban). Returns board ID, name, type, and project location. Use the board ID with sprints tool to list sprints.',
      params: { type: 'object', properties: { limit: { type: 'number', description: 'Max boards to return' } } },
      fn: async (_c, inp) => ok(await p.listBoards(config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.sprints`, desc: 'List sprints for a Jira agile board. Filter by state (active, closed, future). Returns sprint ID, name, state, startDate, endDate, goal.',
      params: { type: 'object', properties: { boardId: { type: 'string', description: 'Board ID from the boards tool' }, state: { type: 'string', description: 'Filter by sprint state: active, closed, or future (default: active)' } }, required: ['boardId'] },
      fn: async (_c, inp) => ok(await p.getBoardSprints(String(inp.arguments['boardId']), config, inp.arguments['state'] as string ?? 'active')) }),
    buildTool({ name: `${prefix}.sprintIssues`, desc: 'List all issues in a specific sprint. Returns issue key, summary, status, assignee, priority, and story points for each issue in the sprint.',
      params: { type: 'object', properties: { sprintId: { type: 'string', description: 'Sprint ID from the sprints tool' }, limit: { type: 'number', description: 'Max issues to return' } }, required: ['sprintId'] },
      fn: async (_c, inp) => ok(await p.getSprintIssues(String(inp.arguments['sprintId']), config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.searchUsers`, desc: 'Search for Jira users by display name, email, or username. Returns accountId (needed for assignment), displayName, emailAddress, and active status.',
      params: { type: 'object', properties: { query: { type: 'string', description: 'Search text matching user display name, email, or username' }, limit: { type: 'number', description: 'Max results to return' } }, required: ['query'] },
      fn: async (_c, inp) => ok(await p.searchUsers(String(inp.arguments['query']), config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.myself`, desc: 'Get the currently authenticated Jira user profile. Returns accountId, displayName, emailAddress, timezone, and locale.',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.getMyself(config)) }),
    buildTool({ name: `${prefix}.fields`, desc: 'List all available fields in the Jira instance (system + custom). Returns field ID, name, type, and whether it is custom. Useful for discovering custom field IDs (e.g. customfield_10001).',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.listFields(config)) }),
    buildTool({ name: `${prefix}.priorities`, desc: 'List all priority levels configured in the Jira instance (e.g. Highest, High, Medium, Low, Lowest). Returns priority ID, name, iconUrl, and statusColor.',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.listPriorities(config)) }),
    buildTool({ name: `${prefix}.statuses`, desc: 'List all issue statuses in the Jira instance (e.g. To Do, In Progress, Done). Returns status ID, name, statusCategory, and description. Useful for understanding workflow states.',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.listStatuses(config)) }),
    buildTool({ name: `${prefix}.issueTypes`, desc: 'List all issue types configured in Jira (e.g. Bug, Story, Task, Epic, Sub-task). Returns type ID, name, description, and whether it is a subtask type.',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.listIssueTypes(config)) }),
    buildTool({ name: `${prefix}.labels`, desc: 'List all labels used across Jira issues. Labels are free-text tags for categorizing issues (e.g. "frontend", "technical-debt", "customer-reported").',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.listLabels(config)) }),
  ];
}

/* ---------- ServiceNow extended tools ---------- */
function serviceNowTools(prefix: string, config: EnterpriseConnectorConfig, includeExtended = true): Tool[] {
  const p = SERVICENOW;
  return [
    buildTool({ name: `${prefix}.query`, desc: 'Query any ServiceNow table using encoded query syntax (e.g. "active=true^priority=1"). Defaults to incident table. Returns an array of matching records with all fields. Use standard ServiceNow sysparm_query operators: =, !=, LIKE, STARTSWITH, ENDSWITH, IN, ORDERBY, ^NQ (new query/OR).',
      params: { type: 'object', properties: { query: { type: 'string', description: 'Encoded query string, e.g. "active=true^priority=1^ORDERBYDESCsys_created_on"' }, table: { type: 'string', description: 'Table name to query (default: incident). Examples: incident, change_request, problem, sys_user, kb_knowledge, sc_req_item, cmdb_ci' }, limit: { type: 'number', description: 'Maximum records to return (default: 50, max: 10000)' } }, required: ['query'] },
      fn: async (_c, inp) => ok(await p.query({ query: String(inp.arguments['query']), limit: inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined, ...( inp.arguments['table'] ? { table: String(inp.arguments['table']) } : {}) } as unknown as import('./types.js').EnterpriseQueryOptions, config)) }),
    buildTool({ name: `${prefix}.get`, desc: 'Retrieve a single ServiceNow record by its sys_id (32-char GUID). Specify the table name to fetch from the correct table. Returns the full record with all field values.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'The sys_id (32-character GUID) of the record to retrieve' }, table: { type: 'string', description: 'Table name (default: incident). Examples: incident, change_request, problem, sys_user, cmdb_ci, sc_cat_item' } }, required: ['id'] },
      fn: async (_c, inp) => ok(await p.get(String(inp.arguments['id']), config, inp.arguments['table'] as string)) }),
    buildTool({ name: `${prefix}.create`, desc: 'Create a new record in any ServiceNow table. Pass the target table name and a data object with the field values. The record is inserted and the created record (with sys_id) is returned.',
      params: { type: 'object', properties: { table: { type: 'string', description: 'Target table name, e.g. incident, change_request, problem, sys_user, sc_task, kb_knowledge' }, data: { type: 'object', description: 'Field key-value pairs for the new record. Use ServiceNow field names (e.g. short_description, description, urgency, impact, assignment_group, caller_id, category)' } }, required: ['table', 'data'] },
      fn: async (_c, inp) => ok(await p.create({ ...(inp.arguments['data'] as Record<string, unknown>), __table: String(inp.arguments['table']) }, config)) }),
    buildTool({ name: `${prefix}.update`, desc: 'Fully replace a ServiceNow record (PUT). All fields not included in data will be cleared to default values. Use patch instead for partial updates. Returns the updated record.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the record to update' }, table: { type: 'string', description: 'Table name, e.g. incident, change_request' }, data: { type: 'object', description: 'Complete field key-value pairs — all fields not provided will be reset' } }, required: ['id', 'table', 'data'] },
      fn: async (_c, inp) => ok(await p.updateRecord(String(inp.arguments['id']), String(inp.arguments['table']), inp.arguments['data'] as Record<string, unknown>, config)) }),
    buildTool({ name: `${prefix}.patch`, desc: 'Partially update a ServiceNow record (PATCH). Only the fields included in data are modified; all other fields remain unchanged. Preferred over update for most edits. Returns the updated record.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the record to patch' }, table: { type: 'string', description: 'Table name, e.g. incident, change_request' }, data: { type: 'object', description: 'Only the fields to modify, e.g. { state: "6", close_notes: "Resolved by automation" }' } }, required: ['id', 'table', 'data'] },
      fn: async (_c, inp) => ok(await p.patchRecord(String(inp.arguments['id']), String(inp.arguments['table']), inp.arguments['data'] as Record<string, unknown>, config)) }),
    buildTool({ name: `${prefix}.delete`, desc: 'Permanently delete a ServiceNow record by sys_id. This is irreversible — consider deactivating (patch active=false) instead when possible. Returns success confirmation.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the record to delete' }, table: { type: 'string', description: 'Table name, e.g. incident, sys_user, sc_cat_item' } }, required: ['id', 'table'] },
      fn: async (_c, inp) => { await p.deleteRecord(String(inp.arguments['id']), String(inp.arguments['table']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.incidents`, desc: 'List IT incidents from ServiceNow. Supports encoded query filtering (e.g. "active=true^priority<=2" for high-priority open incidents). Returns incident records with number, short_description, state, priority, assignment_group, assigned_to, etc.',
      params: { type: 'object', properties: { query: { type: 'string', description: 'Encoded query filter (optional). Examples: "active=true", "priority=1^state=2", "assigned_to=<sys_id>". Empty string returns all incidents.' }, limit: { type: 'number', description: 'Max results (default: 50)' } } },
      fn: async (_c, inp) => ok(await p.listIncidents(config, inp.arguments['query'] as string, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.createIncident`, desc: 'Create a new IT incident in ServiceNow. At minimum provide short_description. Common fields: description (detailed info), urgency (1=High, 2=Medium, 3=Low), impact (1=High, 2=Medium, 3=Low), assignment_group (sys_id or name), caller_id (sys_id of the affected user), category, subcategory, cmdb_ci (affected config item), contact_type.',
      params: { type: 'object', properties: { data: { type: 'object', description: 'Incident fields. Required: short_description. Optional: description, urgency (1-3), impact (1-3), assignment_group, caller_id, category, subcategory, cmdb_ci, contact_type (phone/email/self-service/walk-in)' } }, required: ['data'] },
      fn: async (_c, inp) => ok(await p.createIncident(inp.arguments['data'] as Record<string, unknown>, config)) }),
    buildTool({ name: `${prefix}.changeRequests`, desc: 'List change requests from ServiceNow. Supports query filtering (e.g. "type=normal^state=assess" for normal changes in assessment). Returns change_request records with number, short_description, type (normal/standard/emergency), state, risk, impact, assignment_group.',
      params: { type: 'object', properties: { query: { type: 'string', description: 'Encoded query for change_request table. Examples: "type=normal", "state=-1" (new), "risk=high"' }, limit: { type: 'number', description: 'Max results (default: 50)' } } },
      fn: async (_c, inp) => ok(await p.listChangeRequests(config, inp.arguments['query'] as string, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.createChangeRequest`, desc: 'Create a new change request in ServiceNow. Set type (normal, standard, emergency), short_description, description, assignment_group, risk (high/moderate/low), impact, start_date, end_date, justification, implementation_plan, backout_plan, test_plan.',
      params: { type: 'object', properties: { data: { type: 'object', description: 'Change request fields. Required: short_description, type. Recommended: description, assignment_group, risk, impact, start_date, end_date, justification, implementation_plan, backout_plan, test_plan' } }, required: ['data'] },
      fn: async (_c, inp) => ok(await p.createChangeRequest(inp.arguments['data'] as Record<string, unknown>, config)) }),
    buildTool({ name: `${prefix}.problems`, desc: 'List problem records from ServiceNow. Problems represent the root cause of one or more incidents. Supports query filtering. Returns problem records with number, short_description, state, priority, known_error (true/false), first_reported_by_task.',
      params: { type: 'object', properties: { query: { type: 'string', description: 'Encoded query for problem table. Examples: "known_error=true", "state=101" (new), "priority<=2"' }, limit: { type: 'number', description: 'Max results (default: 50)' } } },
      fn: async (_c, inp) => ok(await p.listProblems(config, inp.arguments['query'] as string, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.cmdb`, desc: 'List Configuration Management Database (CMDB) items. Query CIs (configuration items) like servers, applications, network devices. Specify the CMDB class to narrow results (e.g. cmdb_ci_server, cmdb_ci_appl, cmdb_ci_linux_server, cmdb_ci_win_server, cmdb_ci_db_instance).',
      params: { type: 'object', properties: { className: { type: 'string', description: 'CMDB class name (default: cmdb_ci). Common: cmdb_ci_server, cmdb_ci_appl, cmdb_ci_linux_server, cmdb_ci_win_server, cmdb_ci_db_instance, cmdb_ci_network_host' }, query: { type: 'string', description: 'Encoded query filter for the CMDB class, e.g. "operational_status=1" (operational), "nameLIKEprod"' }, limit: { type: 'number', description: 'Max results (default: 50)' } } },
      fn: async (_c, inp) => ok(await p.listCMDBItems(config, inp.arguments['className'] as string, inp.arguments['query'] as string, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.users`, desc: 'Search ServiceNow users (sys_user table) by name. Matches against user_name, first_name, last_name, and email using LIKE operator. Returns user records with sys_id, user_name, email, first_name, last_name, department, title, active status.',
      params: { type: 'object', properties: { query: { type: 'string', description: 'Search text to match against user name fields (e.g. "John", "admin", "john.doe@company.com")' }, limit: { type: 'number', description: 'Max results (default: 20)' } }, required: ['query'] },
      fn: async (_c, inp) => ok(await p.searchUsers(String(inp.arguments['query']), config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.knowledge`, desc: 'Search ServiceNow knowledge base articles (kb_knowledge table). Matches against article text content using LIKE operator. Returns articles with sys_id, short_description, text, workflow_state, kb_knowledge_base, article_type, category.',
      params: { type: 'object', properties: { query: { type: 'string', description: 'Search text to find in knowledge articles (e.g. "password reset", "VPN setup", "onboarding")' }, limit: { type: 'number', description: 'Max results (default: 20)' } }, required: ['query'] },
      fn: async (_c, inp) => ok(await p.searchKnowledge(String(inp.arguments['query']), config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.catalog`, desc: 'List available items in the ServiceNow Service Catalog. Returns catalog items that end users can request/order — includes name, short_description, category, price, delivery_time, sys_id. Use orderCatalog to submit a request for an item.',
      params: { type: 'object', properties: { limit: { type: 'number', description: 'Max items to return (default: 50)' } } },
      fn: async (_c, inp) => ok(await p.listCatalogItems(config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.orderCatalog`, desc: 'Submit an order/request for a Service Catalog item. Creates a request (sc_request) with request items (sc_req_item). Pass the catalog item sys_id and any required variables (form fields defined on the item). Returns the order/request record with tracking number.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the catalog item to order (get from catalog listing)' }, variables: { type: 'object', description: 'Key-value pairs for catalog item variables/form fields. Keys are the variable names defined on the item.' } }, required: ['id'] },
      fn: async (_c, inp) => ok(await p.orderCatalogItem(String(inp.arguments['id']), (inp.arguments['variables'] as Record<string, unknown>) ?? {}, config)) }),
    buildTool({ name: `${prefix}.aggregate`, desc: 'Run an aggregate/statistics query on a ServiceNow table. Returns grouped counts (like SQL GROUP BY with COUNT). Useful for dashboards, reports, and summary statistics — e.g. count incidents by priority, count changes by state.',
      params: { type: 'object', properties: { table: { type: 'string', description: 'Table to aggregate, e.g. incident, change_request, problem, sc_req_item' }, query: { type: 'string', description: 'Encoded query to filter records before aggregation, e.g. "active=true", "sys_created_on>=javascript:gs.beginningOfLastMonth()"' }, groupBy: { type: 'string', description: 'Field to group results by, e.g. priority, state, category, assignment_group' } }, required: ['table', 'query', 'groupBy'] },
      fn: async (_c, inp) => ok(await p.aggregate(String(inp.arguments['table']), String(inp.arguments['query']), String(inp.arguments['groupBy']), config)) }),
    ...(includeExtended ? serviceNowExtendedTools(prefix, config, p) : []),
  ];
}

/* ---------- Canva extended tools ---------- */
function canvaTools(prefix: string, config: EnterpriseConnectorConfig): Tool[] {
  const p = CANVA;
  return [
    buildTool({ name: `${prefix}.query`, desc: 'Search Canva designs by name or keyword. Returns matching design objects with ID, title, thumbnail URL, and creation date.', params: QUERY_PARAMS,
      fn: async (_c, inp) => ok(await p.query({ query: String(inp.arguments['query']), limit: inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined }, config)) }),
    buildTool({ name: `${prefix}.get`, desc: 'Get detailed information about a specific Canva design by its ID. Returns title, owner, page count, thumbnail, URLs, created/updated timestamps.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Canva design ID' } }, required: ['id'] },
      fn: async (_c, inp) => ok(await p.get(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.create`, desc: 'Create a new Canva design. Specify design type, title, and optional dimensions. Supported design_type values include: Presentation, Poster, SocialMedia, Document, Whiteboard, A4Document.',
      params: { type: 'object', properties: { data: { type: 'object', description: 'Design creation data: { design_type: string, title: string, width?: number, height?: number }' } }, required: ['data'] },
      fn: async (_c, inp) => ok(await p.create(inp.arguments['data'] as Record<string, unknown>, config)) }),
    buildTool({ name: `${prefix}.designs`, desc: 'List all Canva designs owned by the authenticated user. Supports pagination via continuation token. Returns design ID, title, type, thumbnail, and timestamps.',
      params: { type: 'object', properties: { limit: { type: 'number', description: 'Max designs to return per page' }, continuation: { type: 'string', description: 'Continuation token from previous response for pagination' } } },
      fn: async (_c, inp) => ok(await p.listDesigns(config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined, inp.arguments['continuation'] as string)) }),
    buildTool({ name: `${prefix}.export`, desc: 'Export a Canva design to a downloadable file format. Starts an async export job — use getExport to check status and get the download URL when complete.',
      params: { type: 'object', properties: { designId: { type: 'string', description: 'ID of the design to export' }, format: { type: 'string', description: 'Export format: pdf, png, jpg, pptx, mp4, or gif' } }, required: ['designId', 'format'] },
      fn: async (_c, inp) => ok(await p.createExport(String(inp.arguments['designId']), inp.arguments['format'] as 'pdf' | 'png' | 'jpg' | 'pptx' | 'mp4' | 'gif', config)) }),
    buildTool({ name: `${prefix}.getExport`, desc: 'Check the status of a Canva export job. Returns status (in_progress, completed, failed) and download URL when complete. Poll this after calling export.',
      params: { type: 'object', properties: { exportId: { type: 'string', description: 'Export job ID returned by the export tool' } }, required: ['exportId'] },
      fn: async (_c, inp) => ok(await p.getExport(String(inp.arguments['exportId']), config)) }),
    buildTool({ name: `${prefix}.assets`, desc: 'List uploaded assets (images, videos, audio) in the Canva account. These are reusable media files that can be inserted into designs. Supports pagination.',
      params: { type: 'object', properties: { limit: { type: 'number', description: 'Max assets to return per page' }, continuation: { type: 'string', description: 'Continuation token for pagination' } } },
      fn: async (_c, inp) => ok(await p.listAssets(config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined, inp.arguments['continuation'] as string)) }),
    buildTool({ name: `${prefix}.getAsset`, desc: 'Get details of a specific Canva asset by ID. Returns name, type (image/video/audio), thumbnail URL, and metadata.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Asset ID' } }, required: ['id'] },
      fn: async (_c, inp) => ok(await p.getAsset(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.uploadAsset`, desc: 'Upload a media file to Canva by URL. The file is downloaded from the provided URL and stored as a reusable asset. Supports images (PNG, JPG, SVG), videos (MP4), and audio files.',
      params: { type: 'object', properties: { name: { type: 'string', description: 'Display name for the uploaded asset' }, url: { type: 'string', description: 'Public URL of the file to upload (must be directly accessible)' } }, required: ['name', 'url'] },
      fn: async (_c, inp) => ok(await p.uploadAsset(String(inp.arguments['name']), String(inp.arguments['url']), config)) }),
    buildTool({ name: `${prefix}.deleteAsset`, desc: 'Permanently delete an uploaded asset from the Canva account. This is irreversible. Designs already using the asset are not affected.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Asset ID to delete' } }, required: ['id'] },
      fn: async (_c, inp) => { await p.deleteAsset(String(inp.arguments['id']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.folders`, desc: 'List folders in the Canva account. Folders organize designs and assets. Supports pagination. Returns folder ID, name, and item count.',
      params: { type: 'object', properties: { limit: { type: 'number', description: 'Max folders to return per page' }, continuation: { type: 'string', description: 'Continuation token for pagination' } } },
      fn: async (_c, inp) => ok(await p.listFolders(config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined, inp.arguments['continuation'] as string)) }),
    buildTool({ name: `${prefix}.getFolder`, desc: 'Get details of a specific Canva folder including its name, item count, and parent folder.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Folder ID' } }, required: ['id'] },
      fn: async (_c, inp) => ok(await p.getFolder(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.createFolder`, desc: 'Create a new folder in Canva for organizing designs and assets. Optionally nest it inside a parent folder.',
      params: { type: 'object', properties: { name: { type: 'string', description: 'Folder name' }, parentFolderId: { type: 'string', description: 'Optional parent folder ID to create a nested folder' } }, required: ['name'] },
      fn: async (_c, inp) => ok(await p.createFolder(String(inp.arguments['name']), inp.arguments['parentFolderId'] as string, config)) }),
    buildTool({ name: `${prefix}.updateFolder`, desc: 'Rename an existing Canva folder.',
      params: { type: 'object', properties: { folderId: { type: 'string', description: 'Folder ID to rename' }, name: { type: 'string', description: 'New folder name' } }, required: ['folderId', 'name'] },
      fn: async (_c, inp) => ok(await p.updateFolder(String(inp.arguments['folderId']), String(inp.arguments['name']), config)) }),
    buildTool({ name: `${prefix}.deleteFolder`, desc: 'Permanently delete a Canva folder. Contents may be moved to root or deleted depending on Canva settings. This is irreversible.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Folder ID to delete' } }, required: ['id'] },
      fn: async (_c, inp) => { await p.deleteFolder(String(inp.arguments['id']), config); return ok({ success: true }); } }),
    buildTool({ name: `${prefix}.comments`, desc: 'List all comments on a Canva design. Returns comment text, author, creation date, and reply threads. Useful for collaboration tracking.',
      params: { type: 'object', properties: { designId: { type: 'string', description: 'Design ID to list comments for' }, limit: { type: 'number', description: 'Max comments to return' } }, required: ['designId'] },
      fn: async (_c, inp) => ok(await p.listComments(String(inp.arguments['designId']), config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.addComment`, desc: 'Add a new comment to a Canva design. Comments are visible to all collaborators on the design.',
      params: { type: 'object', properties: { designId: { type: 'string', description: 'Design ID to comment on' }, message: { type: 'string', description: 'Comment text' } }, required: ['designId', 'message'] },
      fn: async (_c, inp) => ok(await p.addComment(String(inp.arguments['designId']), String(inp.arguments['message']), config)) }),
    buildTool({ name: `${prefix}.replyComment`, desc: 'Reply to an existing comment on a Canva design, creating a threaded conversation. Requires both the design ID and the parent comment ID.',
      params: { type: 'object', properties: { designId: { type: 'string', description: 'Design ID' }, commentId: { type: 'string', description: 'Parent comment ID to reply to' }, message: { type: 'string', description: 'Reply text' } }, required: ['designId', 'commentId', 'message'] },
      fn: async (_c, inp) => ok(await p.replyToComment(String(inp.arguments['designId']), String(inp.arguments['commentId']), String(inp.arguments['message']), config)) }),
    buildTool({ name: `${prefix}.brandTemplates`, desc: 'List brand templates available in the Canva team/organization. Brand templates are pre-approved design templates that enforce brand consistency.',
      params: { type: 'object', properties: { limit: { type: 'number', description: 'Max templates to return' } } },
      fn: async (_c, inp) => ok(await p.listBrandTemplates(config, inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined)) }),
    buildTool({ name: `${prefix}.getBrandTemplate`, desc: 'Get detailed information about a specific brand template including title, thumbnail, and creation date.',
      params: { type: 'object', properties: { id: { type: 'string', description: 'Brand template ID' } }, required: ['id'] },
      fn: async (_c, inp) => ok(await p.getBrandTemplate(String(inp.arguments['id']), config)) }),
    buildTool({ name: `${prefix}.user`, desc: 'Get the currently authenticated Canva user profile. Returns display name, email, team information, and account type.',
      params: { type: 'object', properties: {} },
      fn: async () => ok(await p.getUser(config)) }),
  ];
}

/* ---------- main factory ---------- */

export interface EnterpriseToolsOptions {
  /** Include extended/full-coverage tools (e.g. 250+ ServiceNow tools). Default: true */
  includeExtended?: boolean;
}

export function createEnterpriseTools(
  configs: EnterpriseConnectorConfig[],
  extraProviders?: EnterpriseProvider[],
  options?: EnterpriseToolsOptions,
): Tool[] {
  const providerMap = new Map<string, EnterpriseProvider>();
  for (const p of [...BUILT_IN, ...(extraProviders ?? [])]) providerMap.set(p.type, p);

  const tools: Tool[] = [];

  for (const config of configs.filter(c => c.enabled)) {
    const prefix = `enterprise_${config.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    /* --- extended connectors with full API coverage --- */
    if (config.type === 'jira') {
      // Base query/get/create from JiraFullProvider
      const jp = JIRA_FULL;
      tools.push(buildTool({ name: `${prefix}.query`, desc: 'Search Jira issues using JQL (Jira Query Language). Examples: "project = PROJ AND status = Open", "assignee = currentUser() ORDER BY priority DESC", "labels = bug AND created >= -7d". Returns issue key, summary, status, priority, assignee, and more.',
        params: { type: 'object', properties: { query: { type: 'string', description: 'JQL query string (e.g. "project = PROJ AND status != Done")' }, limit: { type: 'number', description: 'Max issues to return (default: 50)' } }, required: ['query'] },
        fn: async (_c, inp) => ok(await jp.query({ query: String(inp.arguments['query']), limit: inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined }, config)) }));
      tools.push(buildTool({ name: `${prefix}.get`, desc: 'Get a single Jira issue by key (e.g. PROJ-123) or ID. Returns all fields: summary, description, status, priority, assignee, reporter, created, updated, comments, attachments, custom fields.',
        params: { type: 'object', properties: { id: { type: 'string', description: 'Issue key (e.g. PROJ-123) or numeric issue ID' } }, required: ['id'] },
        fn: async (_c, inp) => ok(await jp.get(String(inp.arguments['id']), config)) }));
      tools.push(buildTool({ name: `${prefix}.create`, desc: 'Create a new Jira issue. Required fields: project key, issue type, and summary. Common fields: description (ADF format), priority, assignee, labels, components, custom fields. Returns the created issue with its key.',
        params: { type: 'object', properties: { data: { type: 'object', description: 'Issue fields: { fields: { project: { key: "PROJ" }, issuetype: { name: "Bug" }, summary: "Title", description: {...}, priority: { name: "High" }, assignee: { accountId: "..." }, labels: [...] } }' } }, required: ['data'] },
        fn: async (_c, inp) => ok(await jp.create(inp.arguments['data'] as Record<string, unknown>, config)) }));
      tools.push(...jiraExtendedTools(prefix, config));
      continue;
    }

    if (config.type === 'servicenow') {
      tools.push(...serviceNowTools(prefix, config, options?.includeExtended ?? true));
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
        name: `${prefix}_query`,
        description: `Search or query records from the ${config.type} connector "${config.name}". Pass a search string and optional limit. Returns matching records.`,
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
        name: `${prefix}_get`,
        description: `Get a single record by ID from the ${config.type} connector "${config.name}". Returns full record details.`,
        parameters: GET_PARAMS,
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const result = await provider.get(String(input.arguments['id']), config);
        return { content: JSON.stringify(result) };
      },
    });

    tools.push({
      schema: {
        name: `${prefix}_create`,
        description: `Create a new record in the ${config.type} connector "${config.name}". Pass a data object with the record fields.`,
        parameters: { type: 'object', properties: { data: { type: 'object', description: 'Record data' } }, required: ['data'] },
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const params = { type: 'object', properties: { data: { type: 'object' } }, required: ['data'] };
        const norm = normalizeArgs(params, input.arguments);
        const data = norm['data'] as Record<string, unknown>;
        const result = await provider.create(data, config);
        return { content: JSON.stringify(result) };
      },
    });
  }

  return tools;
}

/* ---------- grouped tool factory (for multi-agent / supervisor) ---------- */

export interface EnterpriseToolGroup {
  /** Short identifier like "itsm-operations" or "cmdb-infrastructure" */
  name: string;
  /** Natural language description used by the supervisor to route */
  description: string;
  /** Tools assigned to this group's worker agent */
  tools: Tool[];
}

/**
 * Creates enterprise tools partitioned into domain-specific groups.
 * Each group becomes a supervisor worker agent with focused tools.
 * The base CRUD tools (query, get, create, update, patch, delete, etc.)
 * are included in EVERY group so each worker can do basic lookups.
 */
export function createEnterpriseToolGroups(
  configs: EnterpriseConnectorConfig[],
  extraProviders?: EnterpriseProvider[],
): EnterpriseToolGroup[] {
  const providerMap = new Map<string, EnterpriseProvider>();
  for (const p of [...BUILT_IN, ...(extraProviders ?? [])]) providerMap.set(p.type, p);

  const groups: EnterpriseToolGroup[] = [];

  for (const config of configs.filter(c => c.enabled)) {
    const prefix = `enterprise_${config.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    if (config.type === 'servicenow') {
      // Base tools shared across all workers
      const baseTools = serviceNowTools(prefix, config, false);
      // Domain-specific groups from extended tools
      const snGroups = serviceNowToolGroups(prefix, config, SERVICENOW);
      for (const g of snGroups) {
        groups.push({
          name: `servicenow-${g.name}`,
          description: `[ServiceNow] ${g.description}`,
          tools: [...baseTools, ...g.tools],
        });
      }
      continue;
    }

    // Non-ServiceNow connectors: single group per connector
    if (config.type === 'jira') {
      const jp = JIRA_FULL;
      const baseJira = [
        buildTool({ name: `${prefix}.query`, desc: 'Search Jira issues using JQL.', params: QUERY_PARAMS,
          fn: async (_c, inp) => ok(await jp.query({ query: String(inp.arguments['query']), limit: inp.arguments['limit'] ? Number(inp.arguments['limit']) : undefined }, config)) }),
        buildTool({ name: `${prefix}.get`, desc: 'Get a Jira issue by key or ID.', params: GET_PARAMS,
          fn: async (_c, inp) => ok(await jp.get(String(inp.arguments['id']), config)) }),
        buildTool({ name: `${prefix}.create`, desc: 'Create a Jira issue.',
          params: { type: 'object', properties: { data: { type: 'object', description: 'Issue fields' } }, required: ['data'] },
          fn: async (_c, inp) => ok(await jp.create(inp.arguments['data'] as Record<string, unknown>, config)) }),
        ...jiraExtendedTools(prefix, config),
      ];
      groups.push({ name: `jira-${config.name}`, description: `[Jira] Issue tracking, sprints, boards, comments, worklogs for "${config.name}".`, tools: baseJira });
      continue;
    }

    if (config.type === 'canva') {
      groups.push({ name: `canva-${config.name}`, description: `[Canva] Design management, export, assets, folders, comments for "${config.name}".`, tools: canvaTools(prefix, config) });
      continue;
    }

    // Legacy connectors
    const provider = providerMap.get(config.type);
    if (!provider) continue;
    const legacyTools: Tool[] = [
      { schema: { name: `${prefix}_query`, description: `Search records from ${config.type} "${config.name}".`, parameters: QUERY_PARAMS },
        async invoke(_ctx, input) { return { content: JSON.stringify(await provider.query({ query: String(input.arguments['query']), limit: input.arguments['limit'] ? Number(input.arguments['limit']) : undefined }, config)) }; } },
      { schema: { name: `${prefix}_get`, description: `Get a record by ID from ${config.type} "${config.name}".`, parameters: GET_PARAMS },
        async invoke(_ctx, input) { return { content: JSON.stringify(await provider.get(String(input.arguments['id']), config)) }; } },
      { schema: { name: `${prefix}_create`, description: `Create a record in ${config.type} "${config.name}".`,
        parameters: { type: 'object', properties: { data: { type: 'object', description: 'Record data' } }, required: ['data'] } },
        async invoke(_ctx, input) { const norm = normalizeArgs({ type: 'object', properties: { data: { type: 'object' } } }, input.arguments); return { content: JSON.stringify(await provider.create(norm['data'] as Record<string, unknown>, config)) }; } },
    ];
    groups.push({ name: `${config.type}-${config.name}`, description: `[${config.type}] Records from "${config.name}".`, tools: legacyTools });
  }

  return groups;
}
