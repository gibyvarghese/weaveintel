/**
 * @weaveintel/agents/recipes — ACL-Aware RAG App
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
import { weaveAgent } from '../index.js';

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

let warned = false;

/**
 * Create a RAG agent that is *asked* to retrieve only from permitted collections.
 *
 * @deprecated Unsafe: the access list is enforced only in prompt text, so a prompt injection
 * or a model mistake reads any collection the tools can reach (GAPS G-WI-12,
 * platform-architecture §7.4 item 5). Enforce access in the retrieval layer instead: run
 * retrieval as the user through the data gate, or use a `VectorStore` whose `search` takes a
 * verified principal (`weavePgVectorStore` in `@weaveintel/retrieval`). Emits a one-time
 * `DeprecationWarning` (code `WEAVEINTEL_ACL_RAG_PROMPT_ONLY`). It will be removed in a
 * future major.
 */
export function createAclAwareRagApp(opts: AclAwareRagOptions): Agent {
  if (!warned) {
    warned = true;
    process.emitWarning(
      'createAclAwareRagApp enforces its ACL only in prompt text and is unsafe; enforce access in retrieval instead',
      { type: 'DeprecationWarning', code: 'WEAVEINTEL_ACL_RAG_PROMPT_ONLY' },
    );
  }
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
