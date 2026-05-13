/**
 * @weaveintel/encryption — DEK / KEK rotators.
 *
 * Thin user-facing wrappers around `TenantKeyManager.rotateDek` /
 * `.rotateKek`. They exist as standalone callables so cron jobs,
 * admin routes, and rotation-driver code can depend on a focused
 * interface (`rotate(tenantId, actor) → Promise<{...}>`) without
 * pulling in the full key-manager surface.
 *
 * Both rotators inherit the manager's audit emission (`dek_rotate`
 * / `kek_rotate`) and previous-key transition (`active → previous`).
 * Old ciphertext stays readable until the rewrite scheduler walks
 * every sentinel forward AND an operator separately revokes the
 * old keys (Phase 5 ships only the rewrite half — revocation is a
 * follow-up phase).
 */

import type { TenantKeyManager } from './key-manager.js';

export interface DekRotationResult {
  readonly tenantId: string;
  readonly dekId: string;
  readonly epoch: number;
}

export interface KekRotationResult {
  readonly tenantId: string;
  readonly kekId: string;
  readonly version: number;
}

export interface DekRotator {
  rotate(tenantId: string, actor?: string | null): Promise<DekRotationResult>;
}

export interface KekRotator {
  rotate(tenantId: string, actor?: string | null): Promise<KekRotationResult>;
}

export interface WeaveDekRotatorOptions {
  readonly manager: TenantKeyManager;
}

export interface WeaveKekRotatorOptions {
  readonly manager: TenantKeyManager;
}

export function weaveDekRotator(opts: WeaveDekRotatorOptions): DekRotator {
  return {
    async rotate(tenantId, actor = null) {
      const dek = await opts.manager.rotateDek(tenantId, actor);
      return { tenantId, dekId: dek.id, epoch: dek.epoch };
    },
  };
}

export function weaveKekRotator(opts: WeaveKekRotatorOptions): KekRotator {
  return {
    async rotate(tenantId, actor = null) {
      const kek = await opts.manager.rotateKek(tenantId, actor);
      return { tenantId, kekId: kek.id, version: kek.version };
    },
  };
}
