/**
 * Phase 6 — Tests for `weaveLiveMeshFromDb` and `weaveLiveAgentFromDb`.
 *
 * Uses a Map-backed stub DB and `weaveInMemoryStateStore` so the entire
 * flow runs in-process with zero external services. Verifies the two
 * primary contracts:
 *
 *   1. `weaveLiveMeshFromDb` (boot-existing path) builds a supervisor
 *      against an existing mesh, returns a `stop()` that resolves cleanly,
 *      and registers the four built-in handler kinds plus any caller
 *      extras.
 *
 *   2. `weaveLiveAgentFromDb` resolves a single agent's enabled binding
 *      and returns a runnable `TaskHandler`. Errors when the agent is
 *      unknown or has no enabled binding.
 *
 * The provision-then-boot path is exercised indirectly via the example
 * runner (`examples/96-live-agents-phase6-mesh-from-db.ts`).
 */

import { describe, it, expect } from 'vitest';
import { weaveInMemoryStateStore } from '@weaveintel/live-agents';
import type { TaskHandler } from '@weaveintel/live-agents';

import { weaveLiveMeshFromDb } from './weave-live-mesh-from-db.js';
import { weaveLiveAgentFromDb } from './weave-live-agent-from-db.js';
import type { HandlerKindRegistration } from './handler-registry.js';
import type { LiveAgentsDb, SingleAgentReaderDb } from './db-types.js';

// ─── In-memory stub DB ───────────────────────────────────────

interface StubMesh {
  id: string;
  status: string;
}
interface StubAgent {
  id: string;
  mesh_id: string;
  role_key: string;
  name: string;
  status: string;
  attention_policy_key: string | null;
}
interface StubBinding {
  id: string;
  agent_id: string;
  handler_kind: string;
  config_json: string | null;
  enabled: number;
}

function makeStubDb(opts: {
  meshes: StubMesh[];
  agents: StubAgent[];
  bindings: StubBinding[];
}): LiveAgentsDb {
  // Only the methods the boot-existing-mesh path actually calls.
  // Provisioner / tool-binder / attention methods throw — they're not
  // exercised when no `provision` opt is passed and no agents declare a
  // tool/attention key.
  const noop = async () => undefined;
  return {
    listLiveMeshes: async () =>
      opts.meshes
        .filter((m) => m.status === 'ACTIVE')
        .map((m) => ({ id: m.id, tenant_id: null, name: m.id, status: m.status })),
    listLiveAgents: async ({ meshId, status }: { meshId?: string; status?: string }) =>
      opts.agents
        .filter((a) => (meshId ? a.mesh_id === meshId : true))
        .filter((a) => (status ? a.status === status : true)),
    listLiveAgentHandlerBindings: async ({
      agentId,
      enabledOnly,
    }: {
      agentId?: string;
      enabledOnly?: boolean;
    }) =>
      opts.bindings
        .filter((b) => (agentId ? b.agent_id === agentId : true))
        .filter((b) => (enabledOnly ? b.enabled === 1 : true)),
    // Run-bridge needs these but we have no RUNNING runs, so they return [].
    listLiveRuns: async () => [],
    listLiveRunSteps: async () => [],
    updateLiveRunStep: noop as unknown as LiveAgentsDb['updateLiveRunStep'],
    appendLiveRunEvent: noop as unknown as LiveAgentsDb['appendLiveRunEvent'],
    // Tool-binder + attention-factory + provisioner — unused in boot-only path.
    listLiveAgentToolBindings: async () => [],
    getToolConfig: async () => null,
    getLiveAttentionPolicyByKey: async () => null,
    getLiveMeshDefinition: async () => null,
    getLiveMeshDefinitionByKey: async () => null,
    listLiveAgentDefinitions: async () => [],
    listLiveMeshDelegationEdges: async () => [],
    listToolConfigs: async () => [],
    createLiveMesh: noop as unknown as LiveAgentsDb['createLiveMesh'],
    createLiveAgent: noop as unknown as LiveAgentsDb['createLiveAgent'],
    createLiveAgentHandlerBinding:
      noop as unknown as LiveAgentsDb['createLiveAgentHandlerBinding'],
    createLiveAgentToolBinding:
      noop as unknown as LiveAgentsDb['createLiveAgentToolBinding'],
  } as unknown as LiveAgentsDb;
}

// A trivial handler kind to verify extras are wired into the registry.
const echoKind: HandlerKindRegistration = {
  kind: 'test.echo',
  description: 'Returns a static success result. Test-only.',
  factory: (): TaskHandler =>
    async () => ({ completed: true, summaryProse: 'echo' }),
};

// ─── Tests ──────────────────────────────────────────────────

describe('weaveLiveMeshFromDb (boot existing)', () => {
  it('boots a supervisor and stops cleanly', async () => {
    const db = makeStubDb({
      meshes: [{ id: 'mesh-1', status: 'ACTIVE' }],
      agents: [
        {
          id: 'agent-1',
          mesh_id: 'mesh-1',
          role_key: 'echoer',
          name: 'Echo Agent',
          status: 'ACTIVE',
          attention_policy_key: null,
        },
      ],
      bindings: [
        {
          id: 'b-1',
          agent_id: 'agent-1',
          handler_kind: 'test.echo',
          config_json: null,
          enabled: 1,
        },
      ],
    });
    const store = weaveInMemoryStateStore();

    const handle = await weaveLiveMeshFromDb(db, {
      store,
      extraHandlerKinds: [echoKind],
      intervalMs: 60_000, // long interval so the test finishes before any tick fires
      refreshMs: 60_000,
      logger: () => {},
    });

    expect(handle.provisioned).toBeNull();
    expect(handle.handlerRegistry.kinds()).toContain('test.echo');
    expect(handle.handlerRegistry.kinds()).toContain('agentic.react');
    expect(handle.supervisor).toBeDefined();

    await handle.stop();
    // Second stop should be a no-op (idempotent).
    await handle.stop();
  });

  it('uses caller-supplied handler registry when provided', async () => {
    const db = makeStubDb({ meshes: [], agents: [], bindings: [] });
    const store = weaveInMemoryStateStore();

    // Only register the echo kind; built-ins should NOT be added.
    const { createHandlerRegistry } = await import('./handler-registry.js');
    const registry = createHandlerRegistry();
    registry.register(echoKind);

    const handle = await weaveLiveMeshFromDb(db, {
      store,
      handlerRegistry: registry,
      intervalMs: 60_000,
      refreshMs: 60_000,
      logger: () => {},
    });

    expect(handle.handlerRegistry.kinds()).toEqual(['test.echo']);
    await handle.stop();
  });
});

describe('weaveLiveAgentFromDb', () => {
  const db: SingleAgentReaderDb = {
    listLiveAgents: async () => [
      {
        id: 'a-1',
        mesh_id: 'm-1',
        role_key: 'echoer',
        name: 'Echo',
        status: 'ACTIVE',
        attention_policy_key: null,
      },
    ],
    listLiveAgentHandlerBindings: async () => [
      {
        id: 'b-1',
        agent_id: 'a-1',
        handler_kind: 'test.echo',
        config_json: '{"foo":"bar"}',
        enabled: 1,
      },
    ],
    listLiveAgentToolBindings: async () => [],
    getToolConfig: async () => null,
  };

  it('hydrates a single agent into a runnable handler', async () => {
    const result = await weaveLiveAgentFromDb(db, 'a-1', {
      extraHandlerKinds: [echoKind],
      logger: () => {},
    });
    expect(result.agent.roleKey).toBe('echoer');
    expect(result.binding.config).toEqual({ foo: 'bar' });
    expect(typeof result.handler).toBe('function');
  });

  it('throws when agent id is unknown', async () => {
    await expect(
      weaveLiveAgentFromDb(db, 'does-not-exist', {
        extraHandlerKinds: [echoKind],
        logger: () => {},
      }),
    ).rejects.toThrow(/not found/);
  });

  it('throws when no enabled binding exists', async () => {
    const emptyDb: SingleAgentReaderDb = {
      ...db,
      listLiveAgentHandlerBindings: async () => [],
    };
    await expect(
      weaveLiveAgentFromDb(emptyDb, 'a-1', {
        extraHandlerKinds: [echoKind],
        logger: () => {},
      }),
    ).rejects.toThrow(/no enabled handler binding/);
  });

  it('throws when handler kind is not registered', async () => {
    await expect(
      weaveLiveAgentFromDb(db, 'a-1', {
        // No extraHandlerKinds — `test.echo` is not built-in.
        logger: () => {},
      }),
    ).rejects.toThrow(/unknown handler kind/);
  });
});
