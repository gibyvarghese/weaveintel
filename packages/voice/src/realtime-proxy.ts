/**
 * @weaveintel/voice — VoiceRealtimeProxy
 *
 * Proxies a client WebSocket through to the OpenAI GA Realtime API and
 * implements production-grade barge-in (user interrupting agent mid-response).
 *
 * Architecture:
 *   Browser → our WS (/api/voice/sessions/:id/realtime)
 *           → VoiceRealtimeProxy
 *           → OpenAI Realtime WS (wss://api.openai.com/v1/realtime)
 *
 * The proxy:
 *   1. Opens a server-to-server connection to OpenAI, keeping the API key
 *      off the browser entirely.
 *   2. Sends session.update to configure voice, semantic VAD, system prompt.
 *   3. Translates our client protocol ↔ OpenAI events bidirectionally.
 *   4. Implements the three-part barge-in protocol (see §Barge-in below).
 *   5. Fires callbacks for audit/cost/memory integration.
 *
 * ── Barge-in protocol ──────────────────────────────────────────────────────
 *
 * When the user speaks while the agent is generating audio, OpenAI's
 * semantic_vad automatically cancels the in-flight response and fires
 * `input_audio_buffer.speech_started`.  Our proxy must:
 *
 *   1. Detect that audio was in-progress (currentItemId !== null).
 *   2. Send `{ type: 'barge_in', itemId }` to the CLIENT so it stops audio
 *      playback immediately and reports how many ms it played.
 *   3. Receive `{ type: 'barge_in', itemId, audioPlayedMs }` from client.
 *   4. Send `conversation.item.truncate` to OpenAI with the exact ms played,
 *      so transcript alignment is accurate.
 *   5. Send `{ type: 'barge_in_ack', audioEndMs }` to confirm.
 *
 * Fallback: if the client doesn't respond within BARGE_IN_TIMEOUT_MS (200ms),
 * the proxy commits the truncation using a server-side ms estimate derived
 * from PCM16 byte-counting.
 *
 * ── Client protocol (Browser → Server) ────────────────────────────────────
 *   { type: 'audio',    payload: '<base64 PCM16 24kHz mono>' }
 *   { type: 'text',     text: '<string>' }
 *   { type: 'pause' }
 *   { type: 'end' }
 *   { type: 'ping' }
 *   { type: 'barge_in', itemId: string, audioPlayedMs: number }  ← NEW
 *
 * ── Server → Client events ─────────────────────────────────────────────────
 *   { type: 'realtime_ready' }
 *   { type: 'speech_started' }          ← normal turn (agent was silent)
 *   { type: 'speech_stopped' }
 *   { type: 'transcript', text }
 *   { type: 'llm_text', text }
 *   { type: 'audio', payload, done, itemId }
 *   { type: 'turn_complete', costUsd, durationMs }
 *   { type: 'barge_in', itemId }        ← NEW: stop audio & report playedMs
 *   { type: 'barge_in_ack', audioEndMs }← NEW: truncate sent to OpenAI
 *   { type: 'error', code, message, retryable, fallbackToChained? }
 *   { type: 'pong' }
 */

import WebSocket from 'ws';
import type { WebSocket as WsSocket } from 'ws';

const OPENAI_REALTIME_BASE = 'wss://api.openai.com/v1/realtime';

/**
 * How long (ms) to wait for the client to report `audioPlayedMs` before
 * committing the truncation with the server-side PCM byte-count estimate.
 * 200ms is ample: a local WS round-trip is typically 5–20ms.
 */
const BARGE_IN_TIMEOUT_MS = 200;

/** PCM16 at 24 kHz, mono.  1 byte = 1/48 000 s ≈ 0.0208 ms. */
const PCM16_BYTES_PER_MS = 48; // 24000 samples/s × 2 bytes/sample ÷ 1000

/**
 * Refusal text injected as an assistant turn when an input guardrail denies
 * the user's request.  The model then generates audio of this refusal via
 * `response.create`.
 */
const GUARDRAIL_INPUT_REFUSAL = "I'm not able to help with that request. Please ask me something else.";

// ── Realtime API pricing (GA, June 2026) ─────────────────────
//
// Prices are in USD per 1 million tokens.
//
// Sources: OpenAI pricing page (developers.openai.com), June 2026.
//   Audio input  — $32 / 1M tokens   (≈ 100ms of speech per token at 24kHz)
//   Audio output — $64 / 1M tokens
//   Cached input — $0.40 / 1M tokens (system prompt + few-shot context cached)
//   Text input   — $2.5 / 1M tokens  (system prompt text, function schemas)
//   Text output  — $13 / 1M tokens   (function call JSON in output)

export const REALTIME_PRICING = {
  audioInputPerM:  32,    // uncached audio input tokens
  audioOutputPerM: 64,    // audio output tokens
  cachedInputPerM: 0.40,  // cached input tokens (previously seen context)
  textInputPerM:   2.5,   // text input tokens (instructions, function defs)
  textOutputPerM:  13,    // text output tokens (function call arguments, etc.)
} as const;

/**
 * Compute the USD cost for one realtime turn from the OpenAI GA `response.done`
 * usage object.
 *
 * Correctly separates cached vs uncached audio input — cached tokens are billed
 * at $0.40/M instead of $32/M, which is significant for long sessions where the
 * system prompt fills the cache.
 *
 * Exported so application layers (`voice-engine.ts`) can use the same formula
 * and third-party consumers of `@weaveintel/voice` can display accurate costs.
 */
export function computeRealtimeCostUsd(usage: RealtimeUsage): number {
  const audioIn  = usage.input_token_details?.audio_tokens  ?? 0;
  const cachedIn = usage.input_token_details?.cached_tokens ?? 0;
  const textIn   = usage.input_token_details?.text_tokens   ?? 0;
  const audioOut = usage.output_token_details?.audio_tokens ?? 0;
  const textOut  = usage.output_token_details?.text_tokens  ?? 0;

  // Clamp uncached audio to ≥0 in case OpenAI returns unexpected values.
  const uncachedAudioIn = Math.max(0, audioIn - cachedIn);

  return (
    uncachedAudioIn * (REALTIME_PRICING.audioInputPerM  / 1_000_000) +
    cachedIn        * (REALTIME_PRICING.cachedInputPerM  / 1_000_000) +
    textIn          * (REALTIME_PRICING.textInputPerM    / 1_000_000) +
    audioOut        * (REALTIME_PRICING.audioOutputPerM  / 1_000_000) +
    textOut         * (REALTIME_PRICING.textOutputPerM   / 1_000_000)
  );
}

// ── Tool types ────────────────────────────────────────────────

/**
 * Function schema forwarded to OpenAI's session.update → tools field.
 * Maps directly to the OpenAI Realtime API `function` tool schema.
 */
export interface RealtimeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

/** A function call extracted from a response.done output item. */
export interface RealtimeToolCall {
  /** OpenAI call_id — used to submit function_call_output. */
  callId: string;
  /** OpenAI item id of the function_call conversation item. */
  itemId: string;
  /** Function name as registered in session.update tools. */
  name: string;
  /** Raw JSON string of arguments (parse it yourself). */
  arguments: string;
}

// ── Callbacks ─────────────────────────────────────────────────

export interface RealtimeProxyCallbacks {
  onTranscript?: (text: string) => void;
  onResponseText?: (text: string) => void;
  /** Called on each final response.done (no tool calls) with duration and GA token usage. */
  onTurnComplete?: (durationMs: number, usage?: RealtimeUsage) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
  /**
   * Called just before each session rotation (every N turns).
   * Returns a fresh system prompt (with updated memory context) and updated
   * tool list to seed the new OpenAI Realtime session.
   * If absent, the original systemPrompt and tools are reused.
   */
  onRotateSession?: (turnCount: number, lastTranscript: string) => Promise<{ systemPrompt: string; tools?: RealtimeTool[] }>;
  /**
   * Called for each function_call item in a response.done event.
   * Must return the tool result as a JSON string (or any string the model
   * should see as the function output).  Throw or return an error-shaped
   * JSON string to signal failure.
   */
  onToolCall?: (call: RealtimeToolCall) => Promise<string>;
  /**
   * Input guardrail — called with the user's speech transcript after
   * `conversation.item.input_audio_transcription.completed`.
   *
   * Return { decision: 'deny' } to cancel any in-flight model response,
   * inject a refusal assistant turn, and send `guardrail_denied` to the
   * client.  Return `allow` or `warn` to proceed normally.
   *
   * Errors and timeouts are caught and treated as `allow` (fail open), so
   * keep this callback fast — ideally < 50ms for regex/embedding checks.
   */
  onInputGuardrail?: (transcript: string) => Promise<{ decision: 'allow' | 'warn' | 'deny'; reason?: string }>;
  /**
   * Output guardrail — called with the agent's full audio response transcript
   * after `response.output_audio_transcript.done` (i.e. after the audio has
   * already been streamed to the client).
   *
   * Return { decision: 'deny' } to truncate the response from OpenAI's
   * conversation context (so the model doesn't reference it in future turns)
   * and send `guardrail_denied { phase: 'output' }` to the client.
   *
   * The audio itself has already been delivered — this is an inherent
   * constraint of streaming voice.  Use fast input guardrails to block most
   * harmful content before generation begins.
   */
  onOutputGuardrail?: (transcript: string) => Promise<{ decision: 'allow' | 'warn' | 'deny'; reason?: string }>;
}

/** Token usage from OpenAI GA response.done event */
export interface RealtimeUsage {
  input_tokens: number;
  output_tokens: number;
  input_token_details?: {
    cached_tokens?: number;
    text_tokens?: number;
    audio_tokens?: number;
  };
  output_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
  };
}

export interface RealtimeProxyOptions {
  clientWs: WsSocket;
  apiKey: string;
  model: string;
  voice: string;
  systemPrompt?: string;
  /**
   * Tool schemas to register with OpenAI's session.update.
   * If empty or absent, no tools are exposed and the model cannot make function calls.
   */
  tools?: RealtimeTool[];
  callbacks?: RealtimeProxyCallbacks;
  /**
   * How many response turns before the upstream OpenAI session is transparently
   * rotated.  Prevents latency drift from growing context windows.  Default: 8.
   * Set to 0 to disable rotation.
   */
  rotateAfterTurns?: number;
  /**
   * Max wall-clock time (ms) allowed per tool call.  If the callback does not
   * resolve within this window, the proxy submits a timeout error to the model.
   * Default: 800.  Set to 0 to disable the timeout.
   */
  toolBudgetMs?: number;
}

interface OpenAIRealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export class VoiceRealtimeProxy {
  private openaiWs: WebSocket | null = null;
  private closed = false;

  // ── Stored options (needed for session rotation) ───────────
  private storedOpts: RealtimeProxyOptions | null = null;

  // ── Turn tracking ──────────────────────────────────────────
  private turnStartMs = 0;
  private currentResponseText = '';
  private currentTranscript = '';

  // ── Session rotation ──────────────────────────────────────
  /** Number of completed turns (response.done count) in the current session. */
  private turnCount = 0;
  /** Whether a rotation is in-progress (blocks another rotation until done). */
  private rotationInProgress = false;

  // ── Cost tracking ──────────────────────────────────────────
  /** Running total USD cost for this session across all turns and rotations. */
  private totalCostUsd = 0;

  // ── Barge-in state machine ─────────────────────────────────
  /**
   * item_id of the assistant audio item currently being streamed to the
   * client.  Set on the first `response.output_audio.delta`; cleared on
   * `response.output_audio.done` or when a barge-in is committed.
   */
  private currentItemId: string | null = null;

  /**
   * Accumulated ms of audio forwarded to the client, estimated from raw
   * PCM16 byte counts.  Used as fallback when client doesn't respond in
   * BARGE_IN_TIMEOUT_MS.
   */
  private audioSentMs = 0;

  // ── Output guardrail — track last completed audio item ─────
  /**
   * item_id of the most recently completed audio response.
   * Saved in response.output_audio.done BEFORE currentItemId is cleared,
   * so runOutputGuardrail (which fires later on transcript.done) can still
   * reference it for conversation.item.truncate.
   */
  private lastAudioItemId: string | null = null;
  /** PCM16 ms estimate of the most recently completed audio response. */
  private lastAudioSentMs = 0;

  /** True while waiting for the client to report audioPlayedMs. */
  private bargeInPending = false;

  /** itemId saved when speech_started fires mid-audio. */
  private bargeInItemId: string | null = null;

  /** Fallback timer — fires BARGE_IN_TIMEOUT_MS after barge_in sent to client. */
  private bargeInFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  // ──────────────────────────────────────────────────────────

  start(opts: RealtimeProxyOptions): void {
    this.storedOpts = opts;
    const { clientWs, apiKey, model, voice, systemPrompt, tools, callbacks } = opts;

    // GA Realtime WebSocket (server-to-server): API key in Authorization header.
    const url = `${OPENAI_REALTIME_BASE}?model=${encodeURIComponent(model)}`;
    this.openaiWs = new WebSocket(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    this.openaiWs.on('open', () => {
      if (this.closed) return;

      // Build session.update — include tools only when provided.
      const sessionConfig: Record<string, unknown> = {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: systemPrompt ?? 'You are a helpful voice assistant.',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: { type: 'semantic_vad' },
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice,
          },
        },
      };

      if (tools && tools.length > 0) {
        sessionConfig['tools'] = tools.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }));
        sessionConfig['tool_choice'] = 'auto';
      }

      this.sendToOpenAI({ type: 'session.update', session: sessionConfig });
      this.sendToClient(clientWs, { type: 'realtime_ready' });
    });

    this.openaiWs.on('message', (data) => {
      if (this.closed) return;
      let event: OpenAIRealtimeEvent;
      try {
        event = JSON.parse(data.toString()) as OpenAIRealtimeEvent;
      } catch {
        return;
      }
      this.handleOpenAIEvent(event, clientWs, callbacks);
    });

    const initialWs = this.openaiWs;
    this.openaiWs.on('close', (code, reason) => {
      // Guard: if this WS was intentionally rotated away, ignore the close event.
      if (this.openaiWs !== initialWs) return;
      if (this.closed) return;
      this.closed = true;
      this.clearBargeInTimer();
      callbacks?.onEnd?.();
      const msg = reason?.toString() || `close ${code}`;
      console.warn(`[realtime-proxy] OpenAI WS closed (code ${code}: ${msg}) — falling back to chained`);
      this.sendToClient(clientWs, {
        type: 'error',
        code: 'openai_realtime_unavailable',
        message: `OpenAI Realtime dropped connection (${code}). Falling back to chained mode.`,
        retryable: false,
        fallbackToChained: true,
      });
    });

    this.openaiWs.on('error', (err) => {
      callbacks?.onError?.(err);
      console.error(`[realtime-proxy] OpenAI WS error: ${err.message}`);
    });

    // ── Client → OpenAI relay ──────────────────────────────
    clientWs.on('message', (data) => {
      if (this.closed || !this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) return;

      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(data.toString()) as { type: string; [k: string]: unknown };
      } catch {
        return;
      }

      switch (msg.type) {
        case 'audio':
          this.sendToOpenAI({ type: 'input_audio_buffer.append', audio: msg['payload'] });
          break;

        case 'text':
          this.sendToOpenAI({
            type: 'conversation.item.create',
            item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: msg['text'] }] },
          });
          this.sendToOpenAI({ type: 'response.create' });
          break;

        case 'pause':
          this.sendToOpenAI({ type: 'input_audio_buffer.clear' });
          break;

        case 'end':
          this.close();
          break;

        case 'ping':
          this.sendToClient(clientWs, { type: 'pong' });
          break;

        // ── Tool approval / denial ─────────────────────────────────
        // Reserved for future human-in-the-loop approval gate UI.
        // The proxy currently resolves pending approvals via DB; these
        // client-side signals are accepted but not yet acted upon.
        case 'tool_approved':
        case 'tool_denied':
          // No-op: handled by DbToolApprovalGate at the application layer.
          break;

        // ── Barge-in: client reports how many ms it played ─────────
        case 'barge_in': {
          if (!this.bargeInPending) break; // stale or duplicate — ignore

          const audioPlayedMs = typeof msg['audioPlayedMs'] === 'number'
            ? msg['audioPlayedMs']
            : 0;

          this.clearBargeInTimer();
          this.commitBargein(clientWs, this.bargeInItemId ?? '', Math.round(audioPlayedMs));
          break;
        }
      }
    });

    clientWs.on('close', () => { this.close(); });
    clientWs.on('error', () => { this.close(); });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearBargeInTimer();
    if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
      this.openaiWs.close(1000, 'session ended');
    }
  }

  // ── OpenAI event handling ──────────────────────────────────

  private handleOpenAIEvent(
    event: OpenAIRealtimeEvent,
    clientWs: WsSocket,
    callbacks?: RealtimeProxyCallbacks,
  ): void {
    switch (event.type) {

      // ── Session lifecycle ────────────────────────────────────
      case 'session.created':
      case 'session.updated':
        this.sendToClient(clientWs, { type: event.type });
        break;

      // ── Input speech detection ───────────────────────────────
      case 'input_audio_buffer.speech_started': {
        this.turnStartMs = Date.now();
        this.currentTranscript = '';
        this.currentResponseText = '';

        if (this.currentItemId && !this.bargeInPending) {
          // ── True barge-in: user spoke while agent audio was streaming ──
          this.bargeInPending = true;
          this.bargeInItemId = this.currentItemId;

          console.log(`[realtime-proxy] barge-in detected — item=${this.currentItemId} audioSentMs=${this.audioSentMs.toFixed(0)}`);
          this.sendToClient(clientWs, { type: 'barge_in', itemId: this.currentItemId });

          // Fallback: commit using our server-side estimate if client is slow
          this.bargeInFallbackTimer = setTimeout(() => {
            if (this.bargeInPending && this.bargeInItemId) {
              console.warn(`[realtime-proxy] barge-in fallback fired (client silent for ${BARGE_IN_TIMEOUT_MS}ms) — using audioSentMs=${this.audioSentMs.toFixed(0)}`);
              this.commitBargein(clientWs, this.bargeInItemId, Math.round(this.audioSentMs));
            }
          }, BARGE_IN_TIMEOUT_MS);
        } else {
          // Normal turn start (agent was silent)
          this.sendToClient(clientWs, { type: 'speech_started' });
        }
        break;
      }

      case 'input_audio_buffer.speech_stopped':
        this.sendToClient(clientWs, { type: 'speech_stopped' });
        break;

      // ── Input transcription (what the user said) ─────────────
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (event['transcript'] as string) ?? '';
        this.currentTranscript = text;
        callbacks?.onTranscript?.(text);
        this.sendToClient(clientWs, { type: 'transcript', turnIndex: 0, text });
        // Phase 4: Input guardrail — async so it doesn't block the event loop.
        // If the guardrail denies, runInputGuardrail cancels the in-flight
        // response and injects a spoken refusal.
        if (callbacks?.onInputGuardrail) {
          void this.runInputGuardrail(text, clientWs, callbacks);
        }
        break;
      }

      // ── Output audio streaming ───────────────────────────────
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        // Capture the item_id on the first delta (stays stable within one response)
        const itemId = (event['item_id'] as string) ?? null;
        if (itemId && !this.currentItemId) this.currentItemId = itemId;

        const chunkB64 = (event['delta'] as string) ?? '';

        // Track audio sent: base64 → raw bytes → PCM16 duration
        // base64 chars × 0.75 ≈ raw bytes; bytes ÷ PCM16_BYTES_PER_MS = ms
        const rawBytes = Math.round(chunkB64.length * 0.75);
        this.audioSentMs += rawBytes / PCM16_BYTES_PER_MS;

        this.sendToClient(clientWs, {
          type: 'audio',
          itemId: this.currentItemId,
          turnIndex: 0,
          payload: chunkB64,
          mimeType: 'audio/pcm',
          done: false,
        });
        break;
      }

      case 'response.output_audio.done':
      case 'response.audio.done':
        // Save for output guardrail (fires later on transcript.done)
        this.lastAudioItemId = this.currentItemId;
        this.lastAudioSentMs = this.audioSentMs;
        // Audio stream complete — reset item tracking
        this.currentItemId = null;
        this.audioSentMs = 0;
        this.sendToClient(clientWs, {
          type: 'audio',
          turnIndex: 0,
          payload: '',
          mimeType: 'audio/pcm',
          done: true,
        });
        break;

      // ── Output transcript (audio-only modality) ──────────────
      case 'response.output_audio_transcript.done': {
        const text = (event['transcript'] as string) ?? '';
        this.currentResponseText = text;
        callbacks?.onResponseText?.(text);
        this.sendToClient(clientWs, { type: 'llm_text', turnIndex: 0, text });
        // Phase 4: Output guardrail — runs after audio is streamed (inherent
        // latency constraint of streaming voice).  On deny, truncates the
        // response from model context so the model won't reference the
        // harmful content in future turns.
        if (callbacks?.onOutputGuardrail) {
          void this.runOutputGuardrail(text, clientWs, callbacks);
        }
        break;
      }

      // ── Streaming response text (text modality fallback) ─────
      case 'response.output_text.delta':
      case 'response.text.delta':
        this.currentResponseText += (event['delta'] as string) ?? '';
        this.sendToClient(clientWs, {
          type: 'llm_text',
          turnIndex: 0,
          text: (event['delta'] as string) ?? '',
        });
        break;

      // ── Response cancelled (auto-cancel on barge-in by OpenAI) ─
      case 'response.cancelled':
        // OpenAI cancelled the in-flight response (semantic_vad did this
        // automatically when speech_started fired).  Clear audio tracking;
        // the barge-in state machine handles the client-side truncation.
        this.currentItemId = null;
        this.audioSentMs = 0;
        break;

      // ── Turn complete ────────────────────────────────────────
      case 'response.done': {
        const response = event['response'] as {
          id?: string;
          output?: unknown[];
          usage?: RealtimeUsage;
        } | undefined;

        // Check for function_call items — if present this is a tool-call
        // intermediate response, not a user-facing turn.
        const output = response?.output ?? [];
        const fnCalls = (output as Record<string, unknown>[]).filter(
          (item) => item['type'] === 'function_call',
        );

        if (fnCalls.length > 0 && callbacks?.onToolCall) {
          // Async: execute tools and feed results back to OpenAI.
          // Do NOT increment turnCount or call onTurnComplete here —
          // the model will generate another response.done once it has
          // processed the tool outputs.
          void this.executeToolCalls(fnCalls, clientWs, callbacks);
          break;
        }

        // ── Normal (audio/text) turn complete ─────────────────────
        const durationMs = this.turnStartMs ? Date.now() - this.turnStartMs : 0;
        const usage = response?.usage;

        // Phase 5: compute real cost from GA token usage.
        const costUsd = usage ? computeRealtimeCostUsd(usage) : 0;
        this.totalCostUsd += costUsd;

        this.turnCount++;
        const turnIdx = this.turnCount - 1; // 0-based within this session instance

        callbacks?.onTurnComplete?.(durationMs, usage);

        // turn_complete: per-turn cost now populated from real usage.
        this.sendToClient(clientWs, {
          type: 'turn_complete',
          turnIndex: turnIdx,
          costUsd,
          durationMs,
        });

        // cost_update: sent only when usage data is available, giving the
        // client both the per-turn cost and the running session total.
        if (costUsd > 0) {
          this.sendToClient(clientWs, {
            type: 'cost_update',
            turnIndex: turnIdx,
            costUsd,
            totalCostUsd: this.totalCostUsd,
          });
        }

        // Session rotation: every N turns, transparently cycle the OpenAI connection
        // to prevent latency drift from an ever-growing context window.
        const rotateAfter = this.storedOpts?.rotateAfterTurns ?? 8;
        if (
          rotateAfter > 0 &&
          this.turnCount % rotateAfter === 0 &&
          !this.rotationInProgress
        ) {
          void this.rotateSession(clientWs, callbacks);
        }
        break;
      }

      // ── Errors from OpenAI ───────────────────────────────────
      case 'error':
        this.sendToClient(clientWs, {
          type: 'error',
          code: (event['error'] as { code?: string })?.code ?? 'openai_error',
          message: (event['error'] as { message?: string })?.message ?? 'Unknown error',
          retryable: false,
        });
        break;

      // ── Rate limits — forward for client awareness ───────────
      case 'rate_limits.updated':
        this.sendToClient(clientWs, event);
        break;

      // ── All other events forwarded verbatim ──────────────────
      default:
        this.sendToClient(clientWs, event);
    }
  }

  // ── Tool execution ────────────────────────────────────────

  /**
   * Execute all function_call items from a `response.done` event in parallel,
   * submit each result as `conversation.item.create` (type: function_call_output),
   * then send `response.create` so the model can continue generating audio.
   *
   * Each call is guarded by `toolBudgetMs` (default 800ms).  Tool timeouts and
   * thrown errors are caught and returned as error-shaped JSON so the model
   * sees a clear failure message rather than stalling indefinitely.
   */
  private async executeToolCalls(
    fnCalls: Record<string, unknown>[],
    clientWs: WsSocket,
    callbacks: RealtimeProxyCallbacks,
  ): Promise<void> {
    if (this.closed) return;

    const budgetMs = this.storedOpts?.toolBudgetMs ?? 800;

    // Execute all calls in parallel for minimum latency.
    const results = await Promise.all(
      fnCalls.map(async (call) => {
        const callId  = (call['call_id']   as string) ?? '';
        const itemId  = (call['id']        as string) ?? '';
        const name    = (call['name']      as string) ?? '';
        const args    = (call['arguments'] as string) ?? '{}';

        const startMs = Date.now();
        this.sendToClient(clientWs, { type: 'tool_executing', callId, toolName: name });

        let output: string;
        try {
          const toolPromise = callbacks.onToolCall!({ callId, itemId, name, arguments: args });

          if (budgetMs > 0) {
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`Tool '${name}' timed out after ${budgetMs}ms`)),
                budgetMs,
              ),
            );
            output = await Promise.race([toolPromise, timeoutPromise]);
          } else {
            output = await toolPromise;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Tool execution failed.';
          output = JSON.stringify({ error: msg });
          console.warn(`[realtime-proxy] tool '${name}' (${callId}) error: ${msg}`);
        }

        const durationMs = Date.now() - startMs;
        this.sendToClient(clientWs, { type: 'tool_complete', callId, durationMs });
        console.log(`[realtime-proxy] tool '${name}' completed in ${durationMs}ms`);

        return { callId, output };
      }),
    );

    if (this.closed) return;

    // Submit all function_call_output items to OpenAI.
    for (const { callId, output } of results) {
      this.sendToOpenAI({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output },
      });
    }

    // Ask the model to continue (generates audio response using tool results).
    this.sendToOpenAI({ type: 'response.create' });
  }

  // ── Guardrail enforcement ─────────────────────────────────

  /**
   * Run the input guardrail callback on the user's speech transcript.
   *
   * On deny:
   *   1. Cancel any in-flight model response (response.cancel).
   *   2. Inject a pre-written refusal as an assistant conversation item
   *      (so it appears in history and the model references it naturally).
   *   3. Trigger a new response so the model speaks the refusal aloud.
   *   4. Notify the client via guardrail_denied { phase: 'input' }.
   *
   * Errors from the callback are caught and treated as 'allow' (fail open)
   * so a slow or crashing guardrail never silences the agent.
   */
  private async runInputGuardrail(
    transcript: string,
    clientWs: WsSocket,
    callbacks: RealtimeProxyCallbacks,
  ): Promise<void> {
    if (this.closed || !callbacks.onInputGuardrail) return;

    let result: { decision: 'allow' | 'warn' | 'deny'; reason?: string };
    try {
      result = await callbacks.onInputGuardrail(transcript);
    } catch (err) {
      console.warn('[realtime-proxy] onInputGuardrail threw — failing open', err);
      return;
    }

    if (this.closed || result.decision !== 'deny') return;

    const reason = result.reason ?? 'Content policy violation';
    console.log(`[realtime-proxy] input guardrail denied (reason: ${reason})`);

    // Cancel any in-flight model response.
    this.sendToOpenAI({ type: 'response.cancel' });

    // Inject the refusal text as an assistant turn so the model won't
    // try to re-attempt the blocked request on the next turn.
    this.sendToOpenAI({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: GUARDRAIL_INPUT_REFUSAL }],
      },
    });

    // Ask the model to generate audio of the refusal.
    this.sendToOpenAI({ type: 'response.create' });

    // Notify the client so it can update UI state.
    this.sendToClient(clientWs, {
      type: 'guardrail_denied',
      turnIndex: 0,
      phase: 'input' as const,
      reason,
    });
  }

  /**
   * Run the output guardrail callback on the agent's completed response
   * transcript.
   *
   * By the time this fires (`response.output_audio_transcript.done`), the
   * audio has already been streamed to the client — this is an inherent
   * constraint of real-time streaming voice.
   *
   * On deny:
   *   1. Send `conversation.item.truncate` to remove the harmful response
   *      from OpenAI's context (so the model won't reference it again).
   *      audio_end_ms: 0 removes the entire response from model history.
   *   2. Notify the client via guardrail_denied { phase: 'output' } so it
   *      can clear its audio queue and show a content-policy notice.
   *
   * Errors from the callback are caught and treated as 'allow' (fail open).
   */
  private async runOutputGuardrail(
    transcript: string,
    clientWs: WsSocket,
    callbacks: RealtimeProxyCallbacks,
  ): Promise<void> {
    if (this.closed || !callbacks.onOutputGuardrail) return;

    let result: { decision: 'allow' | 'warn' | 'deny'; reason?: string };
    try {
      result = await callbacks.onOutputGuardrail(transcript);
    } catch (err) {
      console.warn('[realtime-proxy] onOutputGuardrail threw — failing open', err);
      return;
    }

    if (this.closed || result.decision !== 'deny') return;

    const reason = result.reason ?? 'Content policy violation';
    console.log(`[realtime-proxy] output guardrail denied (reason: ${reason})`);

    // Remove the harmful response from OpenAI's conversation context.
    // audio_end_ms: 0 marks the entire audio as unplayed from the model's
    // perspective, effectively erasing it from the conversation history.
    if (this.lastAudioItemId) {
      this.sendToOpenAI({
        type: 'conversation.item.truncate',
        item_id: this.lastAudioItemId,
        content_index: 0,
        audio_end_ms: 0,
      });
    }

    // Notify the client to clear buffered audio and show a content notice.
    this.sendToClient(clientWs, {
      type: 'guardrail_denied',
      turnIndex: 0,
      phase: 'output' as const,
      reason,
    });
  }

  // ── Session rotation ──────────────────────────────────────

  /**
   * Transparently rotate the upstream OpenAI WebSocket connection.
   *
   * Opens a fresh connection, seeds it with an updated system prompt (which
   * may include fresh memory context from the application layer), then
   * gracefully closes the old connection.  The client WebSocket stays open
   * and is completely unaware of the rotation.
   *
   * Rotation prevents the latency drift that accumulates when the OpenAI
   * context window grows over many turns in a single session.
   */
  private async rotateSession(
    clientWs: WsSocket,
    callbacks?: RealtimeProxyCallbacks,
  ): Promise<void> {
    if (!this.storedOpts || this.closed) return;
    this.rotationInProgress = true;
    const opts = this.storedOpts;
    const rotationStart = Date.now();

    console.log(`[realtime-proxy] session rotation starting (turn=${this.turnCount})`);

    // Ask the application layer for a fresh system prompt + tools (memory re-injection).
    let newSystemPrompt = opts.systemPrompt ?? 'You are a helpful voice assistant.';
    let newTools: RealtimeTool[] | undefined = opts.tools;
    if (callbacks?.onRotateSession) {
      try {
        const refreshed = await callbacks.onRotateSession(this.turnCount, this.currentTranscript);
        newSystemPrompt = refreshed.systemPrompt;
        if (refreshed.tools !== undefined) newTools = refreshed.tools;
      } catch (err) {
        console.warn('[realtime-proxy] onRotateSession callback failed — reusing existing prompt', err);
      }
    }

    const oldWs = this.openaiWs;
    const url = `${OPENAI_REALTIME_BASE}?model=${encodeURIComponent(opts.model)}`;
    const newWs = new WebSocket(url, { headers: { 'Authorization': `Bearer ${opts.apiKey}` } });

    const rotationTimeoutMs = 5_000;
    const rotationTimer = setTimeout(() => {
      console.warn('[realtime-proxy] session rotation timed out — keeping old session');
      newWs.close(1001, 'rotation timeout');
      this.rotationInProgress = false;
    }, rotationTimeoutMs);

    newWs.on('open', () => {
      clearTimeout(rotationTimer);

      const elapsed = Date.now() - rotationStart;
      console.log(`[realtime-proxy] session rotation complete in ${elapsed}ms (turn=${this.turnCount})`);

      // Configure the new session identically to the original, with fresh prompt + tools.
      const newSessionConfig: Record<string, unknown> = {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: newSystemPrompt,
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: { type: 'semantic_vad' },
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: opts.voice,
          },
        },
      };

      if (newTools && newTools.length > 0) {
        newSessionConfig['tools'] = newTools.map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }));
        newSessionConfig['tool_choice'] = 'auto';
      }

      newWs.send(JSON.stringify({ type: 'session.update', session: newSessionConfig }));

      // Swap the upstream connection atomically.
      this.openaiWs = newWs;
      this.storedOpts = { ...opts, systemPrompt: newSystemPrompt, tools: newTools };

      // Reset barge-in and audio tracking state for the new session.
      this.clearBargeInTimer();
      this.currentItemId = null;
      this.audioSentMs = 0;
      this.lastAudioItemId = null;
      this.lastAudioSentMs = 0;
      this.bargeInPending = false;
      this.bargeInItemId = null;

      // Close the old connection (no more messages needed from it).
      if (oldWs && oldWs.readyState === WebSocket.OPEN) {
        oldWs.close(1000, 'session rotated');
      }

      // Notify client only if rotation was slow (≥300ms) — visible UX impact.
      if (elapsed >= 300) {
        this.sendToClient(clientWs, { type: 'session_rotating' });
      }

      this.rotationInProgress = false;
    });

    // Forward OpenAI events on the NEW connection through the same handler.
    newWs.on('message', (data) => {
      if (this.closed) return;
      let event: OpenAIRealtimeEvent;
      try { event = JSON.parse(data.toString()) as OpenAIRealtimeEvent; }
      catch { return; }
      this.handleOpenAIEvent(event, clientWs, callbacks);
    });

    newWs.on('close', (code, reason) => {
      if (this.openaiWs !== newWs) return; // already rotated past this ws
      if (this.closed) return;
      this.closed = true;
      this.clearBargeInTimer();
      callbacks?.onEnd?.();
      const msg = reason?.toString() || `close ${code}`;
      console.warn(`[realtime-proxy] rotated OpenAI WS closed unexpectedly (code ${code}: ${msg})`);
      this.sendToClient(clientWs, {
        type: 'error',
        code: 'openai_realtime_unavailable',
        message: `OpenAI Realtime dropped connection after rotation (${code}).`,
        retryable: false,
        fallbackToChained: true,
      });
    });

    newWs.on('error', (err) => {
      callbacks?.onError?.(err);
      console.error(`[realtime-proxy] rotated OpenAI WS error: ${err.message}`);
    });
  }

  // ── Barge-in helpers ──────────────────────────────────────

  /**
   * Commit the barge-in: send `conversation.item.truncate` to OpenAI with
   * the exact ms of audio the user has heard, then acknowledge the client.
   */
  private commitBargein(clientWs: WsSocket, itemId: string, audioEndMs: number): void {
    this.bargeInPending = false;
    this.bargeInItemId = null;
    this.currentItemId = null;
    this.audioSentMs = 0;

    console.log(`[realtime-proxy] committing barge-in truncate item=${itemId} audioEndMs=${audioEndMs}ms`);

    if (itemId) {
      this.sendToOpenAI({
        type: 'conversation.item.truncate',
        item_id: itemId,
        content_index: 0,
        audio_end_ms: audioEndMs,
      });
    }

    this.sendToClient(clientWs, { type: 'barge_in_ack', audioEndMs });
  }

  private clearBargeInTimer(): void {
    if (this.bargeInFallbackTimer !== null) {
      clearTimeout(this.bargeInFallbackTimer);
      this.bargeInFallbackTimer = null;
    }
  }

  // ── WS helpers ────────────────────────────────────────────

  private sendToOpenAI(event: unknown): void {
    if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
      this.openaiWs.send(JSON.stringify(event));
    }
  }

  private sendToClient(clientWs: WsSocket, event: unknown): void {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(event));
    }
  }
}
