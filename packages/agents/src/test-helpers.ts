/**
 * Shared test stubs for @weaveintel/agents unit tests.
 * Import only from test files — not shipped in the package bundle.
 */

import type {
  Agent,
  AgentConfig,
  AgentInput,
  AgentResult,
  AuditEntry,
  AuditLogger,
  ExecutionContext,
  Model,
  ModelRequest,
  ModelResponse,
} from '@weaveintel/core';
import {
  Capabilities,
  weaveContext,
  weaveRuntime,
} from '@weaveintel/core';

// ── Minimal execution context ────────────────────────────────

export function makeCtx(overrides?: Partial<Parameters<typeof weaveContext>[0]>): ExecutionContext {
  const audit: AuditLogger = { async log() {} };
  const runtime = weaveRuntime({ audit });
  return weaveContext({ runtime, ...overrides });
}

// ── Audit-capturing context ──────────────────────────────────

export function makeAuditCtx(): { ctx: ExecutionContext; entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  const audit: AuditLogger = { async log(e) { entries.push(e); } };
  const runtime = weaveRuntime({ audit });
  const ctx = weaveContext({ runtime });
  return { ctx, entries };
}

// ── Stub model that returns a fixed text response ────────────

export function stubTextModel(text: string, opts: { failAt?: number } = {}): Model {
  const caps = new Set([Capabilities.Chat]);
  let call = 0;
  return {
    info: { provider: 'stub', modelId: 'stub-text', capabilities: caps },
    capabilities: caps,
    hasCapability: (id) => caps.has(id),
    async generate(_ctx: ExecutionContext, _req: ModelRequest): Promise<ModelResponse> {
      call++;
      if (opts.failAt && call === opts.failAt) throw new Error('stub model error');
      return {
        id: `r${call}`,
        model: 'stub-text',
        content: text,
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  };
}

// ── Stub model that returns a scripted sequence of responses ─

export type StubTurn =
  | { text: string }
  | { toolCall: { name: string; args: Record<string, unknown>; id?: string } };

export function stubSequenceModel(turns: StubTurn[]): Model {
  const caps = new Set([Capabilities.Chat, Capabilities.ToolCalling]);
  let i = 0;
  return {
    info: { provider: 'stub', modelId: 'stub-sequence', capabilities: caps },
    capabilities: caps,
    hasCapability: (id) => caps.has(id),
    async generate(_ctx: ExecutionContext, _req: ModelRequest): Promise<ModelResponse> {
      const turn = turns[i++] ?? { text: '(no more turns)' };
      if ('text' in turn) {
        return {
          id: `r${i}`,
          model: 'stub-sequence',
          content: turn.text,
          toolCalls: [],
          finishReason: 'stop',
          usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
        };
      }
      return {
        id: `r${i}`,
        model: 'stub-sequence',
        content: '',
        toolCalls: [{ id: turn.toolCall.id ?? `tc${i}`, name: turn.toolCall.name, arguments: JSON.stringify(turn.toolCall.args) }],
        finishReason: 'tool_calls',
        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      };
    },
  };
}

// ── Stub RubricJudgeAdapter ──────────────────────────────────

export interface StubAdapterResponse { score: number; reason?: string }

export function stubAdapter(responses: StubAdapterResponse[]): import('@weaveintel/evals').RubricJudgeAdapter {
  let i = 0;
  return {
    id: 'stub-adapter',
    description: 'Stub adapter for testing',
    async score() {
      const r = responses[i++] ?? { score: 0, reason: 'no more responses' };
      return r;
    },
  };
}

// ── Stub Agent that always returns a fixed output ────────────

export function stubAgent(output: string, name = 'stub-agent'): Agent {
  const config: AgentConfig = { name };
  return {
    config,
    async run(_ctx: ExecutionContext, _input: AgentInput): Promise<AgentResult> {
      return {
        output,
        messages: [],
        steps: [],
        usage: { totalSteps: 0, promptTokens: 5, completionTokens: 3, totalTokens: 8, totalDurationMs: 1, toolCalls: 0, delegations: 0 },
        status: 'completed',
      };
    },
    async *runStream(_ctx: ExecutionContext, _input: AgentInput) {
      yield { type: 'text_chunk' as const, text: output };
      yield {
        type: 'done' as const,
        result: {
          output,
          messages: [],
          steps: [],
          usage: { totalSteps: 0, promptTokens: 5, completionTokens: 3, totalTokens: 8, totalDurationMs: 1, toolCalls: 0, delegations: 0 },
          status: 'completed' as const,
        },
      };
    },
  };
}

// ── Stub Agent that throws ───────────────────────────────────

export function failingAgent(name = 'fail-agent'): Agent {
  const config: AgentConfig = { name };
  return {
    config,
    async run(): Promise<AgentResult> {
      return {
        output: '',
        messages: [],
        steps: [],
        usage: { totalSteps: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, totalDurationMs: 0, toolCalls: 0, delegations: 0 },
        status: 'failed',
      };
    },
  };
}
