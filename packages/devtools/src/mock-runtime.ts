/**
 * @weaveintel/devtools — Mock runtime for local development & testing
 *
 * Provides a fake Model, EventBus, and ToolRegistry for offline development.
 */

import type {
  Model,
  ModelRequest,
  ModelResponse,
  ModelInfo,
  TokenUsage,
  ToolDefinition,
  ToolRegistry,
  Tool,
  ToolSchema,
  ToolInput,
  ToolOutput,
  EventBus,
  WeaveEvent,
  EventHandler,
  EventFilter,
  ExecutionContext,
  CapabilityId,
} from '@weaveintel/core';
import { weaveToolRegistry, capabilityId } from '@weaveintel/core';

// ─── Mock Model ──────────────────────────────────────────────

export interface MockModelOptions {
  /** Fixed responses to return in order. Cycles when exhausted. */
  responses?: string[];
  /** Fixed token usage per call */
  tokensPerCall?: number;
  /** Model name */
  name?: string;
  /** Simulate latency in ms */
  latencyMs?: number;
}

export function createMockModel(opts: MockModelOptions = {}): MockModel {
  const responses = opts.responses ?? ['Mock response'];
  let callIdx = 0;

  const info: ModelInfo = {
    modelId: opts.name ?? 'mock-model',
    displayName: opts.name ?? 'mock-model',
    provider: 'mock',
    maxContextTokens: 128_000,
    maxOutputTokens: 4096,
    capabilities: new Set([capabilityId('chat')]) as ReadonlySet<CapabilityId>,
  };

  const model: MockModel = {
    info,
    capabilities: info.capabilities,
    hasCapability(id: CapabilityId): boolean {
      return info.capabilities.has(id);
    },
    calls: [],
    async generate(_ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      if (opts.latencyMs) {
        await new Promise((r) => setTimeout(r, opts.latencyMs));
      }
      const text = responses[callIdx % responses.length] ?? 'Mock response';
      callIdx++;
      const usage: TokenUsage = {
        promptTokens: opts.tokensPerCall ?? 10,
        completionTokens: opts.tokensPerCall ?? 10,
        totalTokens: (opts.tokensPerCall ?? 10) * 2,
      };
      const call: MockModelCall = { request, response: text };
      model.calls.push(call);
      return {
        id: `mock-${callIdx}`,
        content: text,
        usage,
        finishReason: 'stop',
        model: info.modelId,
      };
    },
  };

  return model;
}

export interface MockModelCall {
  request: ModelRequest;
  response: string;
}

export interface MockModel extends Model {
  calls: MockModelCall[];
}

// ─── Mock EventBus ───────────────────────────────────────────

export interface MockEventBus extends EventBus {
  events: WeaveEvent[];
}

export function createMockEventBus(): MockEventBus {
  const events: WeaveEvent[] = [];
  const handlers = new Map<string, Array<(e: WeaveEvent) => void>>();
  const allHandlers: Array<EventHandler> = [];
  const filterHandlers: Array<{ filter: EventFilter; handler: EventHandler }> = [];

  return {
    events,
    emit(event: WeaveEvent): void {
      events.push(event);
      const fns = handlers.get(event.type) ?? [];
      for (const fn of fns) fn(event);
      for (const fn of allHandlers) fn(event);
      for (const { filter, handler } of filterHandlers) {
        if (filter(event)) handler(event);
      }
    },
    on(type: string, handler: (e: WeaveEvent) => void) {
      const fns = handlers.get(type) ?? [];
      fns.push(handler);
      handlers.set(type, fns);
      return () => {
        const idx = fns.indexOf(handler);
        if (idx >= 0) fns.splice(idx, 1);
      };
    },
    onAll(handler: EventHandler) {
      allHandlers.push(handler);
      return () => {
        const idx = allHandlers.indexOf(handler);
        if (idx >= 0) allHandlers.splice(idx, 1);
      };
    },
    onMatch(filter: EventFilter, handler: EventHandler) {
      const entry = { filter, handler };
      filterHandlers.push(entry);
      return () => {
        const idx = filterHandlers.indexOf(entry);
        if (idx >= 0) filterHandlers.splice(idx, 1);
      };
    },
  };
}

// ─── Mock ToolRegistry with pre-loaded tools ─────────────────

export function createMockToolRegistry(
  tools?: Array<{ name: string; result?: unknown }>,
): ToolRegistry {
  const reg = weaveToolRegistry();
  for (const t of tools ?? []) {
    const tool: Tool = {
      schema: {
        name: t.name,
        description: `Mock tool: ${t.name}`,
        parameters: { type: 'object', properties: {} },
      },
      invoke: async () => ({ content: JSON.stringify(t.result ?? `mock-${t.name}-result`) }),
    };
    reg.register(tool);
  }
  return reg;
}

// ─── Complete mock runtime ───────────────────────────────────

export interface MockRuntime {
  model: MockModel;
  bus: MockEventBus;
  tools: ToolRegistry;
}

export function createMockRuntime(opts?: {
  responses?: string[];
  tools?: Array<{ name: string; result?: unknown }>;
}): MockRuntime {
  return {
    model: createMockModel({ responses: opts?.responses }),
    bus: createMockEventBus(),
    tools: createMockToolRegistry(opts?.tools),
  };
}
