import type {
  Account,
  AccountBinding,
  AccountBindingRequest,
  AgentContract,
  BacklogItem,
  DelegationEdge,
  EventRoute,
  ExternalEvent,
  HeartbeatTick,
  InMemoryStateStore,
  LiveAgent,
  Message,
  MessageStatus,
  Mesh,
  OutboundActionRecord,
  RedisStateStore,
  StateStore,
  Team,
  TeamMembership,
} from './types.js';
import { InvalidAccountBindingError, OnlyHumansMayBindAccountsError } from './errors.js';

function isHumanPrincipal(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return normalized.startsWith('human:') || normalized.startsWith('user:') || normalized.startsWith('admin:');
}

export function weaveInMemoryStateStore(): InMemoryStateStore {
  const meshes = new Map<string, Mesh>();
  const agents = new Map<string, LiveAgent>();
  const contracts = new Map<string, AgentContract>();
  const delegationEdges = new Map<string, DelegationEdge>();
  const teams = new Map<string, Team>();
  const teamMemberships = new Map<string, TeamMembership>();
  const accounts = new Map<string, Account>();
  const bindings = new Map<string, AccountBinding>();
  const bindingRequests = new Map<string, AccountBindingRequest>();
  const ticks = new Map<string, HeartbeatTick>();
  const messages = new Map<string, Message>();
  const backlogItems = new Map<string, BacklogItem>();
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
    async transitionAgentStatus(agentId, nextStatus, at) {
      const current = agents.get(agentId);
      if (!current) {
        return null;
      }
      const updated: LiveAgent = {
        ...current,
        status: nextStatus,
        archivedAt: nextStatus === 'ARCHIVED' ? at : current.archivedAt,
      };
      agents.set(agentId, updated);
      return updated;
    },

    async saveDelegationEdge(edge) {
      delegationEdges.set(edge.id, edge);
    },
    async listDelegationEdges(meshId) {
      return [...delegationEdges.values()].filter((edge) => edge.meshId === meshId);
    },

    async saveTeam(team) {
      teams.set(team.id, team);
    },
    async loadTeam(id) {
      return teams.get(id) ?? null;
    },
    async listTeams(meshId) {
      return [...teams.values()].filter((team) => team.meshId === meshId);
    },
    async saveTeamMembership(membership) {
      teamMemberships.set(membership.id, membership);
    },
    async listTeamMemberships(teamId) {
      return [...teamMemberships.values()].filter((membership) => membership.teamId === teamId);
    },
    async listTeamsForAgent(agentId) {
      const activeMemberships = [...teamMemberships.values()].filter(
        (membership) => membership.agentId === agentId && membership.leftAt === null,
      );
      const ids = new Set(activeMemberships.map((membership) => membership.teamId));
      return [...teams.values()].filter((team) => ids.has(team.id));
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
    async transitionAccountStatus(accountId, nextStatus, at) {
      const current = accounts.get(accountId);
      if (!current) {
        return null;
      }
      const updated: Account = {
        ...current,
        status: nextStatus,
        revokedAt: nextStatus === 'REVOKED' ? at : current.revokedAt,
      };
      accounts.set(accountId, updated);
      return updated;
    },

    async saveAccountBinding(binding) {
      if (!isHumanPrincipal(binding.grantedByHumanId)) {
        throw new OnlyHumansMayBindAccountsError(binding.grantedByHumanId);
      }
      const account = accounts.get(binding.accountId);
      if (!account) {
        throw new InvalidAccountBindingError(`Account not found for binding: ${binding.accountId}`);
      }
      const agent = agents.get(binding.agentId);
      if (!agent) {
        throw new InvalidAccountBindingError(`Agent not found for binding: ${binding.agentId}`);
      }
      if (account.meshId !== agent.meshId) {
        throw new InvalidAccountBindingError(
          `Account and agent mesh mismatch for binding ${binding.id}: ${account.meshId} vs ${agent.meshId}`,
        );
      }
      if (account.status !== 'ACTIVE' || account.revokedAt !== null) {
        throw new InvalidAccountBindingError(`Account is not active for binding: ${binding.accountId}`);
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
        const account = accounts.get(binding.accountId);
        if (!account) return false;
        if (account.status !== 'ACTIVE' || account.revokedAt !== null) return false;
        return true;
      });
    },
    async revokeAccountBinding(bindingId, revokedByHumanId, revocationReason, at) {
      if (!isHumanPrincipal(revokedByHumanId)) {
        throw new OnlyHumansMayBindAccountsError(revokedByHumanId);
      }
      const current = bindings.get(bindingId);
      if (!current) {
        return null;
      }
      const updated: AccountBinding = {
        ...current,
        revokedAt: at,
        revokedByHumanId,
        revocationReason,
      };
      bindings.set(bindingId, updated);
      return updated;
    },
    async saveAccountBindingRequest(request) {
      bindingRequests.set(request.id, request);
    },
    async loadAccountBindingRequest(id) {
      return bindingRequests.get(id) ?? null;
    },
    async listAccountBindingRequests(meshId) {
      return [...bindingRequests.values()].filter((request) => request.meshId === meshId);
    },
    async resolveAccountBindingRequest(
      requestId,
      status,
      resolvedByHumanId,
      resolvedAt,
      resolutionReasonProse,
      resolvedAccountBindingId,
    ) {
      if (!isHumanPrincipal(resolvedByHumanId)) {
        throw new OnlyHumansMayBindAccountsError(resolvedByHumanId);
      }
      const current = bindingRequests.get(requestId);
      if (!current) {
        return null;
      }
      const updated: AccountBindingRequest = {
        ...current,
        status,
        resolvedByHumanId,
        resolvedAt,
        resolutionReasonProse,
        resolvedAccountBindingId: status === 'APPROVED' ? (resolvedAccountBindingId ?? null) : null,
      };
      bindingRequests.set(requestId, updated);
      return updated;
    },

    async saveHeartbeatTick(tick) {
      ticks.set(tick.id, tick);
    },
    async loadHeartbeatTick(id) {
      return ticks.get(id) ?? null;
    },
    async claimNextTicks(workerId, nowIso, limit, leaseDurationMs = 30_000) {
      const now = Date.parse(nowIso);
      const leaseExpiresAt = new Date(now + Math.max(1, leaseDurationMs)).toISOString();
      const claimable = [...ticks.values()].filter((tick) => {
        if (tick.status === 'SCHEDULED') {
          return Date.parse(tick.scheduledFor) <= now;
        }
        if (tick.status === 'IN_PROGRESS') {
          if (!tick.leaseExpiresAt) return true;
          return Date.parse(tick.leaseExpiresAt) <= now;
        }
        return false;
      })
      .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))
      .slice(0, Math.max(0, limit));

      for (const tick of claimable) {
        ticks.set(tick.id, {
          ...tick,
          workerId,
          pickedUpAt: tick.pickedUpAt ?? nowIso,
          status: 'IN_PROGRESS',
          leaseExpiresAt,
        });
      }

      return claimable.map((tick) => ({
        ...tick,
        workerId,
        pickedUpAt: tick.pickedUpAt ?? nowIso,
        status: 'IN_PROGRESS',
        leaseExpiresAt,
      }));
    },

    async saveMessage(message) {
      messages.set(message.id, message);
    },
    async loadMessage(id) {
      return messages.get(id) ?? null;
    },
    async listMessagesForRecipient(recipientType, recipientId) {
      return [...messages.values()]
        .filter((message) => message.toType === recipientType && message.toId === recipientId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    },
    async listThreadMessages(threadId) {
      return [...messages.values()]
        .filter((message) => message.threadId === threadId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    },
    async transitionMessageStatus(messageId, status, at) {
      const current = messages.get(messageId);
      if (!current) {
        return null;
      }

      const timestamps: Pick<Message, 'deliveredAt' | 'readAt' | 'processedAt'> = {
        deliveredAt: current.deliveredAt,
        readAt: current.readAt,
        processedAt: current.processedAt,
      };

      if (status === 'DELIVERED' && !timestamps.deliveredAt) {
        timestamps.deliveredAt = at;
      }
      if (status === 'READ' && !timestamps.readAt) {
        timestamps.readAt = at;
        if (!timestamps.deliveredAt) {
          timestamps.deliveredAt = at;
        }
      }
      if (status === 'PROCESSED' && !timestamps.processedAt) {
        timestamps.processedAt = at;
        if (!timestamps.readAt) {
          timestamps.readAt = at;
        }
        if (!timestamps.deliveredAt) {
          timestamps.deliveredAt = at;
        }
      }

      const updated: Message = {
        ...current,
        status: status as MessageStatus,
        ...timestamps,
      };
      messages.set(messageId, updated);
      return updated;
    },

    async saveBacklogItem(item) {
      backlogItems.set(item.id, item);
    },
    async loadBacklogItem(id) {
      return backlogItems.get(id) ?? null;
    },
    async listBacklogForAgent(agentId) {
      return [...backlogItems.values()]
        .filter((item) => item.agentId === agentId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    },
    async transitionBacklogItemStatus(backlogItemId, status, at) {
      const current = backlogItems.get(backlogItemId);
      if (!current) {
        return null;
      }

      const updated: BacklogItem = {
        ...current,
        status,
        acceptedAt: status === 'ACCEPTED' && current.acceptedAt === null ? at : current.acceptedAt,
        startedAt: status === 'IN_PROGRESS' && current.startedAt === null ? at : current.startedAt,
        completedAt: status === 'COMPLETED' && current.completedAt === null ? at : current.completedAt,
      };

      backlogItems.set(backlogItemId, updated);
      return updated;
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
    async listOutboundActionRecords(agentId) {
      return [...outboundRecords.values()]
        .filter((record) => record.agentId === agentId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
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
