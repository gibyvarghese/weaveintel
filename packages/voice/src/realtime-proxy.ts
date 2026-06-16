/**
 * @weaveintel/voice — VoiceRealtimeProxy
 *
 * Proxies a client WebSocket through to the OpenAI Realtime API.
 *
 * Architecture:
 *   Browser → our WS (/api/voice/sessions/:id/realtime)
 *           → VoiceRealtimeProxy
 *           → OpenAI Realtime WS (wss://api.openai.com/v1/realtime)
 *
 * The proxy:
 *   1. Opens a connection to the OpenAI Realtime API on behalf of the client,
 *      injecting the API key server-side (never sent to browser).
 *   2. Sends a session.update to configure voice, VAD, transcription, and
 *      system prompt from the agent's chat context.
 *   3. Translates our client protocol → OpenAI events in one direction, and
 *      OpenAI events → our client protocol in the other.
 *   4. Fires callbacks for audit/logging when turns complete.
 *
 * Client protocol (from browser):
 *   { type: 'audio',  payload: '<base64 PCM16 24kHz mono>' }  — audio chunk
 *   { type: 'text',   text: '<string>' }                      — text-only turn
 *   { type: 'pause' }                                         — clear audio buffer
 *   { type: 'end' }                                           — close session
 *   { type: 'ping' }                                          — keepalive
 *
 * Server → client events (subset of OpenAI events, plus our wrappers):
 *   { type: 'realtime_ready' }                                — proxy connected to OpenAI
 *   { type: 'transcript', text }                              — speech → text
 *   { type: 'llm_text', text }                                — streamed LLM text delta
 *   { type: 'audio', payload, done }                          — PCM16 audio chunk / done
 *   { type: 'turn_complete', costUsd, durationMs }
 *   { type: 'error', code, message, retryable }
 *   { type: 'pong' }
 *
 * Raw OpenAI events that don't have a mapping are forwarded verbatim so that
 * sophisticated clients can handle them directly.
 */

import WebSocket from 'ws';
import type { WebSocket as WsSocket } from 'ws';

const OPENAI_REALTIME_BASE = 'wss://api.openai.com/v1/realtime';

export interface RealtimeProxyCallbacks {
  onTranscript?: (text: string) => void;
  onResponseText?: (text: string) => void;
  onTurnComplete?: (durationMs: number) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
}

export interface RealtimeProxyOptions {
  clientWs: WsSocket;
  apiKey: string;
  model: string;
  voice: string;
  systemPrompt?: string;
  callbacks?: RealtimeProxyCallbacks;
}

interface OpenAIRealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export class VoiceRealtimeProxy {
  private openaiWs: WebSocket | null = null;
  private closed = false;
  private turnStartMs = 0;
  private currentResponseText = '';
  private currentTranscript = '';

  start(opts: RealtimeProxyOptions): void {
    const { clientWs, apiKey, model, voice, systemPrompt, callbacks } = opts;

    // GA Realtime WebSocket (server-to-server): API key directly in Authorization header.
    // The old OpenAI-Beta: realtime=v1 header identified the deprecated beta shape.
    const url = `${OPENAI_REALTIME_BASE}?model=${encodeURIComponent(model)}`;
    this.openaiWs = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    this.openaiWs.on('open', () => {
      if (this.closed) return;

      // Configure session using the GA Realtime API schema.
      // GA uses nested audio.input/output objects; modalities split: 'audio' only (not ['audio','text']).
      this.sendToOpenAI({
        type: 'session.update',
        session: {
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
        },
      });

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

    this.openaiWs.on('close', (code, reason) => {
      if (this.closed) return;
      this.closed = true;
      callbacks?.onEnd?.();
      // Never send session_ended — that ends the voice bar. Only the user closing the
      // client WS (clicking "end") should end the session. An OpenAI close (any code)
      // means the upstream connection dropped; tell the client to fall back to chained
      // mode so the voice bar stays up and the user can continue talking.
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
      // Don't send to client here — the 'close' event always follows 'error' and will handle it
      console.error(`[realtime-proxy] OpenAI WS error: ${err.message}`);
    });

    // Client → OpenAI relay
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
      }
    });

    clientWs.on('close', () => { this.close(); });
    clientWs.on('error', () => { this.close(); });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
      this.openaiWs.close(1000, 'session ended');
    }
  }

  private handleOpenAIEvent(event: OpenAIRealtimeEvent, clientWs: WsSocket, callbacks?: RealtimeProxyCallbacks): void {
    switch (event.type) {
      // Strip internal session details before forwarding
      case 'session.created':
      case 'session.updated':
        this.sendToClient(clientWs, { type: event.type });
        break;

      // Input speech detection
      case 'input_audio_buffer.speech_started':
        this.turnStartMs = Date.now();
        this.currentTranscript = '';
        this.currentResponseText = '';
        this.sendToClient(clientWs, { type: 'speech_started' });
        break;

      case 'input_audio_buffer.speech_stopped':
        this.sendToClient(clientWs, { type: 'speech_stopped' });
        break;

      // Input transcription (what the user said) — GA event name
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (event['transcript'] as string) ?? '';
        this.currentTranscript = text;
        callbacks?.onTranscript?.(text);
        this.sendToClient(clientWs, { type: 'transcript', turnIndex: 0, text });
        break;
      }

      // Output transcription (what the model said) — GA emits this when output_modalities includes audio
      case 'response.output_audio_transcript.done': {
        const text = (event['transcript'] as string) ?? '';
        this.currentResponseText = text;
        callbacks?.onResponseText?.(text);
        this.sendToClient(clientWs, { type: 'llm_text', turnIndex: 0, text });
        break;
      }

      // Streaming response text (text modality) — GA event name
      case 'response.output_text.delta':
      // Beta name kept for backward compat if proxied to older clients
      case 'response.text.delta':
        this.currentResponseText += (event['delta'] as string) ?? '';
        this.sendToClient(clientWs, { type: 'llm_text', turnIndex: 0, text: (event['delta'] as string) ?? '' });
        break;

      // Streaming response audio — GA event names
      case 'response.output_audio.delta':
      // Beta name kept for backward compat
      case 'response.audio.delta':
        this.sendToClient(clientWs, {
          type: 'audio',
          turnIndex: 0,
          payload: event['delta'],
          mimeType: 'audio/pcm',
          done: false,
        });
        break;

      case 'response.output_audio.done':
      case 'response.audio.done':
        this.sendToClient(clientWs, {
          type: 'audio',
          turnIndex: 0,
          payload: '',
          mimeType: 'audio/pcm',
          done: true,
        });
        break;

      // Turn complete
      case 'response.done': {
        const durationMs = this.turnStartMs ? Date.now() - this.turnStartMs : 0;
        // onResponseText already fired from response.output_audio_transcript.done / response.output_text.delta
        callbacks?.onTurnComplete?.(durationMs);
        this.sendToClient(clientWs, { type: 'turn_complete', turnIndex: 0, costUsd: 0, durationMs });
        break;
      }

      // Errors from OpenAI
      case 'error':
        this.sendToClient(clientWs, {
          type: 'error',
          code: (event['error'] as { code?: string })?.code ?? 'openai_error',
          message: (event['error'] as { message?: string })?.message ?? 'Unknown error',
          retryable: false,
        });
        break;

      // Rate limits — forward for client awareness
      case 'rate_limits.updated':
        this.sendToClient(clientWs, event);
        break;

      // All other events forwarded verbatim
      default:
        this.sendToClient(clientWs, event);
    }
  }

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
