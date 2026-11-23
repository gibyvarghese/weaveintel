/**
 * Zero copy (FRAMEWORK 4.2): a connector's objects, read in place through the operation runner, offered as a source
 * that schemaWeave `@schemaweave/virtual` can mount as a table.
 *
 * WHAT THIS IS (plain language)
 * schemaWeave already knows how to show a table whose rows live somewhere else: it plans each query, pushes down the
 * filters the source says it can do, re-checks every row it gets back against the full condition, caches for display
 * and can promote the table to a real copy later. What it needs is a SOURCE: something with `describeSchema`,
 * `capabilities`, `query` and `get`. This file builds one from a connector's operation rows. There is no second query
 * path: every read is one `runOperation` with the connection's own credential and the host's own door.
 *
 * WHY THE TYPES ARE WRITTEN HERE
 * This package has no dependencies. The shapes below are structurally the same as schemaWeave's
 * `SourceConnectorPort` (`@schemaweave/protocol`, `ports/source-connector.ts`) and its condition tree, so a host that
 * has both libraries registers the result directly: `registry.register(name, createRunnerSource(...))`.
 *
 * READ-ONLY. A mounted connector table accepts no writes (FRAMEWORK 4.2): `create` and `update` refuse, and the
 * capabilities say so. Changes go through the connector's tools and the outside system is read again.
 *
 * PUSHDOWN IS DATA. A table declares which (column, operator) pairs its list operation can take and the tool input
 * each fills. Only plain AND-ed rules with literal values are pushed; anything else is left to schemaWeave's residual
 * filter, which re-applies the whole condition to every row anyway.
 *
 * Not yet: the caller's identity (schemaWeave S3, so a source can run as the person), cursors across queries, and
 * pushed sorting. A list operation pages inside one run, up to its own page cap.
 */
import type { ApplyResult } from '../credentials/apply.js'
import { runOperation } from '../runner/run.js'
import type { ChoiceMaps } from '../runner/transforms.js'
import type { DeclaredOutput, OperationSpec, RequestMapping, ResponseMapping } from '../runner/spec.js'
import type { Send, WireRequest } from '../types.js'
import { odataFilter, odataOperation, type ODataComparison, type ODataSource } from './odata.js'

/** A JSON value, as schemaWeave's ports speak it (mutable arrays and objects, unlike the runner's readonly Json). */
export type SourceJson = string | number | boolean | null | SourceJson[] | { [key: string]: SourceJson }

/** What the source can do (same shape as schemaWeave `SourceCapabilities`). */
export interface RunnerSourceCapabilities {
  readonly filter: boolean
  readonly sort: boolean
  readonly pagination: boolean
  readonly operators: readonly string[]
  readonly writes: boolean
}

/** One column (same shape as schemaWeave `SourceField`). */
export interface RunnerSourceField {
  readonly name: string
  readonly nativeType: string
  readonly nullable: boolean
}

/** A table's schema (same shape as schemaWeave `SourceSchema`). */
export interface RunnerSourceSchema {
  readonly name: string
  readonly fields: readonly RunnerSourceField[]
  readonly primaryKey: readonly string[]
}

/** A condition leaf or group (same shape as schemaWeave's condition AST). */
export type RunnerCondition =
  | { readonly field: string; readonly operator: string; readonly value?: SourceJson | undefined; readonly valueSource?: string | undefined }
  | { readonly combinator: 'and' | 'or'; readonly not?: boolean | undefined; readonly rules: readonly RunnerCondition[] }

/** A read (same shape as schemaWeave `SourceQuery`). */
export interface RunnerSourceQuery {
  readonly table: string
  readonly where?: SourceJson | undefined
  readonly orderBy?: readonly { readonly field: string; readonly direction: 'asc' | 'desc' }[] | undefined
  readonly limit?: number | undefined
  readonly cursor?: string | undefined
}

/** What a read returns (same shape as schemaWeave `SourceQueryResult`). */
export interface RunnerSourceQueryResult {
  readonly rows: readonly Readonly<Record<string, SourceJson>>[]
  readonly nextCursor?: string
  readonly residual?: SourceJson
}

/** The port itself (same shape as schemaWeave `SourceConnectorPort`). */
export interface RunnerSourcePort {
  describeSchema(table: string): Promise<RunnerSourceSchema>
  capabilities(table: string): Promise<RunnerSourceCapabilities>
  query(q: RunnerSourceQuery): Promise<RunnerSourceQueryResult>
  get(table: string, id: string): Promise<Readonly<Record<string, SourceJson>> | undefined>
  create(table: string, row: Readonly<Record<string, SourceJson>>): Promise<string>
  update(table: string, id: string, patch: Readonly<Record<string, SourceJson>>): Promise<void>
}

/** One runner operation, as rows describe it. */
export interface RunnerOperation {
  readonly spec: OperationSpec
  readonly request: readonly RequestMapping[]
  readonly response: readonly ResponseMapping[]
  readonly outputs: readonly DeclaredOutput[]
}

/** A filter the list operation can take: `column operator value` becomes the tool input `input`. */
export interface PushableFilter {
  readonly field: string
  /** A schemaWeave condition operator (`=`, `!=`, `>`, `>=`, `<`, `<=`, …). */
  readonly operator: string
  readonly input: string
}

/** One mounted table. */
export interface RunnerSourceTable {
  /** The name schemaWeave mounts it under. */
  readonly table: string
  readonly fields: readonly RunnerSourceField[]
  readonly primaryKey: readonly string[]
  /** The list operation. Its list output's items are the rows; only the declared fields are kept. */
  readonly list: RunnerOperation
  /** The list output's name (default `items`). */
  readonly listOutput?: string | undefined
  readonly filters?: readonly PushableFilter[] | undefined
  /** The tool input that takes the limit, when the operation has one. */
  readonly limitInput?: string | undefined
  /** Fixed inputs every list run gets. */
  readonly fixedInput?: Readonly<Record<string, unknown>> | undefined
  /** Turns the input before it runs (an OData source builds its `$filter` here). */
  readonly prepareInput?: ((input: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>) | undefined
  /** A single-record operation and the input that takes the id. Without one, `get` lists by the primary key. */
  readonly get?: { readonly operation: RunnerOperation; readonly idInput: string; readonly output?: string | undefined } | undefined
}

/** Everything a run needs besides the operation: the same pieces a tool call gets. */
export interface RunnerSourceContext {
  readonly settings: Readonly<Record<string, string>>
  readonly credential: (request: WireRequest) => Promise<ApplyResult>
  readonly send: Send
  readonly choiceMaps?: ChoiceMaps | undefined
  /** The connection's name, for sentences. */
  readonly label: string
}

/** A read that failed. schemaWeave shows the failure loudly rather than an empty table. */
export class SourceReadError extends Error {
  constructor(readonly code: string, sentence: string) {
    super(sentence)
    this.name = 'SourceReadError'
  }
}

const isGroup = (n: RunnerCondition): n is Extract<RunnerCondition, { combinator: string }> => typeof (n as { combinator?: unknown }).combinator === 'string'

/** The plain AND-ed literal rules of a condition (the only ones safe to turn into inputs). */
function conjuncts(node: RunnerCondition): readonly Extract<RunnerCondition, { field: string }>[] {
  if (!isGroup(node)) return node.valueSource === undefined || node.valueSource === 'value' ? [node] : []
  if (node.not === true || node.combinator === 'or') return []
  return node.rules.flatMap(conjuncts)
}

const isScalar = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

/**
 * Build a zero-copy source over connector operations.
 * @param tables The mounted tables.
 * @param context The connection's settings, credential, door and label.
 * @throws when two tables share a name.
 */
export function createRunnerSource(tables: readonly RunnerSourceTable[], context: RunnerSourceContext): RunnerSourcePort {
  const byName = new Map<string, RunnerSourceTable>()
  for (const t of tables) {
    if (byName.has(t.table)) throw new Error(`The table “${t.table}” is described twice.`)
    byName.set(t.table, t)
  }
  const tableOf = (name: string): RunnerSourceTable => {
    const t = byName.get(name)
    if (t === undefined) throw new SourceReadError('UNKNOWN_TABLE', `${context.label} has no table called “${name}”.`)
    return t
  }
  const keep = (t: RunnerSourceTable, item: unknown): Record<string, SourceJson> => {
    const row: Record<string, SourceJson> = {}
    const from = (item ?? {}) as Record<string, unknown>
    for (const f of t.fields) row[f.name] = (from[f.name] ?? null) as SourceJson
    return row
  }
  const run = async (op: RunnerOperation, input: Readonly<Record<string, unknown>>) => {
    const r = await runOperation({ ...op, input, settings: context.settings, credential: context.credential, send: context.send, label: context.label, ...(context.choiceMaps === undefined ? {} : { choiceMaps: context.choiceMaps }) })
    if (r.outcome !== 'ok' && r.outcome !== 'not_found') throw new SourceReadError(r.code, r.sentence)
    return r
  }

  async function list(t: RunnerSourceTable, where: SourceJson | undefined, limit: number | undefined): Promise<RunnerSourceQueryResult> {
    const input: Record<string, unknown> = { ...(t.fixedInput ?? {}) }
    if (where !== undefined && where !== null) {
      for (const rule of conjuncts(where as unknown as RunnerCondition)) {
        const f = (t.filters ?? []).find((x) => x.field === rule.field && x.operator === rule.operator)
        // A pushed rule only narrows the request; schemaWeave re-checks every row, so a rule left out is never a leak.
        if (f !== undefined && isScalar(rule.value) && !(f.input in input)) input[f.input] = rule.value
      }
    }
    if (limit !== undefined && t.limitInput !== undefined) input[t.limitInput] = limit
    const r = await run(t.list, t.prepareInput === undefined ? input : t.prepareInput(input))
    const items = r.outcome === 'ok' ? r.output[t.listOutput ?? 'items'] : []
    const rows = (Array.isArray(items) ? items : []).map((i) => keep(t, i))
    return { rows: limit === undefined ? rows : rows.slice(0, limit), ...(where === undefined ? {} : { residual: where }) }
  }

  return {
    async describeSchema(name) {
      const t = tableOf(name)
      return { name: t.table, fields: t.fields, primaryKey: t.primaryKey }
    },
    async capabilities(name) {
      const t = tableOf(name)
      const operators = [...new Set((t.filters ?? []).map((f) => f.operator))]
      return { filter: operators.length > 0, sort: false, pagination: t.limitInput !== undefined, operators, writes: false }
    },
    async query(q) {
      return list(tableOf(q.table), q.where, q.limit)
    },
    async get(name, id) {
      const t = tableOf(name)
      if (t.get !== undefined) {
        const r = await run(t.get.operation, { ...(t.fixedInput ?? {}), [t.get.idInput]: id })
        if (r.outcome !== 'ok') return undefined
        const one = t.get.output === undefined ? r.output : r.output[t.get.output]
        return one === undefined || one === null ? undefined : keep(t, one)
      }
      const key = t.primaryKey[0]
      if (key === undefined || t.primaryKey.length !== 1) return undefined
      const { rows } = await list(t, { field: key, operator: '=', value: id }, undefined)
      return rows.find((row) => String(row[key]) === id)
    },
    async create() {
      throw new SourceReadError('READ_ONLY', `${context.label} is read in place here; records are added through its tools.`)
    },
    async update() {
      throw new SourceReadError('READ_ONLY', `${context.label} is read in place here; records are changed through its tools.`)
    },
  }
}

const ODATA_OPERATORS: Readonly<Record<ODataComparison, string>> = { eq: '=', ne: '!=', gt: '>', ge: '>=', lt: '<', le: '<=' }

/**
 * An OData source as a mounted table: its selected fields become the columns, its filters become the pushable rules
 * (`City eq <city>` pushes the rule `city = …` when `city` is the column the field lands in), and its `$filter` is
 * built from the inputs exactly as for a tool call.
 * @param source The OData source.
 * @param table The table name (default the source key) and the primary key column(s).
 */
export function odataSourceTable(source: ODataSource, table: { readonly name?: string | undefined; readonly primaryKey: readonly string[]; readonly nativeType?: (column: string) => string }): RunnerSourceTable {
  const op = odataOperation(source)
  const columnOf = (field: string): string | undefined => source.select.find((s) => s.field === field)?.output
  const filters: PushableFilter[] = []
  for (const f of source.filters ?? []) {
    const column = columnOf(f.field)
    if (column !== undefined) filters.push({ field: column, operator: ODATA_OPERATORS[f.op], input: f.input })
  }
  return {
    table: table.name ?? source.key,
    fields: source.select.map((s) => ({ name: s.output, nativeType: table.nativeType?.(s.output) ?? 'Edm.String', nullable: !table.primaryKey.includes(s.output) })),
    primaryKey: table.primaryKey,
    list: op,
    listOutput: source.output ?? 'items',
    filters,
    prepareInput: (input) => odataFilter(source, input),
  }
}
