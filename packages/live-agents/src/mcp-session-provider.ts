import { agentIdentity } from '@weaveintel/identity';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import type {
  AccountSessionProvider,
  AccountToolSession,
  McpAccountSessionProviderOptions,
} from './types.js';
import type { Account, LiveAgent } from './types.js';
import { NoAuthorisedAccountError } from './errors.js';

function defaultScopeFactory(account: Account, agent: LiveAgent) {
  return {
    id: account.credentialVaultRef,
    name: account.credentialVaultRef,
    tenantId: account.meshId,
    allowedIdentities: [agent.id],
  };
}

function defaultIdentityFactory(agent: LiveAgent) {
  return agentIdentity(agent.id, agent.name, ['tools'], agent.meshId);
}

export function createMcpAccountSessionProvider(
  opts: McpAccountSessionProviderOptions,
): AccountSessionProvider {
  const cache = new Map<string, Promise<AccountToolSession>>();

  async function connectSession(account: Account, agent: LiveAgent, ctx: Parameters<AccountSessionProvider['getSession']>[0]['ctx']) {
    const scope = (opts.scopeFactory ?? defaultScopeFactory)(account, agent);
    const identity = (opts.identityFactory ?? defaultIdentityFactory)(agent);
    const token = await opts.tokenResolver.resolve(scope, identity);
    if (!token) {
      throw new NoAuthorisedAccountError(agent.id, `use account ${account.accountIdentifier}`);
    }

    const transport = await opts.transportFactory.createTransport({
      account,
      agent,
      token,
      identity,
      ctx,
    });

    const client = weaveMCPClient();
    await client.connect(transport);
    return {
      listTools: () => client.listTools(),
      callTool: (executionCtx, request) => client.callTool(executionCtx, request),
      disconnect: () => client.disconnect(),
    } satisfies AccountToolSession;
  }

  return {
    async getSession({ account, agent, ctx }) {
      const existing = cache.get(account.id);
      if (existing) {
        return existing;
      }

      const pending = connectSession(account, agent, ctx).catch((error) => {
        cache.delete(account.id);
        throw error;
      });
      cache.set(account.id, pending);
      return pending;
    },
    async disconnectAccount(accountId) {
      const session = cache.get(accountId);
      cache.delete(accountId);
      if (session) {
        await (await session).disconnect();
      }
    },
    async disconnectAll() {
      const sessions = [...cache.values()];
      cache.clear();
      await Promise.all(sessions.map(async (session) => (await session).disconnect()));
    },
  };
}
