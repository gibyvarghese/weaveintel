/**
 * Phase 6 — Aggregated DB facade for one-call mesh hydration.
 *
 * `LiveAgentsDb` is the **single structural interface** that
 * `weaveLiveMeshFromDb` and `weaveLiveAgentFromDb` consume. It is the
 * intersection of every narrow row-reader interface previously defined
 * across the runtime package (provisioner + supervisor + run-bridge +
 * tool-binder + attention-factory + approval-handler).
 *
 * Why structural intersection (not import the geneweave adapter):
 *   - This package MUST NOT depend on `@weaveintel/geneweave` (or any app).
 *     Apps with very different DB schemas (Postgres, DynamoDB, in-memory
 *     fixtures for tests) need to satisfy the same contract by implementing
 *     a small set of methods.
 *   - Geneweave's `DatabaseAdapter` already implements every method below
 *     structurally, so passing it works without any wrapping.
 *
 * Path-specific requirements:
 *   - **Boot-existing-mesh path** (`weaveLiveMeshFromDb` with no
 *     `meshDefId`/`meshDefKey`): only the `SupervisorDb` + optional
 *     `AttentionPolicyDb` slices are read. Provisioner methods may be
 *     no-ops/throw.
 *   - **Provision-then-boot path**: every method is exercised. Tests
 *     should provide stubs for all of them.
 *   - **Single-agent path** (`weaveLiveAgentFromDb`): only the
 *     `SingleAgentReaderDb` slice (defined below) is read.
 *
 * Apps and tests are free to implement only the slice they exercise —
 * TypeScript will surface any missing method at the call site.
 */

import type { ProvisionMeshDb } from './mesh-provisioner.js';
import type { SupervisorDb } from './heartbeat-supervisor.js';
import type { AttentionPolicyDb } from './attention-factory.js';
import type { AgentToolBindingDb } from './tool-binder.js';

/**
 * Aggregated DB facade. Implementations satisfy this interface
 * structurally — geneweave's `DatabaseAdapter` already does.
 */
export interface LiveAgentsDb
  extends ProvisionMeshDb,
    SupervisorDb,
    AttentionPolicyDb,
    AgentToolBindingDb {}

/**
 * Narrow slice for `weaveLiveAgentFromDb`. Reads only what is needed to
 * load a single agent + its enabled handler binding + (optionally) its
 * tool surface. No write methods.
 */
export interface SingleAgentReaderDb extends AgentToolBindingDb {
  listLiveAgents(opts: {
    meshId?: string;
    status?: string;
  }): Promise<
    Array<{
      id: string;
      mesh_id: string;
      role_key: string;
      name: string;
      status: string;
      attention_policy_key: string | null;
    }>
  >;
  listLiveAgentHandlerBindings(opts: {
    agentId?: string;
    enabledOnly?: boolean;
  }): Promise<
    Array<{
      id: string;
      agent_id: string;
      handler_kind: string;
      config_json: string | null;
      enabled: number;
    }>
  >;
}
