/**
 * Example: Connector operations as data (@weaveintel/connect/runner)
 *
 * ─── What this shows ────────────────────────────────────────────────────────
 * A connector is DATA: an operation row (method, path, paging, outcomes) plus mapping rows (where each input goes,
 * what each output is read from). One generic runner sends it through YOUR door (`send`). There is no vendor client
 * code, so a partner can describe a whole connector as rows and the platform runs it.
 *
 * This example describes a few service-desk and issue-tracker operations as rows, then runs them against a
 * recording (the replay kit), so it needs no network and no keys:
 *
 *   1. A filtered list with QUERY CLAUSES: the field and operator are fixed by the row; only the value comes from the
 *      input, escaped for the query language, so an input can't widen the query.
 *   2. Creating an issue whose rich-text description is written as an ADF document (an ENCODING) from plain text.
 *   3. Updating custom fields by MERGING an input object into the body, only the keys the row allows.
 *   4. Uploading an attachment (MULTIPART with a platform file reference) and downloading one (a FILE answer).
 *   5. A SCIM list that counts from 1 (`offsetBase: 1`), and the rate-limit headers the runner hands back.
 *
 * ─── When to reach for it ───────────────────────────────────────────────────
 * Any time you integrate an HTTP API: write rows, not a client. Keep the network in your host (`send`), keep
 * credentials in `@weaveintel/connect/credentials`, and test every operation against a recording.
 *
 * Run: npx tsx examples/packages/connect-operations.ts
 */
import assert from 'node:assert/strict'
import { createReplaySend } from '@weaveintel/connect/replay'
import type { WireRequest } from '@weaveintel/connect'
import { runOperation, type OperationSpec, type RequestMapping, type ResponseMapping } from '@weaveintel/connect/runner'

const SN = 'https://acme.example.test'
const JIRA = 'https://acme-jira.example.test'

// The recording: what the services answered in their documentation's examples. Each exchange answers once.
const replay = createReplaySend({
  source: { kind: 'documentation', ref: 'examples/packages/connect-operations.ts', scrubbed: true },
  exchanges: [
    {
      name: 'open incidents for a caller',
      // The caret in the input is doubled, so it stays part of the value instead of starting an "OR".
      request: { method: 'GET', url: `${SN}/api/now/table/incident?sysparm_query=active%3Dtrue%5Ecaller_id%3Dabel%5E%5EORactive%3Dfalse%5EORDERBYDESCsys_created_on&sysparm_limit=2&sysparm_fields=number,short_description` },
      response: { status: 200, headers: { 'x-ratelimit-remaining': '41' }, body: JSON.stringify({ result: [{ number: 'INC0010001', short_description: 'VPN drops' }] }) },
    },
    {
      name: 'create an issue',
      request: { method: 'POST', url: `${JIRA}/rest/api/3/issue`, json: { fields: { project: { key: 'OPS' }, summary: 'VPN drops', issuetype: { name: 'Task' }, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Users in Auckland lose VPN.' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Started after the 9am change.' }] }] } } } },
      response: { status: 201, body: JSON.stringify({ id: '10042', key: 'OPS-42' }) },
    },
    {
      name: 'set custom fields',
      request: { method: 'PUT', url: `${JIRA}/rest/api/3/issue/OPS-42`, json: { fields: { customfield_10010: 'High', labels: ['vpn'] } } },
      response: { status: 204, body: '' },
    },
    {
      name: 'upload a log',
      request: { method: 'POST', url: `${JIRA}/rest/api/3/issue/OPS-42/attachments`, headers: { 'x-atlassian-token': 'no-check' }, parts: [{ name: 'file', fileRef: 'platform-file-7' }] },
      response: { status: 200, body: JSON.stringify([{ id: '555', filename: 'vpn.log' }]) },
    },
    {
      name: 'download it again',
      request: { method: 'GET', url: `${JIRA}/rest/api/3/attachment/content/555` },
      // The door stores the bytes as a platform file and answers with its reference; the runner never holds bytes.
      response: { status: 200, body: '', file: { ref: 'platform-file-8', filename: 'vpn.log', contentType: 'text/plain' } },
    },
    { name: 'SCIM page 1', request: { method: 'GET', url: `${SN}/api/now/scim/Users?startIndex=1&count=2` }, response: { status: 200, body: JSON.stringify({ totalResults: 3, Resources: [{ userName: 'abel' }, { userName: 'beth' }] }) } },
    { name: 'SCIM page 2', request: { method: 'GET', url: `${SN}/api/now/scim/Users?startIndex=3&count=2` }, response: { status: 200, body: JSON.stringify({ totalResults: 3, Resources: [{ userName: 'cara' }] }) } },
  ],
})

// Everything a run needs besides the rows. A real host passes its own door and applies the connection's credential.
const host = { send: replay.send, settings: {}, credential: async (request: WireRequest) => ({ ok: true as const, request }) }
const run = (spec: OperationSpec, request: RequestMapping[], response: ResponseMapping[], outputs: string[], input: Record<string, unknown>, label: string) =>
  runOperation({ spec, request, response, outputs: outputs.map((name) => ({ name })), input, label, ...host })

async function main(): Promise<void> {
  // 1. Query clauses.
  const list = await run(
    { key: 'sn.list_incidents', method: 'GET', baseUrl: SN, pathTemplate: '/api/now/table/incident', bodyFormat: 'none', idempotency: 'none', itemsPath: 'result', paging: { style: 'link_header', pageSizeParam: 'sysparm_limit', pageSize: 2 } },
    [
      { from: 'fixed', source: 'true', target: 'query:sysparm_query', clause: { dialect: 'servicenow_encoded', field: 'active', operator: '=' } },
      { from: 'input', source: 'caller', target: 'query:sysparm_query', clause: { dialect: 'servicenow_encoded', field: 'caller_id', operator: '=' } },
      { from: 'fixed', source: '', target: 'query:sysparm_query', clause: { dialect: 'servicenow_encoded', field: 'sys_created_on', operator: 'order_by_desc' } },
      { from: 'fixed', source: 'number,short_description', target: 'query:sysparm_fields' },
    ],
    [{ source: 'number', target: 'number', itemOf: 'incidents' }, { source: 'short_description', target: 'summary', itemOf: 'incidents' }],
    ['incidents'],
    { caller: 'abel^ORactive=false' },
    'List open incidents',
  )
  assert.equal(list.outcome, 'ok')
  assert.deepEqual(list.output['incidents'], [{ number: 'INC0010001', summary: 'VPN drops' }])
  assert.deepEqual(list.rateLimit, { 'x-ratelimit-remaining': '41' })
  console.log('1. list with query clauses:', list.output['incidents'])

  // 2. ADF encoding.
  const created = await run(
    { key: 'jira.create_issue', method: 'POST', baseUrl: JIRA, pathTemplate: '/rest/api/3/issue', bodyFormat: 'json', idempotency: 'none' },
    [
      { from: 'input', source: 'project', target: 'body:fields.project.key', required: true },
      { from: 'input', source: 'summary', target: 'body:fields.summary', transform: 'trim', required: true },
      { from: 'fixed', source: 'Task', target: 'body:fields.issuetype.name' },
      { from: 'input', source: 'description', target: 'body:fields.description', encoding: 'adf_document' },
    ],
    [{ source: 'key', target: 'key' }],
    ['key'],
    { project: 'OPS', summary: ' VPN drops ', description: 'Users in Auckland lose VPN.\n\nStarted after the 9am change.' },
    'Create an issue',
  )
  assert.equal(created.output['key'], 'OPS-42')
  console.log('2. created with an ADF description:', created.output['key'])

  // 3. Merge only the allowed keys.
  const updated = await run(
    { key: 'jira.set_fields', method: 'PUT', baseUrl: JIRA, pathTemplate: '/rest/api/3/issue/{key}', bodyFormat: 'json', idempotency: 'inherently_idempotent' },
    [{ from: 'input', source: 'key', target: 'path:key' }, { from: 'input', source: 'fields', target: 'body:fields.*', allowKeys: ['labels', 'customfield_*'] }],
    [], [],
    { key: 'OPS-42', fields: { customfield_10010: 'High', labels: ['vpn'] } },
    'Set fields',
  )
  assert.equal(updated.outcome, 'ok')
  const refused = await run(
    { key: 'jira.set_fields', method: 'PUT', baseUrl: JIRA, pathTemplate: '/rest/api/3/issue/{key}', bodyFormat: 'json', idempotency: 'inherently_idempotent' },
    [{ from: 'input', source: 'key', target: 'path:key' }, { from: 'input', source: 'fields', target: 'body:fields.*', allowKeys: ['labels', 'customfield_*'] }],
    [], [],
    { key: 'OPS-42', fields: { reporter: { accountId: 'someone-else' } } },
    'Set fields',
  )
  assert.equal(refused.outcome, 'refused') // the reporter is not an allowed key: nothing was sent
  console.log('3. merged allowed keys; refused', refused.sentence)

  // 4. Files.
  const up = await run(
    { key: 'jira.attach', method: 'POST', baseUrl: JIRA, pathTemplate: '/rest/api/3/issue/{key}/attachments', bodyFormat: 'multipart', idempotency: 'none' },
    [{ from: 'input', source: 'key', target: 'path:key' }, { from: 'input', source: 'file', target: 'part:file' }, { from: 'fixed', source: 'no-check', target: 'header:x-atlassian-token' }],
    [{ source: '0.id', target: 'attachment_id' }], ['attachment_id'],
    { key: 'OPS-42', file: { ref: 'platform-file-7', filename: 'vpn.log' } },
    'Attach a file',
  )
  assert.equal(up.output['attachment_id'], '555')
  const down = await run(
    { key: 'jira.download', method: 'GET', baseUrl: JIRA, pathTemplate: '/rest/api/3/attachment/content/{id}', bodyFormat: 'none', idempotency: 'none', responseFormat: 'file' },
    [{ from: 'input', source: 'id', target: 'path:id' }],
    [{ source: '$file', target: 'file' }], ['file'],
    { id: '555' },
    'Download an attachment',
  )
  assert.deepEqual(down.output['file'], { ref: 'platform-file-8', filename: 'vpn.log', contentType: 'text/plain' })
  console.log('4. uploaded and downloaded by file reference:', down.output['file'])

  // 5. SCIM counts from 1.
  const users = await run(
    { key: 'sn.scim_users', method: 'GET', baseUrl: SN, pathTemplate: '/api/now/scim/Users', bodyFormat: 'none', idempotency: 'none', itemsPath: 'Resources', paging: { style: 'offset_limit', offsetParam: 'startIndex', offsetBase: 1, pageSizeParam: 'count', pageSize: 2, totalPath: 'totalResults' } },
    [], [{ source: 'userName', target: 'user', itemOf: 'users' }], ['users'], {}, 'List users',
  )
  assert.deepEqual(users.output['users'], [{ user: 'abel' }, { user: 'beth' }, { user: 'cara' }])
  console.log('5. SCIM paged from 1:', users.pages, 'pages')

  assert.deepEqual(replay.unused(), [])
  console.log('All operations ran from rows; every recorded exchange was used.')
}

main().catch((e: unknown) => { console.error(e); process.exit(1) })
