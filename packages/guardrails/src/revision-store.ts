/**
 * @weaveintel/guardrails — revision-store.ts  (W7)
 *
 * Append-only guardrail revision store. Records a snapshot every time a
 * guardrail is created, updated, or disabled, making the history of rule
 * changes auditable.
 *
 * `trackGuardrailChange` is the high-level helper: it creates the revision
 * record, persists it to the store, and emits a `weaveAudit` entry so the
 * change appears in the durable audit log.
 */
import type { ExecutionContext, Guardrail, GuardrailRevision, GuardrailRevisionStore } from '@weaveintel/core';
import { weaveAudit } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';

export type { GuardrailRevision, GuardrailRevisionStore };

export class InMemoryRevisionStore implements GuardrailRevisionStore {
  private readonly store = new Map<string, GuardrailRevision[]>();

  async record(revision: GuardrailRevision): Promise<void> {
    const existing = this.store.get(revision.guardrailId) ?? [];
    this.store.set(revision.guardrailId, [...existing, revision]);
  }

  async list(guardrailId: string): Promise<GuardrailRevision[]> {
    return [...(this.store.get(guardrailId) ?? [])];
  }

  async atTime(guardrailId: string, timestamp: string): Promise<GuardrailRevision | undefined> {
    const revisions = this.store.get(guardrailId) ?? [];
    // Find the latest revision whose timestamp is ≤ the query timestamp.
    const target = timestamp;
    let best: GuardrailRevision | undefined;
    for (const rev of revisions) {
      if (rev.timestamp <= target) {
        best = rev;
      }
    }
    return best;
  }
}

export function createRevisionStore(): InMemoryRevisionStore {
  return new InMemoryRevisionStore();
}

export interface TrackGuardrailChangeOptions {
  readonly guardrailId: string;
  readonly actor: string;
  readonly reason: string;
  readonly snapshot: Guardrail;
  readonly before?: Guardrail;
}

/**
 * Record a guardrail change: create a revision, persist it, and emit a
 * `weaveAudit` entry. Call this whenever a guardrail is created, updated,
 * or disabled.
 */
export async function trackGuardrailChange(
  store: GuardrailRevisionStore,
  ctx: ExecutionContext,
  opts: TrackGuardrailChangeOptions,
): Promise<GuardrailRevision> {
  const existing = await store.list(opts.guardrailId);
  const version = existing.length + 1;

  const revision: GuardrailRevision = {
    id: newUUIDv7(),
    guardrailId: opts.guardrailId,
    version,
    snapshot: opts.snapshot,
    before: opts.before,
    actor: opts.actor,
    reason: opts.reason,
    timestamp: new Date().toISOString(),
  };

  await store.record(revision);

  void weaveAudit(ctx, {
    action: 'guardrail.rule.changed',
    outcome: 'success',
    resource: opts.guardrailId,
    details: {
      version,
      actor: opts.actor,
      reason: opts.reason,
      enabled: opts.snapshot.enabled,
      changeType: opts.before === undefined ? 'created' : opts.snapshot.enabled !== opts.before.enabled ? 'toggled' : 'updated',
    },
  });

  return revision;
}
