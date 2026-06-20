/**
 * @weaveintel/agents — P3-3: A2A external agent as a supervisor worker
 *
 * `weaveA2AWorker()` creates a `WorkerDefinition` whose `model` routes every
 * `generate()` call through `weaveA2AClient().sendMessage()` to a remote A2A
 * endpoint.  The caller can pass either a known `agentCard` or just an
 * `agentUrl` — in the latter case the card is discovered lazily on first use.
 *
 * Internally a synthetic `Model` is built that:
 *   1. Converts the last user `Message` → `A2ATaskSendParams`
 *   2. Calls `client.sendMessage()` to get an `A2ATask`
 *   3. Extracts the text response from artifacts / status message
 *   4. Returns a `ModelResponse` the supervisor can treat like any worker output
 *
 * Usage:
 * ```ts
 * const worker = await weaveA2AWorker({
 *   agentUrl: 'https://specialist-agent.example.com',
 *   bearerToken: process.env.AGENT_TOKEN,
 *   name: 'specialist',
 *   description: 'Deep-dive research specialist',
 * });
 *
 * const supervisor = weaveAgent({ model, workers: [worker] });
 * ```
 */

import type {
  AgentCard,
  A2AClient,
  ExecutionContext,
  Model,
  ModelRequest,
  ModelResponse,
  ModelInfo,
  TokenUsage,
} from '@weaveintel/core';
import {
  capabilityId,
  weaveCapabilities,
  a2aPartsText,
  newUUIDv7,
} from '@weaveintel/core';
import { weaveA2AClient } from '@weaveintel/a2a';
import type { WorkerDefinition } from './supervisor-runtime.js';

// ─── Options ──────────────────────────────────────────────────

export interface WeaveA2AWorkerOptions {
  /**
   * Remote A2A agent URL (used to call `sendMessage` and, when `agentCard` is
   * omitted, to discover the card via `/.well-known/agent-card.json`).
   */
  agentUrl: string;
  /**
   * Pre-discovered agent card.  When provided the card is used directly
   * instead of fetching it from the URL.
   */
  agentCard?: AgentCard;
  /**
   * Bearer token sent as `Authorization: Bearer <token>` on all requests.
   * When omitted the request is sent without an Authorization header.
   */
  bearerToken?: string;
  /**
   * Worker name used as the key in the supervisor's worker map.
   * Defaults to `agentCard.name` when a card is provided, or `'a2a-worker'`.
   */
  name?: string;
  /**
   * Human-readable description shown to the supervisor LLM when choosing
   * which worker to delegate to.
   * Defaults to `agentCard.description` or a generic fallback.
   */
  description?: string;
  /**
   * Optional system prompt prepended to the A2A request message as a
   * `user` turn.  Useful for scoping the remote agent's behaviour.
   */
  systemPrompt?: string;
  /**
   * A pre-constructed A2A client.  Defaults to `weaveA2AClient()`.
   * Inject your own for testing or custom auth headers.
   */
  client?: A2AClient;
}

// ─── Lazy-discovered card helper ──────────────────────────────

async function resolveCard(opts: WeaveA2AWorkerOptions): Promise<AgentCard> {
  if (opts.agentCard) return opts.agentCard;
  const client = opts.client ?? weaveA2AClient();
  return client.discover(opts.agentUrl);
}

// ─── Synthetic Model ──────────────────────────────────────────

/**
 * Build a synthetic `Model` that wraps an A2A endpoint.
 * Each `generate()` call converts the last user message to an A2A task,
 * sends it, and converts the response back to a `ModelResponse`.
 */
function buildA2AModel(opts: WeaveA2AWorkerOptions, card: AgentCard): Model {
  const client = opts.client ?? weaveA2AClient();
  const agentUrl = opts.agentUrl;

  const capSet = weaveCapabilities(capabilityId('model.chat'));

  const info: ModelInfo = {
    provider: 'a2a',
    modelId: agentUrl,
    displayName: card.name ?? opts.name ?? 'A2A Remote Agent',
    capabilities: capSet.capabilities,
    maxContextTokens: undefined,
  };

  return {
    info,
    capabilities: capSet.capabilities,
    hasCapability: capSet.hasCapability.bind(capSet),

    async generate(ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      // Build the user message content from all non-system messages
      const userMessages = request.messages.filter((m) => m.role !== 'system');
      const lastMsg = userMessages[userMessages.length - 1];

      let inputText: string;
      if (lastMsg) {
        if (typeof lastMsg.content === 'string') {
          inputText = lastMsg.content;
        } else {
          // ContentPart[] — join text parts
          inputText = (lastMsg.content as Array<{ type?: string; text?: string }>)
            .filter((p) => p.type === 'text' || typeof p.text === 'string')
            .map((p) => p.text ?? '')
            .join('\n');
        }
      } else {
        inputText = '';
      }

      // Prepend system prompt if configured
      if (opts.systemPrompt) {
        inputText = `${opts.systemPrompt}\n\n${inputText}`;
      }

      const params = {
        message: {
          role: 'user' as const,
          parts: [{ text: inputText }],
          messageId: newUUIDv7(),
        },
      };

      const task = await client.sendMessage(ctx, agentUrl, params);

      // Extract text response from artifacts or status message
      let responseText = '';
      if (task.artifacts.length > 0) {
        const artifact = task.artifacts[0]!;
        responseText = a2aPartsText(artifact.parts);
      } else if (task.status.message) {
        responseText = a2aPartsText(task.status.message.parts);
      }

      const isCompleted =
        task.status.state === 'TASK_STATE_COMPLETED' ||
        (task.status.state as string) === 'completed';

      const usage: TokenUsage = {
        promptTokens: Math.ceil(inputText.length / 4),
        completionTokens: Math.ceil(responseText.length / 4),
        totalTokens: Math.ceil((inputText.length + responseText.length) / 4),
      };

      return {
        id: task.id,
        content: responseText,
        finishReason: isCompleted ? 'stop' : 'error',
        usage,
        model: agentUrl,
        metadata: {
          a2aTaskId: task.id,
          a2aContextId: task.contextId,
          a2aState: task.status.state,
        },
      };
    },
  };
}

// ─── Public factory ───────────────────────────────────────────

/**
 * Creates a `WorkerDefinition` that wraps a remote A2A agent endpoint.
 *
 * The returned definition is fully compatible with `weaveAgent({ workers: [...] })`.
 * The synthetic model's `generate()` routes every supervisor delegation through
 * `weaveA2AClient().sendMessage()`.
 */
export async function weaveA2AWorker(
  opts: WeaveA2AWorkerOptions,
): Promise<WorkerDefinition> {
  const card = await resolveCard(opts);

  const name = opts.name ?? card.name ?? 'a2a-worker';
  const description =
    opts.description ??
    card.description ??
    `Remote A2A agent at ${opts.agentUrl}`;

  const model = buildA2AModel(opts, card);

  return {
    name,
    description,
    model,
    systemPrompt: opts.systemPrompt,
  };
}

/**
 * Creates a `WorkerDefinition` from a pre-discovered `AgentCard` without any
 * async discovery step.  Use this when you already have the card (e.g. from a
 * previous `weaveA2AClient().discover()` call).
 */
export function weaveA2AWorkerFromCard(
  card: AgentCard,
  agentUrl: string,
  opts: Omit<WeaveA2AWorkerOptions, 'agentUrl' | 'agentCard'> = {},
): WorkerDefinition {
  const name = opts.name ?? card.name ?? 'a2a-worker';
  const description = opts.description ?? card.description ?? `Remote A2A agent at ${agentUrl}`;
  const model = buildA2AModel({ ...opts, agentUrl, agentCard: card }, card);
  return { name, description, model, systemPrompt: opts.systemPrompt };
}
