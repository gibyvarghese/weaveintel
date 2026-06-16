/**
 * @weaveintel/geneweave — VoiceEngine
 *
 * Wires together:
 *   • @weaveintel/voice VoicePipeline (STT → LLM → TTS)
 *   • GeneWeave ChatEngine (full text agent stack — memory, tools, guardrails,
 *     cost governor, evals, contracts, a2a, supervisor/worker, workflows, etc.)
 *   • DatabaseAdapter (voice sessions + events persistence)
 *   • ws WebSocket server (real-time audio duplex)
 *
 * All text-agent capabilities are inherited automatically because VoicePipeline
 * delegates the LLM phase to ChatEngine.sendMessage().  The voice agent is not
 * a separate agent — it reuses the SAME chat conversation, so voice turns appear
 * in message history alongside text turns and share memory, tool state, and cost
 * tracking.
 *
 * Capability summary (identical to text agents unless noted):
 *   ✓ Memory (semantic, episodic, entity, working)
 *   ✓ All tools (agenda, code execution, web search, a2a, etc.)
 *   ✓ Guardrails (input/output, model-graded)
 *   ✓ Cost governor (all 9 levers)
 *   ✓ Evals + contracts
 *   ✓ Supervisor / worker / ensemble modes
 *   ✓ Workflows
 *   ✓ Observability (traces, spans, usage)
 *   ✓ Skills + prompt augmentation
 *   ✓ PII redaction
 *   ◈ STT + TTS via OpenAI (Whisper + tts-1) — voice-specific
 *   ◈ WebSocket real-time audio streaming — voice-specific
 *   ◈ REST turn endpoint (for non-WS clients) — voice-specific
 */

import { newUUIDv7, weaveContext } from '@weaveintel/core';
import type { AudioModel } from '@weaveintel/core';
import type { IncomingMessage } from 'node:http';
import type { WebSocket as WsSocket } from 'ws';
import {
  VoicePipeline,
  VoiceWsHandler,
  VoiceRealtimeProxy,
  type VoiceConfig,
  type VoiceTurnResult,
} from '@weaveintel/voice';
import type { DatabaseAdapter, VoiceConfigCreate } from './db.js';
import type { VoiceSessionStatus } from './db-types/adapter-voice.js';
import type { ChatEngine } from './chat.js';

// ─── Config ───────────────────────────────────────────────────

export interface VoiceEngineOptions {
  db: DatabaseAdapter;
  chatEngine: ChatEngine;
  audioModel: AudioModel;
  /** OpenAI API key — used for the Realtime API proxy */
  openaiApiKey: string;
  /** Default voice config applied when user has no saved preferences */
  defaultConfig?: Partial<VoiceConfig>;
}

// ─── Engine ───────────────────────────────────────────────────

export class VoiceEngine {
  private readonly db: DatabaseAdapter;
  private readonly chatEngine: ChatEngine;
  private readonly audioModel: AudioModel;
  private readonly defaultConfig: VoiceConfig;
  private readonly openaiApiKey: string;

  constructor(opts: VoiceEngineOptions) {
    this.db = opts.db;
    this.chatEngine = opts.chatEngine;
    this.audioModel = opts.audioModel;
    this.openaiApiKey = opts.openaiApiKey;
    this.defaultConfig = {
      sttProvider: 'openai',
      sttModel: 'whisper-1',
      sttLanguage: undefined,
      ttsProvider: 'openai',
      ttsModel: 'tts-1',
      ttsVoice: 'alloy',
      ttsSpeed: 1.0,
      ttsFormat: 'mp3',
      enabledTools: null,
      mode: 'agent',
      pipelineMode: 'chained',
      realtimeModel: 'gpt-realtime-2',
      ...opts.defaultConfig,
    };
  }

  // ── Config helpers ──────────────────────────────────────────

  async getOrCreateConfig(userId: string, tenantId?: string | null): Promise<VoiceConfig> {
    const row = await this.db.getVoiceConfig(userId);
    if (row) {
      return {
        sttProvider: row.stt_provider,
        sttModel: row.stt_model,
        sttLanguage: row.stt_language ?? undefined,
        ttsProvider: row.tts_provider,
        ttsModel: row.tts_model,
        ttsVoice: row.tts_voice,
        ttsSpeed: row.tts_speed,
        ttsFormat: row.tts_format,
        enabledTools: row.enabled_tools ? (JSON.parse(row.enabled_tools) as string[]) : null,
        mode: row.mode,
        guardrailPolicy: row.guardrail_policy ?? undefined,
        costPolicy: row.cost_policy ?? undefined,
        pipelineMode: (row.pipeline_mode as 'chained' | 'realtime') ?? 'chained',
        realtimeModel: row.realtime_model ?? 'gpt-realtime-2',
      };
    }
    // Seed defaults for first-time user
    const create: VoiceConfigCreate = {
      userId,
      tenantId: tenantId ?? null,
      sttProvider: this.defaultConfig.sttProvider,
      sttModel: this.defaultConfig.sttModel,
      sttLanguage: this.defaultConfig.sttLanguage ?? null,
      ttsProvider: this.defaultConfig.ttsProvider,
      ttsModel: this.defaultConfig.ttsModel,
      ttsVoice: this.defaultConfig.ttsVoice,
      ttsSpeed: this.defaultConfig.ttsSpeed,
      ttsFormat: this.defaultConfig.ttsFormat,
      enabledTools: this.defaultConfig.enabledTools ?? null,
      mode: this.defaultConfig.mode,
      pipelineMode: this.defaultConfig.pipelineMode ?? 'chained',
      realtimeModel: this.defaultConfig.realtimeModel ?? 'gpt-realtime-2',
    };
    await this.db.upsertVoiceConfig(create);
    return { ...this.defaultConfig };
  }

  async updateConfig(userId: string, patch: Partial<VoiceConfig>): Promise<VoiceConfig> {
    // Ensure the row exists before updating; if it's a new user, seed defaults first.
    await this.getOrCreateConfig(userId);
    await this.db.updateVoiceConfig(userId, {
      sttProvider: patch.sttProvider,
      sttModel: patch.sttModel,
      // Only pass null-able fields when they were explicitly set in the patch
      sttLanguage: 'sttLanguage' in patch ? (patch.sttLanguage ?? null) : undefined,
      ttsProvider: patch.ttsProvider,
      ttsModel: patch.ttsModel,
      ttsVoice: patch.ttsVoice,
      ttsSpeed: patch.ttsSpeed,
      ttsFormat: patch.ttsFormat,
      enabledTools: 'enabledTools' in patch ? (patch.enabledTools ?? null) : undefined,
      mode: patch.mode,
      guardrailPolicy: 'guardrailPolicy' in patch ? (patch.guardrailPolicy ?? null) : undefined,
      costPolicy: 'costPolicy' in patch ? (patch.costPolicy ?? null) : undefined,
      pipelineMode: patch.pipelineMode,
      realtimeModel: patch.realtimeModel,
    });
    return this.getOrCreateConfig(userId);
  }

  // ── Session lifecycle ───────────────────────────────────────

  /**
   * Create a new voice session bound to an existing (or new) chat.
   * If chatId is omitted, a new chat is created automatically.
   */
  async createSession(opts: {
    userId: string;
    tenantId?: string | null;
    chatId?: string;
    configOverride?: Partial<VoiceConfig>;
  }): Promise<{ sessionId: string; chatId: string; config: VoiceConfig }> {
    const config = await this.getOrCreateConfig(opts.userId, opts.tenantId);

    // Apply per-session overrides
    const effective: VoiceConfig = { ...config, ...opts.configOverride };

    let chatId = opts.chatId;
    if (!chatId) {
      chatId = newUUIDv7();
      await this.db.createChat({
        id: chatId,
        userId: opts.userId,
        title: 'Voice Chat',
        model: this.chatEngine.modelConfig.defaultModel,
        provider: this.chatEngine.modelConfig.defaultProvider,
      });
    }

    // Apply voice mode settings to the chat
    await this.db.saveChatSettings({
      chatId,
      mode: effective.mode,
      enabledTools: effective.enabledTools ? JSON.stringify(effective.enabledTools) : undefined,
    });

    const sessionId = newUUIDv7();
    await this.db.createVoiceSession({
      id: sessionId,
      userId: opts.userId,
      tenantId: opts.tenantId ?? null,
      chatId,
      configSnapshot: JSON.stringify(effective),
    });

    // Audit: session_start
    await this.db.insertVoiceSessionEvent({
      id: newUUIDv7(),
      sessionId,
      userId: opts.userId,
      turnIndex: 0,
      eventType: 'session_start',
    });

    return { sessionId, chatId, config: effective };
  }

  async endSession(sessionId: string, userId: string): Promise<void> {
    await this.db.endVoiceSession(sessionId, userId);
    await this.db.insertVoiceSessionEvent({
      id: newUUIDv7(),
      sessionId,
      userId,
      turnIndex: -1,
      eventType: 'session_end',
    });
  }

  async getSession(sessionId: string, userId: string) {
    const row = await this.db.getVoiceSession(sessionId, userId);
    if (!row) return null;
    return {
      ...row,
      config: JSON.parse(row.config_snapshot) as VoiceConfig,
    };
  }

  async listSessions(userId: string, filter?: { status?: VoiceSessionStatus; limit?: number }) {
    return this.db.listVoiceSessions(userId, filter);
  }

  // ── REST turn processing ────────────────────────────────────

  /**
   * Process one voice turn over REST (no WebSocket).
   * Client POSTs audio bytes; response includes transcript + LLM text + TTS audio.
   */
  async processTurnRest(opts: {
    sessionId: string;
    userId: string;
    audio: Buffer;
    mimeType?: string;
    textOverride?: string;
  }): Promise<VoiceTurnResult> {
    const row = await this.db.getVoiceSession(opts.sessionId, opts.userId);
    if (!row) throw new Error(`Voice session ${opts.sessionId} not found`);
    if (row.status === 'ended') throw new Error('Voice session has ended');
    if (row.status === 'error') throw new Error('Voice session is in error state');

    const config = JSON.parse(row.config_snapshot) as VoiceConfig;
    const pipeline = this.buildPipeline(opts.userId, config);

    const turnIndex = row.total_turns;
    const t0 = Date.now();

    const result = await pipeline.processTurn(
      opts.sessionId,
      turnIndex,
      opts.userId,
      row.chat_id,
      config,
      { audio: opts.audio, mimeType: opts.mimeType, textOverride: opts.textOverride },
      weaveContext({ deadline: Date.now() + 120_000 }),
    );

    const durationMs = Date.now() - t0;

    // Persist stats + audit event
    await this.db.updateVoiceSessionStats(opts.sessionId, opts.userId, {
      turns: 1,
      sttMs: result.sttMs,
      llmMs: result.llmMs,
      ttsMs: result.ttsMs,
      costUsd: result.costUsd,
      audioBytes: opts.audio.length + result.responseAudio.length,
      lastActiveAt: new Date().toISOString(),
    });

    await this.db.insertVoiceSessionEvent({
      id: newUUIDv7(),
      sessionId: opts.sessionId,
      userId: opts.userId,
      turnIndex,
      eventType: 'llm',
      inputText: result.transcript.slice(0, 4000),
      outputText: result.responseText.slice(0, 4000),
      audioBytesIn: opts.audio.length,
      audioBytesOut: result.responseAudio.length,
      sttProvider: config.sttProvider,
      sttModel: config.sttModel,
      ttsProvider: config.ttsProvider,
      ttsModel: config.ttsModel,
      ttsVoice: config.ttsVoice,
      llmProvider: result.llmProvider,
      llmModel: result.llmModel,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      durationMs,
      costUsd: result.costUsd,
      error: null,
      guardrailDecision: result.guardrailDecision,
      traceId: result.traceId ?? null,
    });

    return result;
  }

  // ── WebSocket session ───────────────────────────────────────

  /**
   * Accept a WebSocket upgrade and attach a VoiceWsHandler.
   * The handler manages the full real-time audio duplex session.
   */
  async handleWebSocket(opts: {
    sessionId: string;
    userId: string;
    ws: WsSocket;
    req: IncomingMessage;
  }): Promise<VoiceWsHandler> {
    const row = await this.db.getVoiceSession(opts.sessionId, opts.userId);
    if (!row) {
      opts.ws.close(4004, 'session not found');
      throw new Error(`Voice session ${opts.sessionId} not found`);
    }
    if (row.status === 'ended') {
      opts.ws.close(4010, 'session ended');
      throw new Error('Voice session has ended');
    }

    const config = JSON.parse(row.config_snapshot) as VoiceConfig;
    const pipeline = this.buildPipeline(opts.userId, config);

    // Map VoiceSessionRow to VoiceSession shape expected by VoiceWsHandler
    const session = {
      id: row.id,
      userId: row.user_id,
      tenantId: row.tenant_id,
      chatId: row.chat_id,
      status: row.status as 'active' | 'paused' | 'ended' | 'error',
      config,
      totalTurns: row.total_turns,
      totalSttMs: row.total_stt_ms,
      totalTtsMs: row.total_tts_ms,
      totalLlmMs: row.total_llm_ms,
      totalCostUsd: row.total_cost_usd,
      totalAudioBytes: row.total_audio_bytes,
      wsConnected: row.ws_connected === 1,
      lastActiveAt: row.last_active_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    const handler = new VoiceWsHandler({
      session,
      ws: opts.ws,
      pipeline,
      callbacks: {
        onConnectionChange: async (sid, connected) => {
          await this.db.updateVoiceSessionStats(sid, opts.userId, { wsConnected: connected });
        },
        onTurnComplete: async (sid, turnResult) => {
          await this.db.updateVoiceSessionStats(sid, opts.userId, {
            turns: 1,
            sttMs: turnResult.sttMs,
            llmMs: turnResult.llmMs,
            ttsMs: turnResult.ttsMs,
            costUsd: turnResult.costUsd,
            audioBytes: turnResult.audioBytesIn + turnResult.audioBytesOut,
            lastActiveAt: new Date().toISOString(),
          });
          await this.db.insertVoiceSessionEvent({
            id: newUUIDv7(),
            sessionId: sid,
            userId: opts.userId,
            turnIndex: turnResult.turnIndex,
            eventType: turnResult.error ? 'error' : 'llm',
            inputText: turnResult.transcript?.slice(0, 4000) ?? null,
            outputText: turnResult.responseText?.slice(0, 4000) ?? null,
            audioBytesIn: turnResult.audioBytesIn,
            audioBytesOut: turnResult.audioBytesOut,
            sttProvider: config.sttProvider,
            sttModel: config.sttModel,
            ttsProvider: config.ttsProvider,
            ttsModel: config.ttsModel,
            ttsVoice: config.ttsVoice,
            llmProvider: turnResult.llmProvider,
            llmModel: turnResult.llmModel,
            promptTokens: turnResult.promptTokens,
            completionTokens: turnResult.completionTokens,
            durationMs: turnResult.sttMs + turnResult.llmMs + turnResult.ttsMs,
            costUsd: turnResult.costUsd,
            error: turnResult.error?.slice(0, 500) ?? null,
            guardrailDecision: turnResult.guardrailDecision,
            traceId: turnResult.traceId ?? null,
          });
        },
        onSessionEnd: async (sid) => {
          await this.db.endVoiceSession(sid, opts.userId);
          await this.db.insertVoiceSessionEvent({
            id: newUUIDv7(),
            sessionId: sid,
            userId: opts.userId,
            turnIndex: -1,
            eventType: 'session_end',
          });
        },
      },
    });

    await handler.start();
    return handler;
  }

  // ── Realtime WebSocket proxy ────────────────────────────────

  /**
   * Accept a WebSocket upgrade for the OpenAI Realtime API proxy.
   * Path: /api/voice/sessions/:sessionId/realtime
   *
   * The proxy opens a connection to the OpenAI Realtime API on behalf of the
   * client (so the API key never reaches the browser), configures server VAD
   * and voice settings from the session config, then relays audio bidirectionally.
   */
  async handleRealtimeWebSocket(opts: {
    sessionId: string;
    userId: string;
    ws: WsSocket;
  }): Promise<void> {
    const row = await this.db.getVoiceSession(opts.sessionId, opts.userId);
    if (!row) {
      opts.ws.close(4004, 'session not found');
      return;
    }
    if (row.status === 'ended') {
      opts.ws.close(4010, 'session ended');
      return;
    }

    const config = JSON.parse(row.config_snapshot) as import('@weaveintel/voice').VoiceConfig;
    const model  = config.realtimeModel ?? 'gpt-realtime-2';
    const voice  = config.ttsVoice ?? 'alloy';

    // Fetch the system prompt from chat settings / agent config if available
    const systemPrompt = `You are a helpful voice assistant. Keep responses concise and conversational.`;

    await this.db.updateVoiceSessionStats(opts.sessionId, opts.userId, {
      wsConnected: true,
      lastActiveAt: new Date().toISOString(),
    });

    let turnIndex = row.total_turns;
    const proxy = new VoiceRealtimeProxy();

    proxy.start({
      clientWs: opts.ws,
      apiKey: this.openaiApiKey,
      model,
      voice,
      systemPrompt,
      callbacks: {
        onTranscript: (text) => {
          void this.db.insertVoiceSessionEvent({
            id: newUUIDv7(),
            sessionId: opts.sessionId,
            userId: opts.userId,
            turnIndex,
            eventType: 'stt',
            inputText: text.slice(0, 4000),
            sttProvider: 'openai',
            sttModel: 'whisper-1',
          });
        },
        onResponseText: (text) => {
          void this.db.insertVoiceSessionEvent({
            id: newUUIDv7(),
            sessionId: opts.sessionId,
            userId: opts.userId,
            turnIndex,
            eventType: 'llm',
            outputText: text.slice(0, 4000),
            llmProvider: 'openai',
            llmModel: model,
          });
          turnIndex++;
        },
        onTurnComplete: (durationMs) => {
          void this.db.updateVoiceSessionStats(opts.sessionId, opts.userId, {
            turns: 1,
            lastActiveAt: new Date().toISOString(),
            llmMs: durationMs,
          });
        },
        onEnd: () => {
          void this.db.updateVoiceSessionStats(opts.sessionId, opts.userId, { wsConnected: false });
        },
      },
    });
  }

  // ── Internal ────────────────────────────────────────────────

  private buildPipeline(userId: string, _config: VoiceConfig): VoicePipeline {
    const self = this;
    return new VoicePipeline({
      audioModel: this.audioModel,
      sender: {
        async send(opts) {
          // Delegate to the full text agent stack — inherits all capabilities:
          // memory, tools, guardrails, cost governor, evals, contracts, a2a, workflows…
          const result = await self.chatEngine.sendMessage(
            opts.userId,
            opts.chatId,
            opts.content,
          );
          const guardrailDecision = result.guardrail?.decision ?? 'allow';
          return {
            assistantContent: result.assistantContent ?? '',
            guardrailDecision: guardrailDecision as 'allow' | 'warn' | 'deny',
            provider: result.routingDecision?.provider ?? '',
            model: result.routingDecision?.model ?? '',
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            costUsd: result.cost,
            traceId: result.traceId,
          };
        },
      },
    });
  }
}

// ─── Factory helper ───────────────────────────────────────────

/**
 * Build and return a VoiceEngine from the geneWeave ChatEngine config.
 * Returns null when no OpenAI API key is configured (audio requires OpenAI).
 */
export async function createVoiceEngine(
  db: DatabaseAdapter,
  chatEngine: ChatEngine,
  providers: Record<string, { apiKey?: string }>,
): Promise<VoiceEngine | null> {
  const openaiKey = providers['openai']?.apiKey;
  if (!openaiKey) {
    console.warn('[voice] OpenAI API key not configured — voice agent disabled. Set OPENAI_API_KEY to enable.');
    return null;
  }

  const { weaveOpenAIAudio } = await import('@weaveintel/provider-openai');
  const audioModel = weaveOpenAIAudio({ apiKey: openaiKey });

  return new VoiceEngine({ db, chatEngine, audioModel, openaiApiKey: openaiKey });
}
