/**
 * Default `/api/me/runs` run-agent (SP3).
 *
 * Bridges the run executor to the platform agent loop: it resolves the
 * configured default model, runs `weaveAgent.runStream`, and translates the
 * agent's step events onto the executor's `MeRunEmitter` (text deltas,
 * tool invoked/completed). The executor owns run lifecycle + sequencing; this
 * function only produces domain output and honours `args.signal` cooperatively.
 *
 * Kept deliberately thin and free of the chat-specific pipeline (memory,
 * skills, guardrail judges) so it stays reusable across surfaces. Richer
 * per-surface behaviour can be layered by supplying a different `MeRunAgent`.
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { weaveAgent } from '@weaveintel/agents';
import type { Message } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import type { ChatEngineConfig } from './chat-runtime.js';
import { getOrCreateModel } from './chat-runtime.js';
import type { ChatEngine } from './chat.js';
import type { DatabaseAdapter } from './db-types.js';
import type { MeRunAgent, MeRunEmitter } from './me-run-executor.js';

const DEFAULT_SYSTEM_PROMPT =
  'You are weaveIntel, a helpful, concise assistant. Answer the user clearly and directly.';

/** Pull the user prompt text out of the run start payload. */
function extractPrompt(input: Record<string, unknown>): string {
  const candidates = [input['text'], input['prompt'], input['content'], input['message']];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c;
  }
  return '';
}

export function createDefaultMeRunAgent(config: ChatEngineConfig): MeRunAgent {
  return async (args, emit) => {
    const prompt = extractPrompt(args.input);
    if (!prompt) {
      await emit.text('No input was provided for this run.');
      return;
    }

    const provider = config.defaultProvider;
    const modelId = config.defaultModel;
    const providerCfg = config.providers[provider] ?? {};
    const model = await getOrCreateModel(provider, modelId, providerCfg);

    const agent = weaveAgent({
      model,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    });

    const messages: Message[] = [{ role: 'user', content: prompt }];

    // Prefer streaming; fall back to a single generate when unavailable.
    if (agent.runStream) {
      for await (const ev of agent.runStream(args.ctx, { messages, goal: prompt })) {
        if (args.signal.aborted) return;
        switch (ev.type) {
          case 'text_chunk': {
            if (ev.text) await emit.text(ev.text);
            break;
          }
          case 'tool_start': {
            const tc = ev.step?.toolCall;
            if (tc?.name) await emit.toolInvoked(tc.name, tc.arguments);
            break;
          }
          case 'tool_end': {
            const tc = ev.step?.toolCall;
            if (tc?.name) await emit.toolCompleted(tc.name, tc.result);
            break;
          }
          default:
            break;
        }
      }
      return;
    }

    const result = await agent.run(args.ctx, { messages, goal: prompt });
    if (args.signal.aborted) return;
    if (result.output) await emit.text(result.output);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full-parity run-agent: routes `/api/me/runs` through the SAME ChatEngine
// pipeline the web UI streams (memory, skills, tools, guardrails, redaction,
// cost governor, model routing). This guarantees that any DB-driven config
// change made on the web surface (mode, enabled tools, settings) applies to the
// mobile surface automatically — there is exactly one chat code path.
//
// The bridge works by handing `chatEngine.streamMessage` an in-process
// `ServerResponse` adapter that captures the SSE frames it writes and maps them
// onto the executor's `MeRunEmitter`. No HTTP socket is involved.
// ─────────────────────────────────────────────────────────────────────────────

const CHAT_MODES = new Set(['direct', 'agent', 'supervisor', 'ensemble']);

/**
 * Resolve the chat-engine mode for a mobile run. The mobile surface ships a
 * single presentation mode ("Assistant"), so unless the client explicitly
 * selects one of the real chat modes we default to `agent` — the capable,
 * tool-enabled mode (datetime, calculator, web_search, …). `direct` has no
 * tools, which is why a bare assistant could answer with a stale date.
 */
function resolveChatMode(metadata: Record<string, unknown> | undefined): string {
  const options = (metadata?.['options'] && typeof metadata['options'] === 'object')
    ? metadata['options'] as Record<string, unknown>
    : undefined;
  const raw = options?.['mode'] ?? metadata?.['mode'];
  if (typeof raw === 'string' && CHAT_MODES.has(raw)) return raw;
  return 'agent';
}

/**
 * Derive a stable, per-user chat id for conversation continuity. When the
 * client supplies an opaque conversation token we hash it together with the
 * user id so the same conversation maps to the same server-side chat across
 * turns, while making cross-user id collision/hijack impossible. With no token
 * we mint a fresh chat per run.
 */
function resolveChatId(userId: string, metadata: Record<string, unknown> | undefined): string {
  const token = (typeof metadata?.['chatId'] === 'string' && metadata['chatId'])
    ? metadata['chatId'] as string
    : (typeof metadata?.['conversationId'] === 'string' && metadata['conversationId'])
      ? metadata['conversationId'] as string
      : undefined;
  if (token) {
    const h = createHash('sha256').update(`${userId}:${token}`).digest('hex').slice(0, 28);
    return `mob_${h}`;
  }
  return newUUIDv7();
}

/** Short, human-readable chat title derived from the first user prompt. */
function deriveTitle(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : (trimmed || 'New Chat');
}

/**
 * Production run-agent for `/api/me/runs`. Bridges a mobile run to the full
 * web chat pipeline via `chatEngine.streamMessage`, giving the mobile surface
 * complete feature parity with the web chat UI.
 */
export function createChatPipelineMeRunAgent(chatEngine: ChatEngine, db: DatabaseAdapter): MeRunAgent {
  return async (args, emit) => {
    const prompt = extractPrompt(args.input);
    if (!prompt) {
      await emit.text('No input was provided for this run.');
      return;
    }

    const mode = resolveChatMode(args.metadata);
    const chatId = resolveChatId(args.userId, args.metadata);

    // Ensure the chat row exists (mirrors the web "New Chat" creation) so
    // streamMessage can persist messages and enable multi-turn history.
    const existing = await db.getChat(chatId, args.userId);
    if (!existing) {
      await db.createChat({
        id: chatId,
        userId: args.userId,
        title: deriveTitle(prompt),
        model: chatEngine.modelConfig.defaultModel,
        provider: chatEngine.modelConfig.defaultProvider,
      });
    }
    // Keep the chat's mode in sync with the current selection (idempotent
    // upsert). With no enabled_tools override, the engine derives the tool set
    // from the mode policy — identical to the web behaviour.
    await db.saveChatSettings({ chatId, mode });

    const capture = new SseCaptureResponse(emit);
    const onAbort = (): void => capture.cancel();
    if (args.signal.aborted) onAbort();
    else args.signal.addEventListener('abort', onAbort, { once: true });

    try {
      await chatEngine.streamMessage(
        capture as unknown as ServerResponse,
        args.userId,
        chatId,
        prompt,
      );
      // Flush any queued emitter writes before the executor marks completion.
      await capture.drain();
    } finally {
      args.signal.removeEventListener('abort', onAbort);
    }

    if (capture.error) throw new Error(capture.error);
  };
}

/**
 * Minimal in-process `ServerResponse` stand-in. The ChatEngine writes SSE
 * frames (`data: {json}\n\n`) via `res.write`; we parse them and translate the
 * frame types the mobile run cares about onto the `MeRunEmitter`. Emitter calls
 * are serialized through a tail promise so ordering matches the stream.
 *
 * Only the surface the streaming pipeline actually touches is implemented:
 * `write`, `writeHead`, `end`, `writableEnded`, `destroyed`, plus the
 * EventEmitter `on/once/off/emit` used for `drain`/`close` backpressure.
 */
class SseCaptureResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  /** Captured `error` frame text, surfaced to the executor as a run failure. */
  error: string | undefined;

  readonly #out: MeRunEmitter;
  #buf = '';
  #tail: Promise<void> = Promise.resolve();

  constructor(out: MeRunEmitter) {
    super();
    this.#out = out;
  }

  writeHead(_status?: number, _headers?: unknown): this {
    return this;
  }

  write(chunk: string | Buffer): boolean {
    if (this.destroyed) return false;
    this.#buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = this.#buf.indexOf('\n\n')) !== -1) {
      const frame = this.#buf.slice(0, idx).trim();
      this.#buf = this.#buf.slice(idx + 2);
      if (frame) this.#handleFrame(frame);
    }
    return true;
  }

  end(_chunk?: unknown): this {
    this.writableEnded = true;
    return this;
  }

  /** Cancel the underlying stream: notify the pipeline's `close` listener. */
  cancel(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }

  /** Resolve once every queued emitter write has been applied, in order. */
  async drain(): Promise<void> {
    await this.#tail;
  }

  #handleFrame(frame: string): void {
    if (!frame.startsWith('data:')) return;
    const json = frame.slice(frame.indexOf(':') + 1).trim();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof payload['type'] === 'string' ? payload['type'] as string : '';
    switch (type) {
      case 'text': {
        const text = typeof payload['text'] === 'string' ? payload['text'] as string : '';
        if (text) this.#enqueue(() => this.#out.text(text));
        break;
      }
      case 'reasoning': {
        const text = typeof payload['text'] === 'string' ? payload['text'] as string : '';
        if (text) this.#enqueue(() => this.#out.text(text, 'reasoning'));
        break;
      }
      case 'tool_start': {
        const name = typeof payload['name'] === 'string' ? payload['name'] as string : '';
        const rawArgs = payload['arguments'];
        const toolArgs = (rawArgs && typeof rawArgs === 'object')
          ? rawArgs as Record<string, unknown>
          : undefined;
        if (name) this.#enqueue(() => this.#out.toolInvoked(name, toolArgs));
        break;
      }
      case 'tool_end': {
        const name = typeof payload['name'] === 'string' ? payload['name'] as string : '';
        if (name) this.#enqueue(() => this.#out.toolCompleted(name, payload['result']));
        break;
      }
      case 'error': {
        this.error = typeof payload['error'] === 'string' ? payload['error'] as string : 'Run failed';
        break;
      }
      default:
        // step / guardrail / redaction / cognitive / ensemble_result / screenshot
        // / done are metadata frames the executor does not need to mirror.
        break;
    }
  }

  #enqueue(fn: () => Promise<void>): void {
    this.#tail = this.#tail.then(fn).catch(() => {
      // Emitter writes are best-effort; a failed append must not break the run.
    });
  }
}
