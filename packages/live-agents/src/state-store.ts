import type {
  Account,
  AccountBinding,
  AccountBindingRequest,
  AgentContract,
  EventRoute,
  ExternalEvent,
  HeartbeatTick,
  InMemoryStateStore,
  LiveAgent,
  Mesh,
  OutboundActionRecord,
  RedisStateStore,
  StateStore,
} from './types.js';
import { OnlyHumansMayBindAccountsError } from './errors.js';

function isHumanPrincipal(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return normalized.startsWith('human:') || normalized.startsWith('user:') || normalized.startsWith('admin:');
}

export function weaveInMemoryStateStore(): InMemoryStateStore {
  const meshes = new Map<string, Mesh>();
  const agents = new Map<string, LiveAgent>();
  const contracts = new Map<string, AgentContract>();
  const accounts = new Map<string, Account>();
  const bindings = new Map<string, AccountBinding>();
  const bindingRequests = new Map<string, AccountBindingRequest>();
  const ticks = new Map<string, HeartbeatTick>();
  const externalEvents = new Map<string, ExternalEvent>();
  const eventRoutes = new Map<string, EventRoute>();
  const outboundRecords = new Map<string, OutboundActionRecord>();

  return {
    __kind: 'in-memory',

    async saveMesh(mesh) {
      meshes.set(mesh.id, mesh);
    },
    async loadMesh(id) {
      return meshes.get(id) ?? null;
    },
    async listMeshes(tenantId) {
      return [...meshes.values()].filter((m) => m.tenantId === tenantId);
    },

    async saveAgent(agent) {
      agents.set(agent.id, agent);
    },
    async loadAgent(id) {
      return agents.get(id) ?? null;
    },
    async listAgents(meshId) {
      return [...agents.values()].filter((a) => a.meshId === meshId);
    },

    async saveContract(contract) {
      contracts.set(contract.id, contract);
    },
    async loadContract(id) {
      return contracts.get(id) ?? null;
    },
    async loadLatestContractForAgent(agentId) {
      const versions = [...contracts.values()]
        .filter((contract) => contract.agentId === agentId)
        .sort((a, b) => b.version - a.version);
      return versions[0] ?? null;
    },

    async saveAccount(account) {
      accounts.set(account.id, account);
    },
    async loadAccount(id) {
      return accounts.get(id) ?? null;
    },
    async listAccounts(meshId) {
      return [...accounts.values()].filter((account) => account.meshId === meshId);
    },

    async saveAccountBinding(binding) {
      if (!isHumanPrincipal(binding.grantedByHumanId)) {
        throw new OnlyHumansMayBindAccountsError(binding.grantedByHumanId);
      }
      bindings.set(binding.id, binding);
    },
    async loadAccountBinding(id) {
      return bindings.get(id) ?? null;
    },
    async listAccountBindings(agentId) {
      return [...bindings.values()].filter((binding) => binding.agentId === agentId);
    },
    async listActiveAccountBindingsForAgent(agentId, at) {
      const atTime = Date.parse(at);
      return [...bindings.values()].filter((binding) => {
        if (binding.agentId !== agentId) return false;
        if (binding.revokedAt) return false;
        if (binding.expiresAt && Date.parse(binding.expiresAt) < atTime) return false;
        return true;
      });
    },
    async saveAccountBindingRequest(request) {
      bindingRequests.set(request.id, request);
    },

    async saveHeartbeatTick(tick) {
      ticks.set(tick.id, tick);
    },
    async claimNextTicks(workerId, nowIso, limit) {
      const now = Date.parse(nowIso);
      const claimable = [...ticks.values()]
        .filter((tick) => tick.status === 'SCHEDULED' && Date.parse(tick.scheduledFor) <= now)
        .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))
        .slice(0, Math.max(0, limit));

      for (const tick of claimable) {
        ticks.set(tick.id, {
          ...tick,
          workerId,
          pickedUpAt: nowIso,
          status: 'IN_PROGRESS',
        });
      }

      return claimable.map((tick) => ({
        ...tick,
        workerId,
        pickedUpAt: nowIso,
        status: 'IN_PROGRESS',
      }));
    },

    async saveExternalEvent(event) {
      externalEvents.set(`${event.accountId}:${event.sourceType}:${event.sourceRef}`, event);
    },
    async findExternalEvent(accountId, sourceType, sourceRef) {
      return externalEvents.get(`${accountId}:${sourceType}:${sourceRef}`) ?? null;
    },
    async saveEventRoute(route) {
      eventRoutes.set(route.id, route);
    },
    async listEventRoutes(accountId) {
      return [...eventRoutes.values()].filter((route) => route.accountId === accountId && route.enabled);
    },

    async saveOutboundActionRecord(record) {
      outboundRecords.set(record.idempotencyKey, record);
    },
  };
}

export function weaveRedisStateStore(_opts: { url: string }): RedisStateStore {
  const inMemory = weaveInMemoryStateStore();
  return {
    ...inMemory,
    __kind: 'redis',
  };
}

export function asStateStore(store?: StateStore): StateStore {
  return store ?? weaveInMemoryStateStore();
}
