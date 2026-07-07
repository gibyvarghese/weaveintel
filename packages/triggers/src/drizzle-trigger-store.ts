// SPDX-License-Identifier: MIT
/**
 * The TriggerStore, implemented ONCE against Drizzle and reused for both Postgres and SQLite (Phase 4).
 * No raw SQL, so the classic per-dialect drift bugs (`$1` vs `?`, `BOOLEAN` vs `INTEGER`, hand-rolled
 * JSON parsing) simply can't happen. The thin `weavePostgresTriggerStore` / `weaveSqliteTriggerStore`
 * factories wrap this with the right Drizzle handle + exec adapter.
 *
 * The `triggers` row is fully typed by Drizzle: `enabled` is a real boolean on both databases, and the
 * JSON columns come back as objects — so the mapping below reads them directly. A few newer fields
 * (owner/tenant/provenance) are tucked inside `metadata` under `__`-prefixed keys, exactly as before,
 * so nothing about the stored shape changes.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { newUUIDv7 } from '@weaveintel/core';
import type {
  Trigger, TriggerInvocation, TriggerStore, ListInvocationsFilter,
  TriggerSourceKind, TriggerTargetKind, TriggerInvocationStatus,
} from './dispatcher.js';
import type { DrizzleExec } from './drizzle-support.js';
import type { PgTriggers, PgInvocations } from './drizzle-trigger-schema.js';

interface TriggerRow {
  id: string; key: string; enabled: boolean; sourceKind: string;
  sourceConfig: Record<string, unknown> | null; filterExpr: { expression?: unknown } | null;
  targetKind: string; targetConfig: Record<string, unknown> | null;
  inputMap: Record<string, string> | null; rateLimitPerMinute: number | null;
  metadata: Record<string, unknown> | null;
}
interface InvocationRow {
  id: string; triggerId: string; firedAt: number; sourceKind: string; status: string;
  targetRef: string | null; errorMessage: string | null; sourceEvent: Record<string, unknown> | null;
}

function rowToTrigger(row: TriggerRow): Trigger {
  const { __ownerPrincipalId, __tenantId, __provenance, ...restMeta } = (row.metadata ?? {}) as Record<string, unknown>;
  const metadata = Object.keys(restMeta).length > 0 ? restMeta : undefined;
  const filter = row.filterExpr ?? undefined;
  return {
    id: row.id,
    key: row.key,
    enabled: row.enabled,
    source: { kind: row.sourceKind as TriggerSourceKind, config: row.sourceConfig ?? {} },
    target: { kind: row.targetKind as TriggerTargetKind, config: row.targetConfig ?? {} },
    ...(filter && filter.expression !== undefined ? { filter: { expression: filter.expression } } : {}),
    ...(row.inputMap ? { inputMap: row.inputMap } : {}),
    ...(row.rateLimitPerMinute != null ? { rateLimit: { perMinute: row.rateLimitPerMinute } } : {}),
    ...(metadata ? { metadata } : {}),
    ...(__ownerPrincipalId ? { ownerPrincipalId: __ownerPrincipalId as string } : {}),
    ...(__tenantId ? { tenantId: __tenantId as string } : {}),
    ...(__provenance ? { provenance: __provenance as { sourceRunId?: string; sourceRef?: string } } : {}),
  };
}

function rowToInvocation(row: InvocationRow): TriggerInvocation {
  return {
    id: row.id,
    triggerId: row.triggerId,
    firedAt: Number(row.firedAt),
    sourceKind: row.sourceKind as TriggerSourceKind,
    status: row.status as TriggerInvocationStatus,
    ...(row.targetRef != null ? { targetRef: row.targetRef } : {}),
    ...(row.errorMessage != null ? { errorMessage: row.errorMessage } : {}),
    ...(row.sourceEvent ? { sourceEvent: row.sourceEvent } : {}),
  };
}

export function createDrizzleTriggerStore(deps: {
  db: NodePgDatabase;
  triggers: PgTriggers;
  invocations: PgInvocations;
  exec: DrizzleExec;
}): TriggerStore {
  const { db, triggers, invocations, exec } = deps;

  const triggerValues = (t: Trigger) => {
    const metaObj: Record<string, unknown> = {
      ...(t.metadata ?? {}),
      ...(t.ownerPrincipalId ? { __ownerPrincipalId: t.ownerPrincipalId } : {}),
      ...(t.tenantId ? { __tenantId: t.tenantId } : {}),
      ...(t.provenance ? { __provenance: t.provenance } : {}),
    };
    return {
      id: t.id,
      key: t.key,
      enabled: t.enabled,
      sourceKind: t.source.kind,
      sourceConfig: t.source.config ?? {},
      filterExpr: t.filter ? { expression: t.filter.expression } : null,
      targetKind: t.target.kind,
      targetConfig: t.target.config ?? {},
      inputMap: t.inputMap ?? null,
      rateLimitPerMinute: t.rateLimit?.perMinute ?? null,
      metadata: Object.keys(metaObj).length > 0 ? metaObj : null,
    };
  };

  return {
    async list() {
      const rows = await exec.all<TriggerRow>(db.select().from(triggers).orderBy(asc(triggers.key)));
      return rows.map(rowToTrigger);
    },
    async get(id) {
      const rows = await exec.all<TriggerRow>(db.select().from(triggers).where(eq(triggers.id, id)).limit(1));
      return rows.length ? rowToTrigger(rows[0]!) : null;
    },
    async getByKey(key) {
      const rows = await exec.all<TriggerRow>(db.select().from(triggers).where(eq(triggers.key, key)).limit(1));
      return rows.length ? rowToTrigger(rows[0]!) : null;
    },
    async save(t) {
      const v = triggerValues(t);
      await exec.run(db.insert(triggers).values(v).onConflictDoUpdate({
        target: triggers.id,
        set: {
          key: v.key, enabled: v.enabled, sourceKind: v.sourceKind, sourceConfig: v.sourceConfig,
          filterExpr: v.filterExpr, targetKind: v.targetKind, targetConfig: v.targetConfig,
          inputMap: v.inputMap, rateLimitPerMinute: v.rateLimitPerMinute, metadata: v.metadata,
        },
      }));
    },
    async delete(id) {
      await exec.run(db.delete(triggers).where(eq(triggers.id, id)));
    },
    async recordInvocation(inv) {
      await exec.run(db.insert(invocations).values({
        id: inv.id || newUUIDv7(),
        triggerId: inv.triggerId,
        firedAt: inv.firedAt,
        sourceKind: inv.sourceKind,
        status: inv.status,
        targetRef: inv.targetRef ?? null,
        errorMessage: inv.errorMessage ?? null,
        sourceEvent: inv.sourceEvent ?? null,
      }));
    },
    async listInvocations(filter: ListInvocationsFilter = {}) {
      const conds = [
        filter.triggerId ? eq(invocations.triggerId, filter.triggerId) : undefined,
        filter.status ? eq(invocations.status, filter.status) : undefined,
      ].filter(Boolean);
      const rows = await exec.all<InvocationRow>(
        db.select().from(invocations)
          .where(conds.length ? and(...conds) : undefined)
          .orderBy(desc(invocations.firedAt), desc(invocations.id))
          .limit(filter.limit ?? 100)
          .offset(filter.offset ?? 0),
      );
      return rows.map(rowToInvocation);
    },
    async listByOwner(principalId: string) {
      const rows = await exec.all<TriggerRow>(db.select().from(triggers).orderBy(asc(triggers.key)));
      return rows.map(rowToTrigger).filter((t) => t.ownerPrincipalId === principalId);
    },
  };
}
