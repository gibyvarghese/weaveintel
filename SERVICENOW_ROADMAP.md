# ServiceNow REST API — Full Implementation Roadmap

> **Philosophy: Configuration First, Customization with Approval**
>
> Every tool follows a strict hierarchy: prefer OOB configuration over scripting,
> prefer scripted configuration over custom app development, and require explicit
> approval before any customisation that touches base system behaviour.

---

## Phase 0 — Tool Description Enrichment (Foundation)

**Goal:** Make every existing tool discoverable by AI agents. Each tool gets a
rich `description` explaining *when* to use it, *what it does*, and *what fields
 to pass*. Every parameter gets a `description` field with valid values / examples.

**Scope:** All 94 existing tools (17 ServiceNow, 28 Jira, 21 Canva, plus base connectors).

| # | Task | Status |
|---|------|--------|
| 0.1 | Enrich ServiceNow tool descriptions (17 tools) | ✅ |
| 0.2 | Enrich ServiceNow parameter schemas with field-level descriptions | ✅ |
| 0.3 | Enrich Jira tool descriptions and parameters (28 tools) | ✅ |
| 0.4 | Enrich Canva tool descriptions and parameters (21 tools) | ✅ |
| 0.5 | Enrich base connector tool descriptions (Confluence, Salesforce, Notion) | ☐ |

---

## Phase 1 — Attachment, Batch, Email & SCIM APIs

**Goal:** File management, bulk operations, email integration, and user provisioning.

### 1A — Attachment API (`/api/now/attachment`)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 1.1 | `listAttachments` | GET | List attachments for a record (by table + sys_id) |
| 1.2 | `getAttachment` | GET | Get attachment metadata by sys_id |
| 1.3 | `downloadAttachment` | GET | Download attachment binary content |
| 1.4 | `uploadAttachment` | POST | Upload file attachment to a record |
| 1.5 | `deleteAttachment` | DELETE | Delete an attachment by sys_id |

### 1B — Batch API (`/api/now/batch`)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 1.6 | `batchRequest` | POST | Execute multiple REST calls in a single request |

### 1C — Email API (`/api/now/email`)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 1.7 | `sendEmail` | POST | Send an email through ServiceNow |
| 1.8 | `listEmails` | GET | Query email records (sys_email table) |

### 1D — SCIM API (`/api/now/scim`)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 1.9 | `scimListUsers` | GET | List users via SCIM 2.0 protocol |
| 1.10 | `scimGetUser` | GET | Get a SCIM user by ID |
| 1.11 | `scimCreateUser` | POST | Provision a new user via SCIM |
| 1.12 | `scimUpdateUser` | PUT | Update a SCIM user |
| 1.13 | `scimDeleteUser` | DELETE | Deprovision a SCIM user |
| 1.14 | `scimListGroups` | GET | List groups via SCIM |
| 1.15 | `scimGetGroup` | GET | Get a SCIM group |
| 1.16 | `scimCreateGroup` | POST | Create a SCIM group |
| 1.17 | `scimUpdateGroup` | PUT | Update a SCIM group |

### 1E — User Role Inheritance API
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 1.18 | `listUserRoles` | GET | List roles for a user (sys_user_has_role) |
| 1.19 | `assignUserRole` | POST | Assign a role to a user |
| 1.20 | `removeUserRole` | DELETE | Remove a role from a user |
| 1.21 | `listGroupMembers` | GET | List members of a group |
| 1.22 | `addGroupMember` | POST | Add a user to a group |
| 1.23 | `removeGroupMember` | DELETE | Remove a user from a group |

**Tools: 23** | **Running Total: 40 (17 existing + 23 new)** | **Status: ✅ Implemented**

---

## Phase 2 — CMDB, Discovery & Cloud Management APIs

**Goal:** Deep configuration management database operations and cloud resource tracking.

### 2A — CMDB API (`/api/now/cmdb`)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 2.1 | `cmdbGetCI` | GET | Get a CI with full relationships |
| 2.2 | `cmdbCreateCI` | POST | Create a new configuration item |
| 2.3 | `cmdbUpdateCI` | PATCH | Update CI attributes |
| 2.4 | `cmdbDeleteCI` | DELETE | Delete a configuration item |
| 2.5 | `cmdbGetRelationships` | GET | List relationships for a CI |
| 2.6 | `cmdbCreateRelationship` | POST | Create relationship between CIs |
| 2.7 | `cmdbDeleteRelationship` | DELETE | Remove a CI relationship |
| 2.8 | `cmdbIdentifyCI` | POST | Identify/reconcile a CI via IRE rules |

### 2B — CMDB Meta API
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 2.9 | `cmdbListClasses` | GET | List CMDB classes and hierarchy |
| 2.10 | `cmdbGetClassSchema` | GET | Get attributes/schema for a CMDB class |

### 2C — Cloud Discovery
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 2.11 | `cloudListResources` | GET | List discovered cloud resources |
| 2.12 | `cloudGetResource` | GET | Get cloud resource details |

**Tools: 12** | **Running Total: 52** | **Status: ✅ Implemented**

---

## Phase 3 — Import Set, CSV & Transform Map APIs

**Goal:** Bulk data import/export, data transformation, and ETL operations.

### 3A — Import Set API (`/api/now/import`)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 3.1 | `importSetInsert` | POST | Insert records into an import set table |
| 3.2 | `importSetGetStatus` | GET | Check import staging status |
| 3.3 | `importSetTransform` | POST | Trigger transform map to move staged data to target |

### 3B — CSV / Excel Import
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 3.4 | `importCSV` | POST | Upload CSV and load into import set |
| 3.5 | `importExcel` | POST | Upload Excel and load into import set |

### 3C — Export
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 3.6 | `exportTable` | GET | Export table records as CSV/JSON/XML |

### 3D — Transform Map Management
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 3.7 | `listTransformMaps` | GET | List transform maps for an import set table |
| 3.8 | `getTransformMap` | GET | Get transform map details |

**Tools: 8** | **Running Total: 60** | **Status: ✅ Implemented**

---

## Phase 4 — Service Catalog Deep APIs

**Goal:** Full catalog lifecycle — categories, variables, cart, requests, approvals.

### 4A — Catalog Categories
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 4.1 | `listCatalogs` | GET | List service catalogs |
| 4.2 | `getCatalog` | GET | Get a catalog by sys_id |
| 4.3 | `listCategories` | GET | List categories for a catalog |
| 4.4 | `getCategory` | GET | Get category details |

### 4B — Catalog Item Variables
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 4.5 | `getCatalogItemVariables` | GET | List variables for a catalog item |
| 4.6 | `getCatalogItemVariableSet` | GET | Get variable set details for an item |

### 4C — Cart & Checkout
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 4.7 | `addToCart` | POST | Add a catalog item to the cart |
| 4.8 | `getCart` | GET | Get current cart contents |
| 4.9 | `updateCartItem` | PATCH | Update cart item quantity/variables |
| 4.10 | `deleteCartItem` | DELETE | Remove an item from cart |
| 4.11 | `checkoutCart` | POST | Submit the cart as a request |
| 4.12 | `emptyCart` | DELETE | Empty the shopping cart |

### 4D — Request & Request Items
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 4.13 | `listRequests` | GET | List service requests (sc_request) |
| 4.14 | `getRequest` | GET | Get request details |
| 4.15 | `listRequestItems` | GET | List items within a request (sc_req_item) |
| 4.16 | `getRequestItem` | GET | Get request item details with variables |

### 4E — Approvals
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 4.17 | `listApprovals` | GET | List pending approvals (sysapproval_approver) |
| 4.18 | `getApproval` | GET | Get approval record details |
| 4.19 | `approveRequest` | PATCH | Approve a pending approval |
| 4.20 | `rejectRequest` | PATCH | Reject a pending approval |

**Tools: 20** | **Running Total: 80** | **Status: ✅ Implemented**

---

## Phase 5 — Change Management, Problem & SLA APIs

**Goal:** Full ITIL change/problem lifecycle and SLA tracking.

### 5A — Change Management Deep
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 5.1 | `getChangeRequest` | GET | Get change with all tasks and approvals |
| 5.2 | `updateChangeRequest` | PATCH | Update change request fields |
| 5.3 | `listChangeTasks` | GET | List tasks for a change request |
| 5.4 | `createChangeTask` | POST | Create a change task |
| 5.5 | `updateChangeTask` | PATCH | Update a change task |
| 5.6 | `getChangeSchedule` | GET | Get change blackout/maintenance windows |
| 5.7 | `checkChangeConflict` | POST | Check change schedule conflicts |

### 5B — Problem Management Deep
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 5.8 | `getProblem` | GET | Get problem with root cause analysis |
| 5.9 | `updateProblem` | PATCH | Update problem fields |
| 5.10 | `listKnownErrors` | GET | List known error records |
| 5.11 | `createKnownError` | POST | Create a known error from a problem |

### 5C — SLA API (`/api/now/sla`)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 5.12 | `listTaskSLAs` | GET | List SLA records attached to tasks |
| 5.13 | `getTaskSLA` | GET | Get SLA details (breach time, % elapsed) |
| 5.14 | `pauseTaskSLA` | PATCH | Pause an SLA timer |
| 5.15 | `resumeTaskSLA` | PATCH | Resume a paused SLA timer |

**Tools: 15** | **Running Total: 95** | **Status: ✅ Implemented**

---

## Phase 6 — Security Operations & Scripted REST

**Goal:** Security incident response and custom API endpoint access.

### 6A — Security Incident Response (SIR)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 6.1 | `listSecurityIncidents` | GET | List security incidents (sn_si_incident) |
| 6.2 | `getSecurityIncident` | GET | Get a security incident |
| 6.3 | `createSecurityIncident` | POST | Create a security incident |
| 6.4 | `updateSecurityIncident` | PATCH | Update a security incident |
| 6.5 | `listVulnerabilities` | GET | List vulnerability items |
| 6.6 | `listObservables` | GET | List observables for a security incident |
| 6.7 | `addObservable` | POST | Add an observable to a security incident |

### 6B — Scripted REST API Access
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 6.8 | `callScriptedREST` | ANY | Call a custom scripted REST API endpoint |
| 6.9 | `listScriptedRESTApis` | GET | List available scripted REST API definitions |

**Tools: 9** | **Running Total: 104** | **Status: ✅ Implemented**

---

## Phase 7 — Performance Analytics & Reporting

**Goal:** Dashboards, scorecards, scheduled reports, and analytics queries.

### 7A — Performance Analytics API (`/api/now/pa`)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 7.1 | `paGetScorecard` | GET | Get a PA scorecard/indicator score |
| 7.2 | `paListIndicators` | GET | List performance analytics indicators |
| 7.3 | `paGetIndicatorScores` | GET | Get scores over time for an indicator |
| 7.4 | `paGetBreakdown` | GET | Get indicator breakdown by dimension |

### 7B — Report API
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 7.5 | `listReports` | GET | List saved reports (sys_report) |
| 7.6 | `getReport` | GET | Get a report definition |
| 7.7 | `runReport` | GET | Execute a report and get results |

### 7C — Dashboard API
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 7.8 | `listDashboards` | GET | List dashboards |
| 7.9 | `getDashboard` | GET | Get dashboard with widget details |

**Tools: 9** | **Running Total: 113** | **Status: ✅ Implemented**

---

## Phase 8 — Integration Hub, Flow Designer & Orchestration

**Goal:** Flow execution, IntegrationHub actions, mid-server orchestration.

### 8A — Flow Designer API
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 8.1 | `listFlows` | GET | List Flow Designer flows |
| 8.2 | `getFlow` | GET | Get flow definition and steps |
| 8.3 | `triggerFlow` | POST | Execute a flow with input variables |
| 8.4 | `getFlowExecution` | GET | Get flow execution status/results |
| 8.5 | `listFlowExecutions` | GET | List recent flow executions |

### 8B — IntegrationHub Actions
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 8.6 | `listActions` | GET | List IntegrationHub actions (spokes) |
| 8.7 | `executeAction` | POST | Execute an IntegrationHub action |
| 8.8 | `getActionExecution` | GET | Get action execution result |

### 8C — Orchestration / MID Server
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 8.9 | `listMidServers` | GET | List MID servers and status |
| 8.10 | `getMidServer` | GET | Get MID server details |

**Tools: 10** | **Running Total: 123** | **Status: ✅ Implemented**

---

## Phase 9 — ITSM Process APIs (Incident, Request, Interaction)

**Goal:** Deep ITSM process operations beyond basic CRUD.

### 9A — Incident Management Deep
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 9.1 | `resolveIncident` | PATCH | Resolve an incident (set state + resolution) |
| 9.2 | `closeIncident` | PATCH | Close a resolved incident |
| 9.3 | `reassignIncident` | PATCH | Reassign to different group/user |
| 9.4 | `escalateIncident` | PATCH | Escalate incident priority |
| 9.5 | `listIncidentTasks` | GET | List child tasks of an incident |
| 9.6 | `createIncidentTask` | POST | Create a child task on an incident |

### 9B — Customer Service Management (CSM)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 9.7 | `listCases` | GET | List CSM cases (sn_customerservice_case) |
| 9.8 | `getCase` | GET | Get a CSM case |
| 9.9 | `createCase` | POST | Create a CSM case |
| 9.10 | `updateCase` | PATCH | Update a CSM case |

### 9C — HR Service Delivery
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 9.11 | `listHRCases` | GET | List HR cases (sn_hr_core_case) |
| 9.12 | `getHRCase` | GET | Get an HR case |
| 9.13 | `createHRCase` | POST | Create an HR case |

### 9D — Interaction Management
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 9.14 | `createInteraction` | POST | Create an interaction record |
| 9.15 | `getInteraction` | GET | Get interaction details |

**Tools: 15** | **Running Total: 138** | **Status: ✅ Implemented**

---

## Phase 10 — DevOps, CI/CD & Application Repository APIs

**Goal:** DevOps Change Velocity, pipeline integration, app repository.

### 10A — DevOps APIs
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 10.1 | `devopsListPipelines` | GET | List DevOps pipelines |
| 10.2 | `devopsGetPipeline` | GET | Get pipeline details |
| 10.3 | `devopsCreateChangeFromPipeline` | POST | Auto-create change request from pipeline |
| 10.4 | `devopsGetArtifact` | GET | Get artifact version details |
| 10.5 | `devopsListArtifactVersions` | GET | List versions for an artifact |

### 10B — Application Repository API
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 10.6 | `appRepoListApps` | GET | List applications in app repository |
| 10.7 | `appRepoInstall` | POST | Install an application from repo |
| 10.8 | `appRepoGetAvailableUpdates` | GET | Check for application updates |
| 10.9 | `appRepoRollback` | POST | Rollback an application to previous version |

### 10C — Update Set API
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 10.10 | `listUpdateSets` | GET | List update sets (sys_update_set) |
| 10.11 | `getUpdateSet` | GET | Get update set details |
| 10.12 | `createUpdateSet` | POST | Create a new update set |
| 10.13 | `commitUpdateSet` | POST | Commit/complete an update set |
| 10.14 | `retrieveUpdateSet` | POST | Retrieve a remote update set |
| 10.15 | `previewUpdateSet` | POST | Preview a retrieved update set |
| 10.16 | `applyUpdateSet` | POST | Apply a previewed update set |

**Tools: 16** | **Running Total: 154** | **Status: ✅ Implemented**

---

## Phase 11 — NLU, Virtual Agent & Conversational APIs

**Goal:** Natural language understanding, chatbot, and predictive intelligence.

### 11A — NLU API
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 11.1 | `nluPredict` | POST | Predict intent from text |
| 11.2 | `nluListModels` | GET | List NLU models |
| 11.3 | `nluGetModel` | GET | Get NLU model details |
| 11.4 | `nluAddTrainingData` | POST | Add training utterances |

### 11B — Virtual Agent API
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 11.5 | `vaListTopics` | GET | List Virtual Agent topics |
| 11.6 | `vaStartConversation` | POST | Start a VA conversation |
| 11.7 | `vaSendMessage` | POST | Send user message to VA |

### 11C — Predictive Intelligence
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 11.8 | `piClassify` | POST | Classify a record (category, assignment, priority) |
| 11.9 | `piSimilarity` | POST | Find similar records |
| 11.10 | `piGetSolution` | GET | Get AI-suggested solutions for a record |

**Tools: 10** | **Running Total: 164** | **Status: ✅ Implemented**

---

## Phase 12 — Admin, Governance & Platform APIs

**Goal:** System properties, ACLs, scheduled jobs, audit/logging, notifications admin.

### 12A — System Properties
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 12.1 | `getProperty` | GET | Get a system property value |
| 12.2 | `setProperty` | PUT | Set a system property (requires approval) |
| 12.3 | `listProperties` | GET | List system properties |

### 12B — ACL / Security Rules
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 12.4 | `listACLs` | GET | List access control rules (sys_security_acl) |
| 12.5 | `getACL` | GET | Get ACL details |
| 12.6 | `createACL` | POST | Create an ACL rule (requires approval) |

### 12C — Scheduled Jobs
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 12.7 | `listScheduledJobs` | GET | List scheduled jobs (sysauto) |
| 12.8 | `getScheduledJob` | GET | Get job details |
| 12.9 | `createScheduledJob` | POST | Create a scheduled job |
| 12.10 | `toggleScheduledJob` | PATCH | Enable/disable a scheduled job |

### 12D — Audit & System Logs
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 12.11 | `listAuditLogs` | GET | Query system audit log (sys_audit) |
| 12.12 | `listSystemLogs` | GET | Query system log (syslog) |
| 12.13 | `listTransactionLogs` | GET | Query transaction log (syslog_transaction) |

### 12E — Plugin Management
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 12.14 | `listPlugins` | GET | List installed plugins (v_plugin) |
| 12.15 | `activatePlugin` | POST | Activate a plugin (requires approval) |

**Tools: 15** | **Running Total: 179** | **Status: ✅ Implemented**

---

## Phase 13 — ServiceNow Development & Configuration Activities

> **⚠ Configuration First, Customisation with Approval**
>
> This phase implements the "builder" tools that let agents configure ServiceNow
> like a developer would — creating catalog items, record producers, flows, and
> notifications. All operations follow the principle:
>
> 1. **Configuration** — Use OOB records and system tables (no scripting)
> 2. **Light Customisation** — Business rules, client scripts, UI policies (flagged for review)
> 3. **Approval Required** — Any custom scripted REST API, script include, or ACL change
>
> Every mutation tool surfaces a `requiresApproval` flag so the agent framework
> can halt for human review before executing destructive or customisation operations.

### 13A — Service Catalog Item Management (sc_cat_item)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.1 | `createCatalogItem` | POST | Create a new catalog item (sc_cat_item). Sets name, short_description, category, workflow, active, availability, order_guide, price, delivery_plan. |
| 13.2 | `updateCatalogItem` | PATCH | Update catalog item fields (name, description, active status, category, workflow). |
| 13.3 | `deleteCatalogItem` | DELETE | Deactivate or delete a catalog item (deactivate preferred). |
| 13.4 | `cloneCatalogItem` | POST | Clone an existing catalog item with variables and variable sets. |
| 13.5 | `setCatalogItemCategory` | PATCH | Assign or change the category for a catalog item. |
| 13.6 | `setCatalogItemWorkflow` | PATCH | Assign a fulfillment workflow to a catalog item. |

### 13B — Catalog Variable Management (item_option_new)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.7 | `listCatalogVariables` | GET | List variables on a catalog item / record producer. |
| 13.8 | `createCatalogVariable` | POST | Create a variable on a catalog item. Types: Single Line Text, Select Box, Reference, Multi-line, CheckBox, Date, Macro, Label, Break, Container Start/End, etc. |
| 13.9 | `updateCatalogVariable` | PATCH | Update variable properties (label, order, mandatory, default_value, reference_table, choices, read_only). |
| 13.10 | `deleteCatalogVariable` | DELETE | Remove a variable from a catalog item. |
| 13.11 | `reorderCatalogVariables` | PATCH | Reorder variables on a catalog item (batch update order field). |

### 13C — Variable Set Management (item_option_new_set)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.12 | `listVariableSets` | GET | List variable sets. |
| 13.13 | `createVariableSet` | POST | Create a variable set (reusable group of variables across items). |
| 13.14 | `addVariableToSet` | POST | Add a variable to a variable set. |
| 13.15 | `attachVariableSet` | POST | Attach a variable set to a catalog item (io_set_item). |
| 13.16 | `detachVariableSet` | DELETE | Remove a variable set from a catalog item. |

### 13D — Record Producer Management (sc_cat_item_producer)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.17 | `listRecordProducers` | GET | List record producers. |
| 13.18 | `createRecordProducer` | POST | Create a record producer (produces records on a target table, e.g., incident, sc_task). Requires: name, table, category, short_description. |
| 13.19 | `updateRecordProducer` | PATCH | Update record producer properties (script, template, conditions). |
| 13.20 | `deleteRecordProducer` | DELETE | Deactivate or delete a record producer. |
| 13.21 | `addRecordProducerVariable` | POST | Add a variable to a record producer (same as catalog variable, linked to producer). |
| 13.22 | `updateRecordProducerVariable` | PATCH | Update variable on a record producer. |
| 13.23 | `setRecordProducerScript` | PATCH | Set the onSubmit script for a record producer (⚠ requires approval). |

### 13E — Flow Designer Management (sys_hub_flow)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.24 | `createFlow` | POST | Create a new Flow Designer flow. Sets trigger type, table, conditions. |
| 13.25 | `updateFlow` | PATCH | Update flow metadata (name, description, active, run_as). |
| 13.26 | `activateFlow` | PATCH | Activate/publish a flow. |
| 13.27 | `deactivateFlow` | PATCH | Deactivate a flow. |
| 13.28 | `getFlowDefinition` | GET | Get full flow definition (trigger, actions, stages). |
| 13.29 | `addFlowAction` | POST | Add an action step to a flow (e.g., Create Record, Update Record, Log, Subflow). |
| 13.30 | `removeFlowAction` | DELETE | Remove an action step from a flow. |
| 13.31 | `listSubflows` | GET | List available subflows. |
| 13.32 | `createSubflow` | POST | Create a reusable subflow. |

### 13F — Notification Management (sysevent_email_action)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.33 | `listNotifications` | GET | List email notifications. |
| 13.34 | `createNotification` | POST | Create a notification rule. Sets: name, table, event, conditions, recipients (users/groups/event creators), subject, body template, weight. |
| 13.35 | `updateNotification` | PATCH | Update notification rules (conditions, recipients, template). |
| 13.36 | `deleteNotification` | DELETE | Deactivate or delete a notification. |
| 13.37 | `testNotification` | POST | Send a test notification to preview output. |

### 13G — Business Rule Management (sys_script)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.38 | `listBusinessRules` | GET | List business rules for a table. |
| 13.39 | `createBusinessRule` | POST | Create a business rule (⚠ requires approval). When: before/after insert/update/delete/query. |
| 13.40 | `updateBusinessRule` | PATCH | Update business rule script/conditions (⚠ requires approval). |
| 13.41 | `toggleBusinessRule` | PATCH | Enable/disable a business rule. |

### 13H — Client Script Management (sys_script_client)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.42 | `listClientScripts` | GET | List client scripts for a table. |
| 13.43 | `createClientScript` | POST | Create a client script (⚠ requires approval). Types: onLoad, onChange, onSubmit, onCellEdit. |
| 13.44 | `updateClientScript` | PATCH | Update client script (⚠ requires approval). |
| 13.45 | `toggleClientScript` | PATCH | Enable/disable a client script. |

### 13I — UI Policy Management (sys_ui_policy)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.46 | `listUIPolicies` | GET | List UI policies for a table. |
| 13.47 | `createUIPolicy` | POST | Create a UI policy (make fields mandatory/read-only/visible based on conditions). |
| 13.48 | `updateUIPolicy` | PATCH | Update UI policy conditions or field actions. |
| 13.49 | `addUIPolicyAction` | POST | Add a field action to a UI policy (sys_ui_policy_action). |
| 13.50 | `toggleUIPolicy` | PATCH | Enable/disable a UI policy. |

### 13J — Data Policy Management (sys_data_policy2)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.51 | `listDataPolicies` | GET | List data policies. |
| 13.52 | `createDataPolicy` | POST | Create a data policy (server-side field validation). |
| 13.53 | `updateDataPolicy` | PATCH | Update data policy conditions/actions. |

### 13K — Script Include Management (sys_script_include)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.54 | `listScriptIncludes` | GET | List script includes. |
| 13.55 | `createScriptInclude` | POST | Create a script include (⚠ requires approval). Client-callable or server-only. |
| 13.56 | `updateScriptInclude` | PATCH | Update a script include (⚠ requires approval). |

### 13L — Scheduled Script Execution (sysauto_script)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.57 | `listScheduledScripts` | GET | List scheduled script executions. |
| 13.58 | `createScheduledScript` | POST | Create a scheduled script (⚠ requires approval). |
| 13.59 | `updateScheduledScript` | PATCH | Update a scheduled script. |
| 13.60 | `toggleScheduledScript` | PATCH | Enable/disable a scheduled script. |

### 13M — UI Action Management (sys_ui_action)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.61 | `listUIActions` | GET | List UI actions (buttons, links, context menu) for a table. |
| 13.62 | `createUIAction` | POST | Create a UI action (⚠ requires approval if scripted). |
| 13.63 | `updateUIAction` | PATCH | Update UI action label/script/conditions. |
| 13.64 | `toggleUIAction` | PATCH | Enable/disable a UI action. |

### 13N — Workflow Management (wf_workflow)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.65 | `listWorkflows` | GET | List legacy workflows. |
| 13.66 | `getWorkflow` | GET | Get workflow definition with activities. |
| 13.67 | `createWorkflow` | POST | Create a new workflow (table, conditions). |
| 13.68 | `publishWorkflow` | POST | Publish/activate a workflow. |

### 13O — Approval Rule Management (sysrule_approvals)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.69 | `listApprovalRules` | GET | List approval rules (publishing, CAB, auto-approval). |
| 13.70 | `createApprovalRule` | POST | Create an approval rule (conditions, approvers, type). |
| 13.71 | `updateApprovalRule` | PATCH | Update approval rule conditions or approvers. |

### 13P — Assignment Rule Management (sysrule_assignment)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.72 | `listAssignmentRules` | GET | List assignment rules for a table. |
| 13.73 | `createAssignmentRule` | POST | Create an assignment rule (auto-assign to user/group based on conditions). |
| 13.74 | `updateAssignmentRule` | PATCH | Update assignment rule conditions/assignee. |

### 13Q — SLA Definition Management (contract_sla)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.75 | `listSLADefinitions` | GET | List SLA definitions. |
| 13.76 | `createSLADefinition` | POST | Create an SLA definition (table, start/stop/pause conditions, duration, timezone, schedule). |
| 13.77 | `updateSLADefinition` | PATCH | Update SLA definition parameters. |

### 13R — Inbound Email Action Management (sysevent_in_email_action)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.78 | `listInboundEmailActions` | GET | List inbound email actions. |
| 13.79 | `createInboundEmailAction` | POST | Create inbound email action (auto-create/update records from email). |
| 13.80 | `updateInboundEmailAction` | PATCH | Update inbound email action target/conditions/script. |

### 13S — Dictionary & Schema Management (sys_dictionary, sys_db_object)
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.81 | `listTables` | GET | List tables/apps in instance (sys_db_object). |
| 13.82 | `getTableSchema` | GET | Get table columns (sys_dictionary). |
| 13.83 | `createTable` | POST | Create a new custom table (⚠ requires approval). |
| 13.84 | `addColumn` | POST | Add a column to a table (sys_dictionary) (⚠ requires approval). |
| 13.85 | `updateColumn` | PATCH | Update column attributes (label, max_length, default, mandatory). |
| 13.86 | `listChoices` | GET | List choices for a choice field (sys_choice). |
| 13.87 | `addChoice` | POST | Add a choice value to a field. |
| 13.88 | `updateChoice` | PATCH | Update a choice value label/order/dependent. |

### 13T — Application Scope & Module Management
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.89 | `listAppScopes` | GET | List application scopes (sys_scope). |
| 13.90 | `createAppScope` | POST | Create a scoped application. |
| 13.91 | `listModules` | GET | List navigation modules (sys_app_module). |
| 13.92 | `createModule` | POST | Create a navigation module (adds item to left nav). |
| 13.93 | `updateModule` | PATCH | Update module (link, icon, order, roles). |

### 13U — Service Portal Widget & Page Management
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.94 | `listPortalPages` | GET | List Service Portal pages (sp_page). |
| 13.95 | `createPortalPage` | POST | Create a Service Portal page. |
| 13.96 | `listWidgets` | GET | List Service Portal widgets (sp_widget). |
| 13.97 | `createWidget` | POST | Create a widget (⚠ requires approval — involves HTML/CSS/JS). |
| 13.98 | `updateWidget` | PATCH | Update widget template/script (⚠ requires approval). |

### 13V — Knowledge Management Configuration
| # | Tool | Method | Description |
|---|------|--------|-------------|
| 13.99 | `listKnowledgeBases` | GET | List knowledge bases (kb_knowledge_base). |
| 13.100 | `createKnowledgeBase` | POST | Create a knowledge base (title, owner, workflow). |
| 13.101 | `createKnowledgeArticle` | POST | Create a KB article (kb_knowledge). |
| 13.102 | `updateKnowledgeArticle` | PATCH | Update article body/metadata/workflow_state. |
| 13.103 | `publishKnowledgeArticle` | PATCH | Publish a draft article (move to published state). |
| 13.104 | `retireKnowledgeArticle` | PATCH | Retire an active article. |

**Tools: 104** | **Phase 13 Total: 104** | **Grand Total: 283 tools** | **Status: ✅ Implemented**

---

## Summary

| Phase | Category | New Tools | Running Total | Status |
|-------|----------|-----------|---------------|--------|
| 0 | Tool Description Enrichment | 0 (enrich existing 94) | 17 | ✅ Done |
| 1 | Attachment, Batch, Email, SCIM, Roles | 23 | 40 | ✅ Done |
| 2 | CMDB, Discovery, Cloud | 12 | 52 | ✅ Done |
| 3 | Import Set, CSV, Transform | 8 | 60 | ✅ Done |
| 4 | Service Catalog Deep | 20 | 80 | ✅ Done |
| 5 | Change, Problem, SLA | 15 | 95 | ✅ Done |
| 6 | Security Ops, Scripted REST | 9 | 104 | ✅ Done |
| 7 | Performance Analytics, Reporting | 9 | 113 | ✅ Done |
| 8 | Integration Hub, Flow, Orchestration | 10 | 123 | ✅ Done |
| 9 | ITSM, CSM, HR Service | 15 | 138 | ✅ Done |
| 10 | DevOps, CI/CD, Update Sets | 16 | 154 | ✅ Done |
| 11 | NLU, Virtual Agent, Predictive AI | 10 | 164 | ✅ Done |
| 12 | Admin, Governance, Platform | 15 | 179 | ✅ Done |
| 13 | Development & Configuration Activities | 104 | 283 | ✅ Done |

**Grand Total: 283 ServiceNow tools** (17 existing + 266 new)

---

## Approval Framework

All tools in Phase 13 that involve scripting or schema changes are tagged with
`requiresApproval: true`. The agent framework should:

1. **Auto-execute** — read-only operations (list, get) and safe configuration (createCatalogItem, createNotification)
2. **Flag for review** — any mutation that sets a `script` field or modifies sys_dictionary/ACL
3. **Block until approved** — table creation, ACL changes, plugin activation, script includes

```
┌───────────────────────────────────────────────┐
│           Configuration First                  │
│                                                │
│  Read-only    →  Auto-execute                  │
│  Config CRUD  →  Auto-execute (safe records)   │
│  Script field →  Flag for review               │
│  Schema/ACL   →  Block until approved          │
│  Plugin/App   →  Block until approved          │
└───────────────────────────────────────────────┘
```
