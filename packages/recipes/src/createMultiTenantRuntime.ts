/**
 * @weaveintel/recipes — Multi-Tenant Runtime
 *
 * Agent factory that stamps each instance with tenant isolation metadata.
 */

import type {
  Agent,
  Model,
  ToolRegistry,
  EventBus,
  AgentMemory,
} from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';

export interface MultiTenantRuntimeOptions {
  name?: string;
  model: Model;
  tools?: ToolRegistry;
  bus?: EventBus;
  memory?: AgentMemory;
  /** Tenant identifier for data isolation */
  tenantId: string;
  /** Tenant display name */
  tenantName?: string;
  /** Allowed models for this tenant */
  allowedModels?: string[];
  /** Max tokens per request */
  maxTokens?: number;
  /** System prompt */
  systemPrompt?: string;
  maxSteps?: number;
}

/**
 * Create a tenant-scoped agent. The system prompt includes tenant context
 * and the agent is configured with tenant-specific constraints.
 */
export function createMultiTenantRuntime(opts: MultiTenantRuntimeOptions): Agent {
  const tenantBlock = `\n\nTenant context:
- Tenant ID: ${opts.tenantId}
- Tenant: ${opts.tenantName ?? opts.tenantId}
All data and responses must be scoped to this tenant.
Never access or reference data from other tenants.`;

  const systemPrompt = `You are an AI assistant operating in a multi-tenant environment.
Maintain strict data isolation between tenants.
${opts.systemPrompt ?? ''}${tenantBlock}`;

  return weaveAgent({
    name: opts.name ?? `tenant-${opts.tenantId}`,
    model: opts.model,
    tools: opts.tools,
    bus: opts.bus,
    memory: opts.memory,
    systemPrompt,
    maxSteps: opts.maxSteps ?? 20,
  });
}
