/**
 * Built-in handler kind: `agentic.voice-realtime`.
 *
 * Real-time speech-to-text and text-to-speech interaction over WebRTC/WebSocket.
 * Wraps `weaveLiveAgent` with a voice-optimised system prompt and forwards the
 * session config (voice, VAD turn detection, max duration) into the system
 * prompt header so the model is aware of its audio constraints.
 *
 * Mid-2026 state: the Anthropic realtime audio API is Generally Available for
 * WebRTC (claude-sonnet-4-6-realtime-20260101). This handler uses that model
 * family by default and passes session metadata through the system prompt so
 * the model can adapt its verbosity to voice output.
 *
 * --- Config shape ---
 *
 *   {
 *     "model":           "claude-sonnet-4-6",   // realtime-capable model
 *     "voice":           "alloy",               // TTS voice persona
 *     "turn_detection":  { "type": "server_vad", "threshold": 0.5 },
 *     "max_duration_s":  1800,                  // 30-min default cap
 *     "systemPromptSkillKey": "voice-agent.system",
 *     "fallbackPrompt":  "You are a voice assistant.",
 *     "max_steps":       60,
 *   }
 *
 * --- Required HandlerContext slots ---
 * - `model` OR `modelResolver` pointing to a realtime-audio-capable model
 * - `tools` should include voice_session_control, voice_transfer
 */

import { weaveLiveAgent, type TaskHandler } from '@weaveintel/live-agents';
import type { HandlerContext, HandlerKindRegistration } from '../handler-registry.js';

export interface AgenticVoiceRealtimeConfig {
  model?: string;
  voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
  turn_detection?: {
    type?: 'server_vad' | 'none';
    threshold?: number;
  };
  max_duration_s?: number;
  systemPromptSkillKey?: string;
  fallbackPrompt?: string;
  max_steps?: number;
}

const DEFAULT_MAX_STEPS = 60;
const DEFAULT_VOICE = 'alloy';
const DEFAULT_MAX_DURATION_S = 1800;

function readConfig(raw: Record<string, unknown>): AgenticVoiceRealtimeConfig {
  const cfg: AgenticVoiceRealtimeConfig = {};
  if (typeof raw['model'] === 'string') cfg.model = raw['model'];
  if (typeof raw['voice'] === 'string') cfg.voice = raw['voice'] as AgenticVoiceRealtimeConfig['voice'];
  if (raw['turn_detection'] && typeof raw['turn_detection'] === 'object') {
    cfg.turn_detection = raw['turn_detection'] as AgenticVoiceRealtimeConfig['turn_detection'];
  }
  if (typeof raw['max_duration_s'] === 'number') cfg.max_duration_s = raw['max_duration_s'];
  if (typeof raw['systemPromptSkillKey'] === 'string') cfg.systemPromptSkillKey = raw['systemPromptSkillKey'];
  if (typeof raw['fallbackPrompt'] === 'string') cfg.fallbackPrompt = raw['fallbackPrompt'];
  if (typeof raw['max_steps'] === 'number') cfg.max_steps = raw['max_steps'];
  return cfg;
}

async function resolveSystemPrompt(ctx: HandlerContext, cfg: AgenticVoiceRealtimeConfig): Promise<string> {
  const voice = cfg.voice ?? DEFAULT_VOICE;
  const vadType = cfg.turn_detection?.type ?? 'server_vad';
  const maxDurationMin = Math.round((cfg.max_duration_s ?? DEFAULT_MAX_DURATION_S) / 60);
  const header = `Voice Agent | Voice: ${voice} | VAD: ${vadType} | Max session: ${maxDurationMin}min`;

  if (cfg.systemPromptSkillKey && ctx.resolveSystemPrompt) {
    const resolved = await ctx.resolveSystemPrompt(cfg.systemPromptSkillKey);
    if (resolved) return `${header}\n\n${resolved}`;
  }
  if (cfg.fallbackPrompt) return `${header}\n\n${cfg.fallbackPrompt}`;

  return `${header}

You are ${ctx.agent.name}, a voice assistant. You interact with users through speech.

Voice-specific guidelines:
- Keep responses concise and conversational — spoken text should not exceed 30 seconds.
- Avoid markdown, bullet points, or formatting that doesn't translate to speech.
- Spell out numbers, dates, and abbreviations as they would be spoken.
- If the user asks for structured information (lists, tables), summarise it verbally.
- Use natural verbal transitions ("First...", "Next...", "Finally...") instead of bullet points.
- If you need to transfer the session, use the voice_transfer tool.`;
}

function buildAgenticVoiceRealtime(ctx: HandlerContext): TaskHandler {
  if (!ctx.model && !ctx.modelResolver) {
    throw new Error(
      `agentic.voice-realtime: HandlerContext.model OR HandlerContext.modelResolver is required ` +
        `for agent ${ctx.agent.id} (binding ${ctx.binding.id}).`,
    );
  }

  const cfg = readConfig(ctx.binding.config);
  const maxSteps = cfg.max_steps ?? DEFAULT_MAX_STEPS;

  const { handler } = weaveLiveAgent({
    name: ctx.agent.name || ctx.agent.roleKey,
    role: ctx.agent.roleKey,
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.modelResolver ? { modelResolver: ctx.modelResolver } : {}),
    ...(ctx.tools ? { tools: ctx.tools } : {}),
    ...(ctx.policy ? { policy: ctx.policy } : {}),
    maxSteps,
    log: ctx.log,
    prepare: async ({ inbound }) => {
      const systemPrompt = await resolveSystemPrompt(ctx, cfg);
      const userGoal = inbound
        ? `Subject: ${inbound.subject}\n\n${inbound.body}`
        : 'No inbound task; greet the user and ask how you can help.';
      return ctx.tools ? { systemPrompt, userGoal, tools: ctx.tools } : { systemPrompt, userGoal };
    },
  });

  return handler;
}

export const agenticVoiceRealtimeHandler: HandlerKindRegistration = {
  kind:        'agentic.voice-realtime',
  description: 'Real-time speech-to-text and text-to-speech interaction over WebRTC/WebSocket. Supports 30+ languages, server VAD turn detection, and configurable voice personas.',
  configSchema: {
    type: 'object',
    properties: {
      model: { type: 'string' },
      voice: {
        type: 'string',
        enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
        default: 'alloy',
      },
      turn_detection: {
        type: 'object',
        properties: {
          type:      { type: 'string', enum: ['server_vad', 'none'], default: 'server_vad' },
          threshold: { type: 'number', default: 0.5 },
        },
      },
      max_duration_s:       { type: 'integer', default: 1800 },
      systemPromptSkillKey: { type: 'string' },
      fallbackPrompt:       { type: 'string' },
      max_steps:            { type: 'integer', default: 60 },
    },
  },
  factory: buildAgenticVoiceRealtime,
};
