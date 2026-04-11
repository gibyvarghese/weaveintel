/**
 * @weaveintel/recipes — ACL-Aware RAG App
 *
 * RAG agent that respects access-control lists when retrieving documents.
 */

import type {
  Agent,
  Model,
  ToolRegistry,
  EventBus,
  AgentMemory,
} from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';

export interface AclAwareRagOptions {
  name?: string;
  model: Model;
  tools?: ToolRegistry;
  bus?: EventBus;
  memory?: AgentMemory;
  /** Allowed document collections/scopes */
  allowedCollections?: string[];
  /** System prompt */
  systemPrompt?: string;
  maxSteps?: number;
}

/**
 * Create a RAG agent that only retrieves from permitted collections.
 * The system prompt constrains retrieval scope.
 */
export function createAclAwareRagApp(opts: AclAwareRagOptions): Agent {
  const collections = opts.allowedCollections ?? ['public'];
  const collBlock = `\n\nYou may only retrieve documents from these collections: ${collections.join(', ')}.
Never reference or return content from collections outside this list.`;

  const systemPrompt = `You are a retrieval-augmented assistant with access controls.
Only use information from your authorized document collections.
Always cite the source document when answering from retrieved content.
${opts.systemPrompt ?? ''}${collBlock}`;

  return weaveAgent({
    name: opts.name ?? 'acl-rag',
    model: opts.model,
    tools: opts.tools,
    bus: opts.bus,
    memory: opts.memory,
    systemPrompt,
    maxSteps: opts.maxSteps ?? 15,
  });
}
