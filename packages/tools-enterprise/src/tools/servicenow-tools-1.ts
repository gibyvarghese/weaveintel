import type { Tool } from "@weaveintel/core";
import type { EnterpriseConnectorConfig } from "../types.js";
import type { ServiceNowProvider } from "../connectors/servicenow.js";
import { bt, ok, s, n, o, b } from "./servicenow-tool-helpers.js";


/* ================================================================
 *  PHASE 0 ADDITIONS — missed from base registration
 * ================================================================ */
export function phase0(px: string, cfg: EnterpriseConnectorConfig, p: ServiceNowProvider): Tool[] { return [
  bt({ name: `${px}.updateIncident`, desc: 'Update an existing ServiceNow incident by sys_id. Partial update — only fields provided are changed. Common fields: state (1=New,2=InProgress,6=Resolved,7=Closed), urgency (1–3), impact (1–3), assigned_to, assignment_group, short_description, work_notes, close_code, close_notes.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the incident' }, data: { type: 'object', description: 'Fields to update: state, urgency, impact, assigned_to, assignment_group, work_notes, close_notes, etc.' } }, required: ['id', 'data'] },
    fn: async (_c, inp) => ok(await p.updateIncident(s(inp,'id'), o(inp,'data'), cfg)) }),
  bt({ name: `${px}.createProblem`, desc: 'Create a new Problem record in ServiceNow. Problems represent the underlying cause of incidents. Fields: short_description (required), description, urgency (1–3), impact (1–3), assigned_to, assignment_group, category.',
    params: { type: 'object', properties: { data: { type: 'object', description: 'Problem fields: short_description (required), description, urgency, impact, assigned_to, assignment_group, category' } }, required: ['data'] },
    fn: async (_c, inp) => ok(await p.createProblem(o(inp,'data'), cfg)) }),
  bt({ name: `${px}.getCMDBItem`, desc: 'Get a specific CMDB Configuration Item by sys_id and class name. Returns all CI attributes including name, serial_number, asset_tag, ip_address, os, manufacturer, department, location, etc.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the CI' }, className: { type: 'string', description: 'CMDB class, e.g. cmdb_ci_server, cmdb_ci_computer, cmdb_ci_linux_server' } }, required: ['id', 'className'] },
    fn: async (_c, inp) => ok(await p.getCMDBItem(s(inp,'id'), s(inp,'className'), cfg)) }),
  bt({ name: `${px}.getUser`, desc: 'Get a ServiceNow user record by sys_id. Returns user_name, first_name, last_name, email, active, department, manager, title, phone.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the user' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.getUser(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.getCatalogItem`, desc: 'Get detailed information about a specific Service Catalog item by sys_id. Returns name, short_description, description, category, price, delivery_time, availability, active status, and associated variables.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the catalog item' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.getCatalogItem(s(inp,'id'), cfg)) }),
]; }

/* ================================================================
 *  PHASE 1 — Attachment, Batch, Email, SCIM, Roles, Groups
 * ================================================================ */
export function phase1(px: string, cfg: EnterpriseConnectorConfig, p: ServiceNowProvider): Tool[] { return [
  /* --- Attachments --- */
  bt({ name: `${px}.listAttachments`, desc: 'List file attachments on a specific ServiceNow record. Returns attachment metadata: sys_id, file_name, content_type, size_bytes, sys_created_on. Use downloadAttachment to retrieve file contents.',
    params: { type: 'object', properties: { table: { type: 'string', description: 'Table name the record belongs to, e.g. incident, change_request, kb_knowledge' }, sysId: { type: 'string', description: 'sys_id of the record to list attachments for' } }, required: ['table', 'sysId'] },
    fn: async (_c, inp) => ok(await p.listAttachments(s(inp,'table'), s(inp,'sysId'), cfg)) }),
  bt({ name: `${px}.getAttachment`, desc: 'Get metadata for a specific attachment by sys_id. Returns file_name, content_type, size_bytes, table_name, table_sys_id, sys_created_on.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the attachment' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.getAttachment(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.downloadAttachment`, desc: 'Download the binary/text content of an attachment by sys_id. Returns the file content as a base64-encoded string along with file_name and content_type.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the attachment to download' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.downloadAttachment(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.uploadAttachment`, desc: 'Upload a file attachment to a ServiceNow record. Attach documents, screenshots, logs, or any file to incidents, changes, knowledge articles, etc.',
    params: { type: 'object', properties: { table: { type: 'string', description: 'Target table, e.g. incident, change_request' }, sysId: { type: 'string', description: 'sys_id of the target record' }, fileName: { type: 'string', description: 'File name with extension, e.g. screenshot.png, error.log' }, contentType: { type: 'string', description: 'MIME type, e.g. image/png, text/plain, application/pdf' }, content: { type: 'string', description: 'File content as base64-encoded string' } }, required: ['table', 'sysId', 'fileName', 'contentType', 'content'] },
    fn: async (_c, inp) => ok(await p.uploadAttachment(s(inp,'table'), s(inp,'sysId'), s(inp,'fileName'), s(inp,'contentType'), s(inp,'content'), cfg)) }),
  bt({ name: `${px}.deleteAttachment`, desc: 'Permanently delete an attachment from ServiceNow by sys_id. This is irreversible.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the attachment to delete' } }, required: ['id'] },
    fn: async (_c, inp) => { await p.deleteAttachment(s(inp,'id'), cfg); return ok({ success: true }); } }),

  /* --- Batch API --- */
  bt({ name: `${px}.batchRequest`, desc: 'Execute multiple REST API calls in a single HTTP request. Reduces round-trips when performing bulk operations. Each sub-request specifies method, URL, and optional body. Returns array of sub-responses.',
    params: { type: 'object', properties: { requests: { type: 'array', description: 'Array of sub-requests: [{ id: "1", method: "GET"|"POST"|"PATCH"|"DELETE", url: "/api/now/table/incident/...", body?: {...}, headers?: {...} }]' } }, required: ['requests'] },
    fn: async (_c, inp) => ok(await p.batchRequest(inp.arguments['requests'] as Array<{ id: string; method: string; url: string; body?: unknown; headers?: Record<string, string> }>, cfg)) }),

  /* --- Email API --- */
  bt({ name: `${px}.sendEmail`, desc: 'Send an email notification through ServiceNow. Uses the sys_email table. The email is sent via the instance mail configuration.',
    params: { type: 'object', properties: { to: { type: 'string', description: 'Recipient email address' }, subject: { type: 'string', description: 'Email subject line' }, body: { type: 'string', description: 'Email body (HTML supported)' }, options: { type: 'object', description: 'Optional: { cc?: string, bcc?: string, importance?: "high"|"normal"|"low" }' } }, required: ['to', 'subject', 'body'] },
    fn: async (_c, inp) => ok(await p.sendEmail(s(inp,'to'), s(inp,'subject'), s(inp,'body'), cfg, inp.arguments['options'] as Record<string, unknown>)) }),
  bt({ name: `${px}.listEmails`, desc: 'List email records from the sys_email table. Returns sent, received, and queued emails with subject, recipients, body_text, type (send/receive), state.',
    params: { type: 'object', properties: { query: { type: 'string', description: 'Encoded query filter, e.g. "type=send^stateIN0,1", "recipients=user@co.com"' }, limit: { type: 'number', description: 'Max results (default: 50)' } } },
    fn: async (_c, inp) => ok(await p.listEmails(cfg, inp.arguments['query'] as string ?? '', n(inp,'limit',50))) }),

  /* --- SCIM Users --- */
  bt({ name: `${px}.scimListUsers`, desc: 'List users via the SCIM 2.0 API. SCIM provides a standardized identity interface used by identity providers (Okta, Azure AD, etc.) for user provisioning/deprovisioning.',
    params: { type: 'object', properties: { filter: { type: 'string', description: 'SCIM filter expression, e.g. \'userName eq "john.doe"\', \'displayName co "Smith"\'' }, count: { type: 'number', description: 'Max results (default: 50)' } } },
    fn: async (_c, inp) => ok(await p.scimListUsers(cfg, inp.arguments['filter'] as string ?? '', n(inp,'count',50))) }),
  bt({ name: `${px}.scimGetUser`, desc: 'Get a specific user via SCIM 2.0 by their SCIM ID. Returns userName, displayName, emails, groups, active status, and enterprise extension attributes.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'SCIM user ID' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.scimGetUser(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.scimCreateUser`, desc: 'Create/provision a new user via SCIM 2.0. Used by identity providers for automated user lifecycle management. Fields: userName (required), displayName, emails, active.',
    params: { type: 'object', properties: { data: { type: 'object', description: 'SCIM user resource: { userName: string, displayName?: string, name?: { givenName, familyName }, emails?: [{value,type}], active?: boolean }' } }, required: ['data'] },
    fn: async (_c, inp) => ok(await p.scimCreateUser(o(inp,'data'), cfg)) }),
  bt({ name: `${px}.scimUpdateUser`, desc: 'Update/replace a user via SCIM 2.0 by SCIM ID. Full replacement — send all fields, not just changes.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'SCIM user ID' }, data: { type: 'object', description: 'Complete SCIM user resource with updated fields' } }, required: ['id', 'data'] },
    fn: async (_c, inp) => ok(await p.scimUpdateUser(s(inp,'id'), o(inp,'data'), cfg)) }),
  bt({ name: `${px}.scimDeleteUser`, desc: 'Delete/deprovision a user via SCIM 2.0. Typically sets the user to inactive rather than hard-deleting.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'SCIM user ID to deprovision' } }, required: ['id'] },
    fn: async (_c, inp) => { await p.scimDeleteUser(s(inp,'id'), cfg); return ok({ success: true }); } }),

  /* --- SCIM Groups --- */
  bt({ name: `${px}.scimListGroups`, desc: 'List groups via SCIM 2.0. Returns group displayName, members, and sys_id. Used for group-based provisioning from IdPs.',
    params: { type: 'object', properties: { filter: { type: 'string', description: 'SCIM filter, e.g. \'displayName eq "IT Support"\'' }, count: { type: 'number', description: 'Max results (default: 50)' } } },
    fn: async (_c, inp) => ok(await p.scimListGroups(cfg, inp.arguments['filter'] as string ?? '', n(inp,'count',50))) }),
  bt({ name: `${px}.scimGetGroup`, desc: 'Get a SCIM group by ID. Returns displayName, members list, and metadata.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'SCIM group ID' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.scimGetGroup(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.scimCreateGroup`, desc: 'Create a group via SCIM 2.0. Fields: displayName (required), members (array of {value: userId}).',
    params: { type: 'object', properties: { data: { type: 'object', description: 'SCIM group resource: { displayName: string, members?: [{ value: userId }] }' } }, required: ['data'] },
    fn: async (_c, inp) => ok(await p.scimCreateGroup(o(inp,'data'), cfg)) }),
  bt({ name: `${px}.scimUpdateGroup`, desc: 'Update/replace a SCIM group by ID. Full replacement of group membership and attributes.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'SCIM group ID' }, data: { type: 'object', description: 'Complete SCIM group resource with updated fields and members' } }, required: ['id', 'data'] },
    fn: async (_c, inp) => ok(await p.scimUpdateGroup(s(inp,'id'), o(inp,'data'), cfg)) }),

  /* --- User Roles --- */
  bt({ name: `${px}.listUserRoles`, desc: 'List all roles assigned to a specific user. Reads sys_user_has_role table. Returns role name, sys_id, inherited flag, and assignment details.',
    params: { type: 'object', properties: { userId: { type: 'string', description: 'sys_id of the user' } }, required: ['userId'] },
    fn: async (_c, inp) => ok(await p.listUserRoles(s(inp,'userId'), cfg)) }),
  bt({ name: `${px}.assignUserRole`, desc: 'Assign a security role to a user. Creates a record in sys_user_has_role. The role controls access to modules, tables, and operations.',
    params: { type: 'object', properties: { userId: { type: 'string', description: 'sys_id of the user' }, roleId: { type: 'string', description: 'sys_id of the role (from sys_user_role table)' } }, required: ['userId', 'roleId'] },
    fn: async (_c, inp) => ok(await p.assignUserRole(s(inp,'userId'), s(inp,'roleId'), cfg)) }),
  bt({ name: `${px}.removeUserRole`, desc: 'Remove a role assignment from a user. Deletes the sys_user_has_role record.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the user-role assignment record (from listUserRoles)' } }, required: ['id'] },
    fn: async (_c, inp) => { await p.removeUserRole(s(inp,'id'), cfg); return ok({ success: true }); } }),

  /* --- Group Members --- */
  bt({ name: `${px}.listGroupMembers`, desc: 'List members of a ServiceNow group. Reads sys_user_grmember table. Returns user sys_id, user_name, name for each member.',
    params: { type: 'object', properties: { groupId: { type: 'string', description: 'sys_id of the group (from sys_user_group)' } }, required: ['groupId'] },
    fn: async (_c, inp) => ok(await p.listGroupMembers(s(inp,'groupId'), cfg)) }),
  bt({ name: `${px}.addGroupMember`, desc: 'Add a user to a group. Creates a sys_user_grmember record. Group membership can affect assignment rules, notifications, and role inheritance.',
    params: { type: 'object', properties: { groupId: { type: 'string', description: 'sys_id of the group' }, userId: { type: 'string', description: 'sys_id of the user to add' } }, required: ['groupId', 'userId'] },
    fn: async (_c, inp) => ok(await p.addGroupMember(s(inp,'groupId'), s(inp,'userId'), cfg)) }),
  bt({ name: `${px}.removeGroupMember`, desc: 'Remove a user from a group. Deletes the sys_user_grmember record.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the group membership record (from listGroupMembers)' } }, required: ['id'] },
    fn: async (_c, inp) => { await p.removeGroupMember(s(inp,'id'), cfg); return ok({ success: true }); } }),
]; }

/* ================================================================
 *  PHASE 2 — CMDB Deep, Discovery, Cloud Management
 * ================================================================ */
export function phase2(px: string, cfg: EnterpriseConnectorConfig, p: ServiceNowProvider): Tool[] { return [
  bt({ name: `${px}.cmdbGetCI`, desc: 'Get a CMDB Configuration Item by sys_id and class. Returns all CI attributes. Equivalent to getCMDBItem but via the CMDB API endpoint for richer metadata.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the CI' }, className: { type: 'string', description: 'CMDB class: cmdb_ci_server, cmdb_ci_computer, cmdb_ci_linux_server, cmdb_ci_win_server, cmdb_ci_app_server, cmdb_ci_database, cmdb_ci_service, cmdb_ci_network_gear' } }, required: ['id', 'className'] },
    fn: async (_c, inp) => ok(await p.cmdbGetCI(s(inp,'id'), s(inp,'className'), cfg)) }),
  bt({ name: `${px}.cmdbCreateCI`, desc: 'Create a new Configuration Item in the CMDB. Fields depend on the class — e.g. for cmdb_ci_server: name (required), serial_number, ip_address, os, os_version, manufacturer, cpu_count, ram, disk_space.',
    params: { type: 'object', properties: { className: { type: 'string', description: 'CMDB class to create in, e.g. cmdb_ci_server' }, data: { type: 'object', description: 'CI attributes: name (required), serial_number, ip_address, os, manufacturer, model_id, department, location, etc.' } }, required: ['className', 'data'] },
    fn: async (_c, inp) => ok(await p.cmdbCreateCI(s(inp,'className'), o(inp,'data'), cfg)) }),
  bt({ name: `${px}.cmdbUpdateCI`, desc: 'Update an existing CMDB Configuration Item. Partial update — only specified fields are changed.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the CI' }, className: { type: 'string', description: 'CMDB class' }, data: { type: 'object', description: 'Fields to update' } }, required: ['id', 'className', 'data'] },
    fn: async (_c, inp) => ok(await p.cmdbUpdateCI(s(inp,'id'), s(inp,'className'), o(inp,'data'), cfg)) }),
  bt({ name: `${px}.cmdbDeleteCI`, desc: 'Delete a Configuration Item from the CMDB. Warning: this removes the CI and may break relationships. Prefer retiring/decommissioning instead.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the CI to delete' }, className: { type: 'string', description: 'CMDB class' } }, required: ['id', 'className'] },
    fn: async (_c, inp) => { await p.cmdbDeleteCI(s(inp,'id'), s(inp,'className'), cfg); return ok({ success: true }); } }),
  bt({ name: `${px}.cmdbGetRelationships`, desc: 'Get all relationships for a CMDB CI. Returns parent/child/peer relationships with type labels. Essential for dependency mapping and impact analysis.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the CI' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.cmdbGetRelationships(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.cmdbCreateRelationship`, desc: 'Create a relationship between two CIs in the CMDB. Relationship types: "Runs on", "Depends on", "Used by", "Hosted on", "Contains", etc.',
    params: { type: 'object', properties: { parentId: { type: 'string', description: 'sys_id of the parent CI' }, childId: { type: 'string', description: 'sys_id of the child CI' }, typeId: { type: 'string', description: 'sys_id of the relationship type (from cmdb_rel_type table)' } }, required: ['parentId', 'childId', 'typeId'] },
    fn: async (_c, inp) => ok(await p.cmdbCreateRelationship(s(inp,'parentId'), s(inp,'childId'), s(inp,'typeId'), cfg)) }),
  bt({ name: `${px}.cmdbDeleteRelationship`, desc: 'Delete a CMDB relationship between two CIs.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the cmdb_rel_ci record' } }, required: ['id'] },
    fn: async (_c, inp) => { await p.cmdbDeleteRelationship(s(inp,'id'), cfg); return ok({ success: true }); } }),
  bt({ name: `${px}.cmdbIdentifyCI`, desc: 'Use the CMDB Identification API to find or create a CI based on identification rules. Matches CIs by serial_number, name+ip_address, or other identification criteria. Returns matched/created CI.',
    params: { type: 'object', properties: { data: { type: 'object', description: 'CI identification payload: { items: [{ className, values: { name, serial_number, ip_address, ... }, lookup: [...] }] }' } }, required: ['data'] },
    fn: async (_c, inp) => ok(await p.cmdbIdentifyCI(o(inp,'data'), cfg)) }),
  bt({ name: `${px}.cmdbListClasses`, desc: 'List CMDB CI classes (the class hierarchy). Returns class label, name, parent, and attribute count. Use to discover available CI types.',
    params: { type: 'object', properties: { query: { type: 'string', description: 'Filter, e.g. "nameSTARTSWITHcmdb_ci_server"' }, limit: { type: 'number', description: 'Max results (default: 100)' } } },
    fn: async (_c, inp) => ok(await p.cmdbListClasses(cfg, inp.arguments['query'] as string ?? '', n(inp,'limit',100))) }),
  bt({ name: `${px}.cmdbGetClassSchema`, desc: 'Get the schema/dictionary for a CMDB class. Returns all attributes (columns) with name, type, max_length, mandatory flag, reference target, default_value. Essential for understanding CI data model.',
    params: { type: 'object', properties: { className: { type: 'string', description: 'CMDB class name, e.g. cmdb_ci_server' } }, required: ['className'] },
    fn: async (_c, inp) => ok(await p.cmdbGetClassSchema(s(inp,'className'), cfg)) }),
  bt({ name: `${px}.cloudListResources`, desc: 'List cloud resources tracked in ServiceNow ITOM Cloud Management. Returns VMs, storage, networks from AWS, Azure, GCP discovered by ServiceNow.',
    params: { type: 'object', properties: { query: { type: 'string', description: 'Encoded query filter' }, limit: { type: 'number', description: 'Max results (default: 50)' } } },
    fn: async (_c, inp) => ok(await p.cloudListResources(cfg, inp.arguments['query'] as string ?? '', n(inp,'limit',50))) }),
  bt({ name: `${px}.cloudGetResource`, desc: 'Get detailed information about a specific cloud resource by sys_id.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the cloud resource' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.cloudGetResource(s(inp,'id'), cfg)) }),
]; }

/* ================================================================
 *  PHASE 3 — Import Set, CSV/Excel, Transform Maps, Export
 * ================================================================ */
export function phase3(px: string, cfg: EnterpriseConnectorConfig, p: ServiceNowProvider): Tool[] { return [
  bt({ name: `${px}.importSetInsert`, desc: 'Insert records into a ServiceNow Import Set staging table. Data lands in the staging table and must be transformed (via Transform Map) to reach the target table. Useful for bulk data loading.',
    params: { type: 'object', properties: { table: { type: 'string', description: 'Import set table name, e.g. u_import_incidents' }, data: { type: 'array', description: 'Array of record objects to insert, e.g. [{ u_name: "Server1", u_ip: "10.0.0.1" }]' } }, required: ['table', 'data'] },
    fn: async (_c, inp) => ok(await p.importSetInsert(s(inp,'table'), inp.arguments['data'] as Record<string, unknown>[], cfg)) }),
  bt({ name: `${px}.importSetGetStatus`, desc: 'Get the status of an import set by sys_id. Returns state (loaded, transforming, transformed, error), row counts, errors.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the import set record' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.importSetGetStatus(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.importSetTransform`, desc: 'Trigger transformation of an import set. Runs the associated Transform Map to move data from the staging table to the target table, applying field mappings and coalesce rules.',
    params: { type: 'object', properties: { importSetId: { type: 'string', description: 'sys_id of the import set to transform' } }, required: ['importSetId'] },
    fn: async (_c, inp) => ok(await p.importSetTransform(s(inp,'importSetId'), cfg)) }),
  bt({ name: `${px}.importCSV`, desc: 'Import CSV data directly into a ServiceNow table. The CSV is parsed and loaded as an import set, then auto-transformed if a Transform Map exists.',
    params: { type: 'object', properties: { table: { type: 'string', description: 'Target or staging table name' }, csvContent: { type: 'string', description: 'Raw CSV content with header row, e.g. "name,ip\\nServer1,10.0.0.1"' } }, required: ['table', 'csvContent'] },
    fn: async (_c, inp) => ok(await p.importCSV(s(inp,'table'), s(inp,'csvContent'), cfg)) }),
  bt({ name: `${px}.importExcel`, desc: 'Import an Excel file into a ServiceNow table. Excel is parsed and loaded as an import set.',
    params: { type: 'object', properties: { table: { type: 'string', description: 'Target or staging table name' }, base64Content: { type: 'string', description: 'Excel file content as base64-encoded string' } }, required: ['table', 'base64Content'] },
    fn: async (_c, inp) => ok(await p.importExcel(s(inp,'table'), s(inp,'base64Content'), cfg)) }),
  bt({ name: `${px}.exportTable`, desc: 'Export records from a ServiceNow table in CSV, Excel, JSON, or XML format. Returns the exported content.',
    params: { type: 'object', properties: { table: { type: 'string', description: 'Table to export from, e.g. incident, change_request' }, query: { type: 'string', description: 'Encoded query to filter which records to export' }, format: { type: 'string', description: 'Export format: csv, xlsx, json, xml' }, limit: { type: 'number', description: 'Max records (default: 1000)' } }, required: ['table', 'query', 'format'] },
    fn: async (_c, inp) => ok(await p.exportTable(s(inp,'table'), s(inp,'query'), s(inp,'format'), cfg, n(inp,'limit',1000))) }),
  bt({ name: `${px}.listTransformMaps`, desc: 'List Transform Maps for an import set table. Transform Maps define how staging table columns map to target table fields, including coalesce rules and scripts.',
    params: { type: 'object', properties: { importSetTable: { type: 'string', description: 'Import set staging table name' } }, required: ['importSetTable'] },
    fn: async (_c, inp) => ok(await p.listTransformMaps(s(inp,'importSetTable'), cfg)) }),
  bt({ name: `${px}.getTransformMap`, desc: 'Get a specific Transform Map by sys_id. Returns name, source_table, target_table, active status, field_maps, and script details.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the transform map' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.getTransformMap(s(inp,'id'), cfg)) }),
]; }

/* ================================================================
 *  PHASE 4 — Service Catalog Deep
 * ================================================================ */
export function phase4(px: string, cfg: EnterpriseConnectorConfig, p: ServiceNowProvider): Tool[] { return [
  /* --- Catalogs & Categories --- */
  bt({ name: `${px}.listCatalogs`, desc: 'List all Service Catalogs in the instance. A catalog is a top-level container (e.g. IT Service Catalog, HR Catalog). Returns sys_id, title, description.',
    params: { type: 'object', properties: {} },
    fn: async (_c, _inp) => ok(await p.listCatalogs(cfg)) }),
  bt({ name: `${px}.getCatalog`, desc: 'Get a specific Service Catalog by sys_id. Returns title, description, manager, background_color, has_categories flag.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the catalog' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.getCatalog(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.listCategories`, desc: 'List categories within a Service Catalog. Categories organize catalog items (e.g. Hardware, Software, Access Requests). Returns sys_id, title, description, parent.',
    params: { type: 'object', properties: { catalogId: { type: 'string', description: 'sys_id of the parent catalog' } }, required: ['catalogId'] },
    fn: async (_c, inp) => ok(await p.listCategories(s(inp,'catalogId'), cfg)) }),
  bt({ name: `${px}.getCategory`, desc: 'Get a specific catalog category by sys_id.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the category' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.getCategory(s(inp,'id'), cfg)) }),

  /* --- Item Variables --- */
  bt({ name: `${px}.getCatalogItemVariables`, desc: 'Get the variables (form fields) defined on a catalog item. Variables are what end users fill in when ordering. Returns variable name, type, label, mandatory flag, default_value, choices.',
    params: { type: 'object', properties: { itemId: { type: 'string', description: 'sys_id of the catalog item' } }, required: ['itemId'] },
    fn: async (_c, inp) => ok(await p.getCatalogItemVariables(s(inp,'itemId'), cfg)) }),
  bt({ name: `${px}.getCatalogItemVariableSet`, desc: 'Get variable sets attached to a catalog item. Variable sets are reusable groups of variables shared across multiple items.',
    params: { type: 'object', properties: { itemId: { type: 'string', description: 'sys_id of the catalog item' } }, required: ['itemId'] },
    fn: async (_c, inp) => ok(await p.getCatalogItemVariableSet(s(inp,'itemId'), cfg)) }),

  /* --- Shopping Cart --- */
  bt({ name: `${px}.addToCart`, desc: 'Add a catalog item to the current user\'s shopping cart with specified variable values. Returns the cart item with sys_id.',
    params: { type: 'object', properties: { itemId: { type: 'string', description: 'sys_id of the catalog item to add' }, variables: { type: 'object', description: 'Key-value pairs for the item variables, e.g. { "quantity": 2, "justification": "Project need" }' } }, required: ['itemId'] },
    fn: async (_c, inp) => ok(await p.addToCart(s(inp,'itemId'), o(inp,'variables'), cfg)) }),
  bt({ name: `${px}.getCart`, desc: 'Get the current user\'s shopping cart contents. Returns cart items with quantities, variables, and estimated delivery.',
    params: { type: 'object', properties: {} },
    fn: async (_c, _inp) => ok(await p.getCart(cfg)) }),
  bt({ name: `${px}.updateCartItem`, desc: 'Update a cart item — change variable values or quantity before checkout.',
    params: { type: 'object', properties: { cartItemId: { type: 'string', description: 'sys_id of the cart item' }, data: { type: 'object', description: 'Updated fields/variables' } }, required: ['cartItemId', 'data'] },
    fn: async (_c, inp) => ok(await p.updateCartItem(s(inp,'cartItemId'), o(inp,'data'), cfg)) }),
  bt({ name: `${px}.deleteCartItem`, desc: 'Remove an item from the shopping cart.',
    params: { type: 'object', properties: { cartItemId: { type: 'string', description: 'sys_id of the cart item to remove' } }, required: ['cartItemId'] },
    fn: async (_c, inp) => { await p.deleteCartItem(s(inp,'cartItemId'), cfg); return ok({ success: true }); } }),
  bt({ name: `${px}.checkoutCart`, desc: 'Submit the shopping cart. Creates a Request (sc_request) with one or more Requested Items (sc_req_item), triggers approval workflows, and returns the request record with number.',
    params: { type: 'object', properties: {} },
    fn: async (_c, _inp) => ok(await p.checkoutCart(cfg)) }),
  bt({ name: `${px}.emptyCart`, desc: 'Remove all items from the current shopping cart.',
    params: { type: 'object', properties: {} },
    fn: async (_c, _inp) => { await p.emptyCart(cfg); return ok({ success: true }); } }),

  /* --- Requests & Approvals --- */
  bt({ name: `${px}.listRequests`, desc: 'List Service Catalog requests (sc_request). Returns request number, state, requested_for, opened_at, items summary.',
    params: { type: 'object', properties: { query: { type: 'string', description: 'Encoded query, e.g. "state=requested^requested_for=<user_id>"' }, limit: { type: 'number', description: 'Max results (default: 50)' } } },
    fn: async (_c, inp) => ok(await p.listRequests(cfg, inp.arguments['query'] as string ?? '', n(inp,'limit',50))) }),
  bt({ name: `${px}.getRequest`, desc: 'Get a specific catalog request by sys_id. Returns full request details including state, requested items, approval status.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the sc_request' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.getRequest(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.listRequestItems`, desc: 'List the Requested Items (sc_req_item) within a catalog request. Each item represents one catalog item that was ordered.',
    params: { type: 'object', properties: { requestId: { type: 'string', description: 'sys_id of the parent sc_request' } }, required: ['requestId'] },
    fn: async (_c, inp) => ok(await p.listRequestItems(s(inp,'requestId'), cfg)) }),
  bt({ name: `${px}.getRequestItem`, desc: 'Get a specific Requested Item (sc_req_item) by sys_id.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the sc_req_item' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.getRequestItem(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.listApprovals`, desc: 'List approval records (sysapproval_approver). Returns approvals pending, approved, or rejected with approver, document, state, due_date.',
    params: { type: 'object', properties: { query: { type: 'string', description: 'Encoded query, e.g. "state=requested", "approver=<user_id>"' }, limit: { type: 'number', description: 'Max results (default: 50)' } } },
    fn: async (_c, inp) => ok(await p.listApprovals(cfg, inp.arguments['query'] as string ?? '', n(inp,'limit',50))) }),
  bt({ name: `${px}.getApproval`, desc: 'Get a specific approval record by sys_id.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the approval record' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.getApproval(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.approveRequest`, desc: 'Approve a pending approval request. Sets state to "approved" with optional comments.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the sysapproval_approver record' }, comments: { type: 'string', description: 'Approval comments (optional)' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.approveRequest(s(inp,'id'), cfg, inp.arguments['comments'] as string ?? '')) }),
  bt({ name: `${px}.rejectRequest`, desc: 'Reject a pending approval request. Sets state to "rejected" with optional reason.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the sysapproval_approver record' }, comments: { type: 'string', description: 'Rejection reason/comments' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.rejectRequest(s(inp,'id'), cfg, inp.arguments['comments'] as string ?? '')) }),
]; }

/* ================================================================
 *  PHASE 5 — Change/Problem Deep, SLA
 * ================================================================ */
export function phase5(px: string, cfg: EnterpriseConnectorConfig, p: ServiceNowProvider): Tool[] { return [
  bt({ name: `${px}.getChangeRequest`, desc: 'Get a specific change request by sys_id. Returns all fields: number, short_description, state, type (Normal/Emergency/Standard), risk, impact, schedule, CAB, implementation/backout plans.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the change_request' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.getChangeRequest(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.updateChangeRequest`, desc: 'Update a change request. Common fields: state (-5=New,-4=Assess,-3=Authorize,-2=Scheduled,-1=Implement,0=Review,3=Closed), risk (High/Moderate/Low), assignment_group, implementation_plan, backout_plan.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the change_request' }, data: { type: 'object', description: 'Fields to update' } }, required: ['id', 'data'] },
    fn: async (_c, inp) => ok(await p.updateChangeRequest(s(inp,'id'), o(inp,'data'), cfg)) }),
  bt({ name: `${px}.listChangeTasks`, desc: 'List change tasks (change_task) associated with a change request. Tasks break a change into implementation steps with ordering and assignment.',
    params: { type: 'object', properties: { changeId: { type: 'string', description: 'sys_id of the parent change_request' } }, required: ['changeId'] },
    fn: async (_c, inp) => ok(await p.listChangeTasks(s(inp,'changeId'), cfg)) }),
  bt({ name: `${px}.createChangeTask`, desc: 'Create a change task under a change request. Fields: short_description (required), assignment_group, assigned_to, planned_start_date, planned_end_date, order.',
    params: { type: 'object', properties: { changeId: { type: 'string', description: 'sys_id of the parent change_request' }, data: { type: 'object', description: 'Task fields: short_description (required), assignment_group, assigned_to, order, planned_start_date, planned_end_date' } }, required: ['changeId', 'data'] },
    fn: async (_c, inp) => ok(await p.createChangeTask(s(inp,'changeId'), o(inp,'data'), cfg)) }),
  bt({ name: `${px}.updateChangeTask`, desc: 'Update a change task. Common updates: state (1=Open,2=In Progress,3=Closed Complete,4=Closed Incomplete), work_notes, assigned_to.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the change_task' }, data: { type: 'object', description: 'Fields to update' } }, required: ['id', 'data'] },
    fn: async (_c, inp) => ok(await p.updateChangeTask(s(inp,'id'), o(inp,'data'), cfg)) }),
  bt({ name: `${px}.getChangeSchedule`, desc: 'Get the change schedule/calendar. Returns upcoming changes with their scheduled start/end times. Useful for blackout window checks and conflict detection.',
    params: { type: 'object', properties: { query: { type: 'string', description: 'Filter, e.g. "start_dateONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()"' } } },
    fn: async (_c, inp) => ok(await p.getChangeSchedule(cfg, inp.arguments['query'] as string ?? '')) }),
  bt({ name: `${px}.checkChangeConflict`, desc: 'Check for scheduling conflicts with a change request. Detects overlapping maintenance windows, blackout periods, and resource conflicts.',
    params: { type: 'object', properties: { changeId: { type: 'string', description: 'sys_id of the change_request to check' } }, required: ['changeId'] },
    fn: async (_c, inp) => ok(await p.checkChangeConflict(s(inp,'changeId'), cfg)) }),
  bt({ name: `${px}.getProblem`, desc: 'Get a specific problem record by sys_id. Returns short_description, state, root cause, workaround, related incidents count.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the problem' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.getProblem(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.updateProblem`, desc: 'Update a problem record. Common fields: state (1=New,2=Known Error,3=Pending Change,4=Closed/Resolved), cause_notes, fix_notes, workaround.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the problem' }, data: { type: 'object', description: 'Fields to update' } }, required: ['id', 'data'] },
    fn: async (_c, inp) => ok(await p.updateProblem(s(inp,'id'), o(inp,'data'), cfg)) }),
  bt({ name: `${px}.listKnownErrors`, desc: 'List Known Error records. A known error is a problem with a documented root cause and workaround. Returns problem_id, known_error flag, workaround.',
    params: { type: 'object', properties: { query: { type: 'string', description: 'Encoded query filter' }, limit: { type: 'number', description: 'Max results (default: 50)' } } },
    fn: async (_c, inp) => ok(await p.listKnownErrors(cfg, inp.arguments['query'] as string ?? '', n(inp,'limit',50))) }),
  bt({ name: `${px}.createKnownError`, desc: 'Create a Known Error from an existing problem. Sets the problem\'s known_error flag and documents the root cause and workaround.',
    params: { type: 'object', properties: { problemId: { type: 'string', description: 'sys_id of the problem to mark as known error' } }, required: ['problemId'] },
    fn: async (_c, inp) => ok(await p.createKnownError(s(inp,'problemId'), cfg)) }),
  bt({ name: `${px}.listTaskSLAs`, desc: 'List SLA records attached to a task (incident, change, etc.). Shows SLA name, stage (in_progress, paused, breached), percentage elapsed, breach time.',
    params: { type: 'object', properties: { taskId: { type: 'string', description: 'sys_id of the task (incident, change_request, etc.)' } }, required: ['taskId'] },
    fn: async (_c, inp) => ok(await p.listTaskSLAs(s(inp,'taskId'), cfg)) }),
  bt({ name: `${px}.getTaskSLA`, desc: 'Get a specific task SLA record by sys_id. Returns detailed SLA timing, breach status, and pause history.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the task_sla record' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.getTaskSLA(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.pauseTaskSLA`, desc: 'Pause an active SLA timer. Typically used when waiting for customer response or external dependency.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the task_sla to pause' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.pauseTaskSLA(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.resumeTaskSLA`, desc: 'Resume a paused SLA timer. Restarts the SLA clock.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the task_sla to resume' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.resumeTaskSLA(s(inp,'id'), cfg)) }),
]; }

/* ================================================================
 *  PHASE 6 — Security Operations, Scripted REST
 * ================================================================ */
export function phase6(px: string, cfg: EnterpriseConnectorConfig, p: ServiceNowProvider): Tool[] { return [
  bt({ name: `${px}.listSecurityIncidents`, desc: 'List Security Incident Response (SIR) records. Used by SecOps teams for security event tracking. Returns severity, state, category, attack_vector, affected_cis.',
    params: { type: 'object', properties: { query: { type: 'string', description: 'Encoded query, e.g. "priority=1^state!=7"' }, limit: { type: 'number', description: 'Max results (default: 50)' } } },
    fn: async (_c, inp) => ok(await p.listSecurityIncidents(cfg, inp.arguments['query'] as string ?? '', n(inp,'limit',50))) }),
  bt({ name: `${px}.getSecurityIncident`, desc: 'Get a specific security incident by sys_id.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the security incident' } }, required: ['id'] },
    fn: async (_c, inp) => ok(await p.getSecurityIncident(s(inp,'id'), cfg)) }),
  bt({ name: `${px}.createSecurityIncident`, desc: 'Create a new Security Incident. Fields: short_description (required), category (Phishing, Malware, Data Loss, Unauthorized Access, DoS), severity (1–3), attack_vector, affected_cis.',
    params: { type: 'object', properties: { data: { type: 'object', description: 'Security incident fields: short_description (required), category, severity, attack_vector, description, assignment_group' } }, required: ['data'] },
    fn: async (_c, inp) => ok(await p.createSecurityIncident(o(inp,'data'), cfg)) }),
  bt({ name: `${px}.updateSecurityIncident`, desc: 'Update a security incident. Common updates: state, severity, containment_status, root_cause, remediation_plan.',
    params: { type: 'object', properties: { id: { type: 'string', description: 'sys_id of the security incident' }, data: { type: 'object', description: 'Fields to update' } }, required: ['id', 'data'] },
    fn: async (_c, inp) => ok(await p.updateSecurityIncident(s(inp,'id'), o(inp,'data'), cfg)) }),
  bt({ name: `${px}.listVulnerabilities`, desc: 'List vulnerability records from Vulnerability Response. Returns CVE, severity, affected hosts, remediation status.',
    params: { type: 'object', properties: { query: { type: 'string', description: 'Encoded query filter' }, limit: { type: 'number', description: 'Max results (default: 50)' } } },
    fn: async (_c, inp) => ok(await p.listVulnerabilities(cfg, inp.arguments['query'] as string ?? '', n(inp,'limit',50))) }),
  bt({ name: `${px}.listObservables`, desc: 'List observables (IOCs) linked to a security incident. Observables include IP addresses, domains, file hashes, URLs associated with threats.',
    params: { type: 'object', properties: { incidentId: { type: 'string', description: 'sys_id of the security incident' } }, required: ['incidentId'] },
    fn: async (_c, inp) => ok(await p.listObservables(s(inp,'incidentId'), cfg)) }),
  bt({ name: `${px}.addObservable`, desc: 'Add an observable (IOC) to a security incident. Types: ip_address, domain, url, file_hash, email_address.',
    params: { type: 'object', properties: { incidentId: { type: 'string', description: 'sys_id of the security incident' }, data: { type: 'object', description: '{ type: "ip_address"|"domain"|"url"|"file_hash", value: string, notes?: string }' } }, required: ['incidentId', 'data'] },
    fn: async (_c, inp) => ok(await p.addObservable(s(inp,'incidentId'), o(inp,'data'), cfg)) }),
  bt({ name: `${px}.callScriptedREST`, desc: 'Call a custom Scripted REST API endpoint. Scripted REST APIs are developer-created endpoints with custom logic. Specify HTTP method, path, and optional body.',
    params: { type: 'object', properties: { method: { type: 'string', description: 'HTTP method: GET, POST, PUT, PATCH, DELETE' }, path: { type: 'string', description: 'API path, e.g. /api/x_myapp/v1/my_endpoint' }, body: { type: 'object', description: 'Request body for POST/PUT/PATCH (optional)' } }, required: ['method', 'path'] },
    fn: async (_c, inp) => ok(await p.callScriptedREST(s(inp,'method'), s(inp,'path'), cfg, inp.arguments['body'] as Record<string, unknown>)) }),
  bt({ name: `${px}.listScriptedRESTApis`, desc: 'List all Scripted REST APIs defined in the instance. Returns API name, namespace, base_url, version, documentation_link.',
    params: { type: 'object', properties: {} },
    fn: async (_c, _inp) => ok(await p.listScriptedRESTApis(cfg)) }),
]; }

