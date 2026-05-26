/**
 * ServiceNow extended MCP tool registrations (Phases 1–13)
 *
 * Complements the 17 base tools in mcp.ts with ~250 additional tools that
 * cover the full ServiceNow REST API surface.  Every tool carries a rich
 * description and typed parameter schema so that AI agents can discover
 * and invoke the right tool without ambiguity.
 */
import type { Tool } from '@weaveintel/core';
import type { EnterpriseConnectorConfig } from './types.js';
import type { ServiceNowProvider } from './connectors/servicenow.js';

import { phase0, phase1, phase2, phase3, phase4, phase5, phase6 } from './tools/servicenow-tools-1.js';
import { phase7, phase8, phase9, phase10, phase11, phase12, phase13 } from './tools/servicenow-tools-2.js';

/* ================================================================
 *  PUBLIC EXPORT — All extended tools combined
 * ================================================================ */
export function serviceNowExtendedTools(
  prefix: string,
  config: EnterpriseConnectorConfig,
  provider: ServiceNowProvider,
): Tool[] {
  return [
    ...phase0(prefix, config, provider),
    ...phase1(prefix, config, provider),
    ...phase2(prefix, config, provider),
    ...phase3(prefix, config, provider),
    ...phase4(prefix, config, provider),
    ...phase5(prefix, config, provider),
    ...phase6(prefix, config, provider),
    ...phase7(prefix, config, provider),
    ...phase8(prefix, config, provider),
    ...phase9(prefix, config, provider),
    ...phase10(prefix, config, provider),
    ...phase11(prefix, config, provider),
    ...phase12(prefix, config, provider),
    ...phase13(prefix, config, provider),
  ];
}

/* ================================================================
 *  PUBLIC EXPORT — Extended tools partitioned into domain groups
 *
 *  Each group becomes a supervisor worker agent with a focused
 *  toolset (~15-30 tools), keeping token counts manageable while
 *  providing full coverage across all 250+ ServiceNow operations.
 * ================================================================ */

export interface ServiceNowToolGroup {
  name: string;
  description: string;
  tools: Tool[];
}

/** Tool-name suffixes for each domain group */
const DOMAIN_GROUPS: { name: string; description: string; suffixes: string[] }[] = [
  {
    name: 'itsm-operations',
    description: 'IT Service Management — manage incidents (update, resolve, close, escalate, reassign, tasks), problems (create, update, known errors), customer service cases, HR cases, interactions, and task SLAs.',
    suffixes: [
      'updateIncident', 'createProblem', 'resolveIncident', 'closeIncident',
      'reassignIncident', 'escalateIncident', 'listIncidentTasks', 'createIncidentTask',
      'getProblem', 'updateProblem', 'listKnownErrors', 'createKnownError',
      'listTaskSLAs', 'getTaskSLA', 'pauseTaskSLA', 'resumeTaskSLA',
      'listCases', 'getCase', 'createCase', 'updateCase',
      'listHRCases', 'getHRCase', 'createHRCase',
      'createInteraction', 'getInteraction',
    ],
  },
  {
    name: 'user-identity',
    description: 'User & Identity Management — SCIM 2.0 user/group provisioning and deprovisioning, role assignments, group membership management.',
    suffixes: [
      'getUser', 'scimListUsers', 'scimGetUser', 'scimCreateUser', 'scimUpdateUser', 'scimDeleteUser',
      'scimListGroups', 'scimGetGroup', 'scimCreateGroup', 'scimUpdateGroup',
      'listUserRoles', 'assignUserRole', 'removeUserRole',
      'listGroupMembers', 'addGroupMember', 'removeGroupMember',
    ],
  },
  {
    name: 'cmdb-infrastructure',
    description: 'CMDB & Infrastructure — Configuration Item CRUD, CI relationships and dependency mapping, identification API, class schemas, cloud resource discovery.',
    suffixes: [
      'getCMDBItem', 'cmdbGetCI', 'cmdbCreateCI', 'cmdbUpdateCI', 'cmdbDeleteCI',
      'cmdbGetRelationships', 'cmdbCreateRelationship', 'cmdbDeleteRelationship',
      'cmdbIdentifyCI', 'cmdbListClasses', 'cmdbGetClassSchema',
      'cloudListResources', 'cloudGetResource',
    ],
  },
  {
    name: 'service-catalog',
    description: 'Service Catalog & Fulfillment — browse catalogs/categories/items, view item variables, manage shopping cart, submit orders, track requests and approvals.',
    suffixes: [
      'getCatalogItem', 'listCatalogs', 'getCatalog', 'listCategories', 'getCategory',
      'getCatalogItemVariables', 'getCatalogItemVariableSet',
      'addToCart', 'getCart', 'updateCartItem', 'deleteCartItem', 'checkoutCart', 'emptyCart',
      'listRequests', 'getRequest', 'listRequestItems', 'getRequestItem',
      'listApprovals', 'getApproval', 'approveRequest', 'rejectRequest',
    ],
  },
  {
    name: 'change-release',
    description: 'Change & Release Management — change requests, change tasks, scheduling and conflict detection, DevOps pipelines and artifacts, application repository, update sets for instance migration.',
    suffixes: [
      'getChangeRequest', 'updateChangeRequest', 'listChangeTasks', 'createChangeTask', 'updateChangeTask',
      'getChangeSchedule', 'checkChangeConflict',
      'devopsListPipelines', 'devopsGetPipeline', 'devopsCreateChangeFromPipeline',
      'devopsGetArtifact', 'devopsListArtifactVersions',
      'appRepoListApps', 'appRepoInstall', 'appRepoGetAvailableUpdates', 'appRepoRollback',
      'listUpdateSets', 'getUpdateSet', 'createUpdateSet', 'commitUpdateSet',
      'retrieveUpdateSet', 'previewUpdateSet', 'applyUpdateSet',
    ],
  },
  {
    name: 'knowledge-comms',
    description: 'Knowledge, Content & Communication — knowledge bases and articles, file attachments, email, notifications, inbound email actions.',
    suffixes: [
      'listAttachments', 'getAttachment', 'downloadAttachment', 'uploadAttachment', 'deleteAttachment',
      'sendEmail', 'listEmails',
      'listKnowledgeBases', 'createKnowledgeBase',
      'createKnowledgeArticle', 'updateKnowledgeArticle', 'publishKnowledgeArticle', 'retireKnowledgeArticle',
      'listNotifications', 'createNotification', 'updateNotification', 'deleteNotification', 'testNotification',
      'listInboundEmailActions', 'createInboundEmailAction', 'updateInboundEmailAction',
    ],
  },
  {
    name: 'automation-workflows',
    description: 'Automation & Workflows — Flow Designer flows, actions, subflows, legacy workflows, MID servers, business rules, client scripts, scheduled jobs and scripts.',
    suffixes: [
      'listFlows', 'getFlow', 'triggerFlow', 'getFlowExecution', 'listFlowExecutions',
      'listActions', 'executeAction', 'getActionExecution',
      'createFlowRecord', 'updateFlowRecord', 'activateFlow', 'deactivateFlow',
      'getFlowDefinition', 'addFlowAction', 'removeFlowAction',
      'listSubflows', 'createSubflow',
      'listWorkflows', 'getWorkflow', 'createWorkflow', 'publishWorkflow',
      'listMidServers', 'getMidServer',
      'listBusinessRules', 'createBusinessRule', 'updateBusinessRule', 'toggleBusinessRule',
      'listClientScripts', 'createClientScript', 'updateClientScript', 'toggleClientScript',
      'listScheduledJobs', 'getScheduledJob', 'createScheduledJob', 'toggleScheduledJob',
      'listScheduledScripts', 'createScheduledScript', 'updateScheduledScript', 'toggleScheduledScript',
    ],
  },
  {
    name: 'security-compliance',
    description: 'Security & Compliance — security incidents, vulnerabilities, observables/IOCs, ACLs, audit/system/transaction logs, scripted REST APIs.',
    suffixes: [
      'listSecurityIncidents', 'getSecurityIncident', 'createSecurityIncident', 'updateSecurityIncident',
      'listVulnerabilities', 'listObservables', 'addObservable',
      'listACLs', 'getACL', 'createACL',
      'listAuditLogs', 'listSystemLogs', 'listTransactionLogs',
      'callScriptedREST', 'listScriptedRESTApis',
    ],
  },
  {
    name: 'analytics-ai',
    description: 'Analytics & AI — Performance Analytics scorecards/indicators, reports, dashboards, NLU models and prediction, Virtual Agent conversations, Predictive Intelligence classification and similarity.',
    suffixes: [
      'paGetScorecard', 'paListIndicators', 'paGetIndicatorScores', 'paGetBreakdown',
      'listReports', 'getReport', 'runReport', 'listDashboards', 'getDashboard',
      'nluPredict', 'nluListModels', 'nluGetModel', 'nluAddTrainingData',
      'vaListTopics', 'vaStartConversation', 'vaSendMessage',
      'piClassify', 'piSimilarity', 'piGetSolution',
    ],
  },
  {
    name: 'platform-admin',
    description: 'Platform Administration — system properties, plugins, table schema/dictionary, data import/export, app scopes, navigation modules, Service Portal pages/widgets, UI policies, data policies, script includes, UI actions, catalog item/variable administration, record producers, approval/assignment rules, SLA definitions.',
    suffixes: [
      'batchRequest', 'getProperty', 'setProperty', 'listProperties',
      'listPlugins', 'activatePlugin',
      'listTables', 'getTableSchema', 'createTable', 'addColumn', 'updateColumn',
      'listChoices', 'addChoice', 'updateChoice',
      'importSetInsert', 'importSetGetStatus', 'importSetTransform',
      'importCSV', 'importExcel', 'exportTable', 'listTransformMaps', 'getTransformMap',
      'listAppScopes', 'createAppScope', 'listModules', 'createModule', 'updateModule',
      'listPortalPages', 'createPortalPage', 'listWidgets', 'createWidget', 'updateWidget',
      'listUIPolicies', 'createUIPolicy', 'updateUIPolicy', 'addUIPolicyAction', 'toggleUIPolicy',
      'listDataPolicies', 'createDataPolicy', 'updateDataPolicy',
      'listScriptIncludes', 'createScriptInclude', 'updateScriptInclude',
      'listUIActions', 'createUIAction', 'updateUIAction', 'toggleUIAction',
      'createCatalogItemRecord', 'updateCatalogItemRecord', 'deleteCatalogItemRecord', 'cloneCatalogItemRecord',
      'listCatalogVariablesAdmin', 'createCatalogVariable', 'updateCatalogVariable', 'deleteCatalogVariable', 'reorderCatalogVariables',
      'listVariableSets', 'createVariableSet', 'addVariableToSet', 'attachVariableSet', 'detachVariableSet',
      'listRecordProducers', 'createRecordProducer', 'updateRecordProducer', 'deleteRecordProducer',
      'listApprovalRules', 'createApprovalRule', 'updateApprovalRule',
      'listAssignmentRules', 'createAssignmentRule', 'updateAssignmentRule',
      'listSLADefinitions', 'createSLADefinition', 'updateSLADefinition',
    ],
  },
];

/**
 * Returns ServiceNow extended tools partitioned into domain-specific groups.
 * Each group maps to a supervisor worker agent.
 */
export function serviceNowToolGroups(
  prefix: string,
  config: EnterpriseConnectorConfig,
  provider: ServiceNowProvider,
): ServiceNowToolGroup[] {
  const allTools = serviceNowExtendedTools(prefix, config, provider);
  const safePrefix = prefix.replace(/\./g, '_') + '_';

  // Build suffix → group-index lookup
  const suffixMap = new Map<string, number>();
  for (let i = 0; i < DOMAIN_GROUPS.length; i++) {
    const group = DOMAIN_GROUPS[i]!;
    for (const suffix of group.suffixes) suffixMap.set(suffix, i);
  }

  // Partition tools into groups
  const buckets: Tool[][] = DOMAIN_GROUPS.map(() => [] as Tool[]);
  const unclaimed: Tool[] = [];

  for (const tool of allTools) {
    const name = tool.schema.name;
    const suffix = name.startsWith(safePrefix) ? name.slice(safePrefix.length) : name;
    const idx = suffixMap.get(suffix);
    if (idx != null && buckets[idx]) {
      buckets[idx]!.push(tool);
    } else {
      unclaimed.push(tool);
    }
  }

  const groups: ServiceNowToolGroup[] = [];
  for (let i = 0; i < DOMAIN_GROUPS.length; i++) {
    const bucket = buckets[i]!;
    const domain = DOMAIN_GROUPS[i]!;
    if (bucket.length > 0) {
      groups.push({ name: domain.name, description: domain.description, tools: bucket });
    }
  }

  // Any tools not claimed by a domain group go into platform-admin
  if (unclaimed.length > 0) {
    const adminGroup = groups.find(g => g.name === 'platform-admin');
    if (adminGroup) {
      adminGroup.tools.push(...unclaimed);
    } else {
      groups.push({ name: 'platform-admin', description: 'Platform Administration — miscellaneous ServiceNow operations.', tools: unclaimed });
    }
  }

  return groups;
}
