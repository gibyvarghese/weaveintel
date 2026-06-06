/**
 * @weaveintel/guardrails — resolver.ts  (W6)
 *
 * Per-tenant guardrail policy resolution. The `GuardrailResolver` interface
 * (defined in core) allows the pipeline to load different guardrail sets per
 * tenant/persona rather than a single global list.
 *
 * Resolution order (global → tenant → persona):
 *   1. Start with global guardrails.
 *   2. Override/merge with tenant-specific guardrails (same ID wins for tenant).
 *   3. Override/merge with persona-specific guardrails.
 *
 * When a later-layer guardrail has the same `id` as an earlier one, the later
 * definition replaces it entirely. To disable a global guardrail for a tenant,
 * add a row with the same ID and `enabled: false`.
 */
import type { Guardrail, GuardrailResolver, GuardrailResolverContext, GuardrailStage } from '@weaveintel/core';

export type { GuardrailResolver, GuardrailResolverContext };

function mergeGuardrails(base: Guardrail[], overlay: Guardrail[]): Guardrail[] {
  const map = new Map<string, Guardrail>(base.map(g => [g.id, g]));
  for (const g of overlay) {
    map.set(g.id, g);
  }
  return [...map.values()];
}

function filterByStage(guardrails: Guardrail[], stage: GuardrailStage): Guardrail[] {
  return guardrails.filter(g => g.stage === stage || (g.stage as string) === 'both');
}

export class InMemoryGuardrailResolver implements GuardrailResolver {
  private global: Guardrail[] = [];
  private readonly tenantMap = new Map<string, Guardrail[]>();
  private readonly personaMap = new Map<string, Guardrail[]>();

  /** Set the global baseline guardrail set (applied to all tenants). */
  setGlobal(guardrails: Guardrail[]): this {
    this.global = [...guardrails];
    return this;
  }

  /** Set tenant-specific guardrails. These override global ones with the same ID. */
  setTenant(tenantId: string, guardrails: Guardrail[]): this {
    this.tenantMap.set(tenantId, [...guardrails]);
    return this;
  }

  /** Set persona-specific guardrails. These override tenant ones with the same ID. */
  setPersona(persona: string, guardrails: Guardrail[]): this {
    this.personaMap.set(persona, [...guardrails]);
    return this;
  }

  async resolve(ctx: GuardrailResolverContext): Promise<Guardrail[]> {
    let resolved = [...this.global];

    if (ctx.tenantId) {
      const tenantGuardrails = this.tenantMap.get(ctx.tenantId);
      if (tenantGuardrails) {
        resolved = mergeGuardrails(resolved, tenantGuardrails);
      }
    }

    if (ctx.persona) {
      const personaGuardrails = this.personaMap.get(ctx.persona);
      if (personaGuardrails) {
        resolved = mergeGuardrails(resolved, personaGuardrails);
      }
    }

    return filterByStage(resolved, ctx.stage).filter(g => g.enabled);
  }
}

export function createGuardrailResolver(): InMemoryGuardrailResolver {
  return new InMemoryGuardrailResolver();
}
