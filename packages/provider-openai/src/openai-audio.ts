/**
 * @weaveintel/provider-openai — OpenAI Audio adapter (TTS + STT)
 *
 * Implements the generic AudioModel contract using OpenAI's audio endpoints.
 * Supports text-to-speech (TTS) and speech-to-text (STT/Whisper).
 */

import type {
  AudioModel,
  SpeechRequest,
  TranscriptionRequest,
  TranscriptionResult,
  TranscriptSegment,
  ModelInfo,
  ExecutionContext,
} from '@weaveintel/core';
import {
  Capabilities,
  weaveCapabilities,
  deadlineSignal,
  normalizeError,
  WeaveIntelError,
} from '@weaveintel/core';
import { openaiFetch, openaiFetchStream } from './_fetch.js';
import {
  type OpenAIProviderOptions,
  DEFAULT_BASE_URL,
  resolveApiKey,
  makeHeaders,
} from './shared.js';

export function weaveOpenAIAudioModel(
  providerOptions?: OpenAIProviderOptions,
): AudioModel {
  const opts = providerOptions ?? {};
  const apiKey = resolveApiKey(opts);
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const jsonHeaders = makeHeaders(opts, apiKey);
  const caps = weaveCapabilities(Capabilities.Audio);

  const info: ModelInfo = {
    provider: 'openai',
    modelId: 'tts-1/whisper-1',
    capabilities: caps.capabilities,
  };

  return {
    info,
    ...caps,

    async speak(ctx: ExecutionContext, request: SpeechRequest): Promise<Buffer> {
      const reqBody = {
        model: 'tts-1',
        input: request.input,
        voice: request.voice ?? 'alloy',
        ...(request.speed ? { speed: request.speed } : {}),
        ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
      };

      const deadlineSig = deadlineSignal(ctx);
      const reqSig = request.signal;
      const signal = (deadlineSig && reqSig)
        ? AbortSignal.any([deadlineSig, reqSig])
        : (deadlineSig ?? reqSig);
      const url = `${baseUrl}/audio/speech`;
      try {
        const res = await openaiFetch(url, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify(reqBody),
          signal,
        });

        if (!res.ok) {
          const errorBody = await res.text().catch(() => '');
          throw new WeaveIntelError({
            code: 'PROVIDER_ERROR',
            message: `OpenAI TTS error (${res.status}): ${errorBody}`,
            provider: 'openai',
            retryable: res.status >= 500,
          });
        }

        const arrayBuffer = await res.arrayBuffer();
        return Buffer.from(arrayBuffer);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async *speakStream(ctx: ExecutionContext, request: SpeechRequest): AsyncIterable<Buffer> {
      const reqBody = {
        model: 'tts-1',
        input: request.input,
        voice: request.voice ?? 'alloy',
        ...(request.speed ? { speed: request.speed } : {}),
        ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
      };

      const deadlineSig = deadlineSignal(ctx);
      const reqSig = request.signal;
      const signal = (deadlineSig && reqSig)
        ? AbortSignal.any([deadlineSig, reqSig])
        : (deadlineSig ?? reqSig);
      const url = `${baseUrl}/audio/speech`;

      let res: Response;
      try {
        // openaiFetchStream: SSRF-guarded, no outer timeout (suitable for streaming)
        res = await openaiFetchStream(url, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify(reqBody),
          signal,
        });
      } catch (err) {
        throw normalizeError(err, 'openai');
      }

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '');
        throw new WeaveIntelError({
          code: 'PROVIDER_ERROR',
          message: `OpenAI TTS stream error (${res.status}): ${errorBody}`,
          provider: 'openai',
          retryable: res.status >= 500,
        });
      }

      if (!res.body) return;

      try {
        // Node.js 18+ Web ReadableStream supports async iteration
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          yield Buffer.from(chunk);
        }
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async transcribe(ctx: ExecutionContext, request: TranscriptionRequest): Promise<string> {
      const signal = deadlineSignal(ctx);
      const url = `${baseUrl}/audio/transcriptions`;

      // Multipart form upload
      const formData = new FormData();
      const audioBytes = request.audio.buffer.slice(request.audio.byteOffset, request.audio.byteOffset + request.audio.byteLength) as ArrayBuffer;
      const blob = new Blob([audioBytes], { type: 'audio/wav' });
      formData.append('file', blob, 'audio.wav');
      formData.append('model', 'whisper-1');
      if (request.language) formData.append('language', request.language);
      if (request.prompt) formData.append('prompt', request.prompt);

      try {
        const res = await openaiFetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...(opts.organization ? { 'OpenAI-Organization': opts.organization } : {}),
            ...opts.defaultHeaders,
          },
          body: formData,
          signal,
        });

        if (!res.ok) {
          const errorBody = await res.text().catch(() => '');
          throw new WeaveIntelError({
            code: 'PROVIDER_ERROR',
            message: `OpenAI STT error (${res.status}): ${errorBody}`,
            provider: 'openai',
            retryable: res.status >= 500,
          });
        }

        const result = (await res.json()) as Record<string, unknown>;
        return String(result['text'] ?? '');
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    // Rich transcription: request `verbose_json` so the provider returns timestamped SEGMENTS in
    // addition to the flat text. Powers transcript-anchored features (meeting notes with clickable
    // citations). Honours request.model / request.mimeType; falls back gracefully if segments are absent.
    async transcribeDetailed(ctx: ExecutionContext, request: TranscriptionRequest): Promise<TranscriptionResult> {
      const signal = deadlineSignal(ctx);
      const url = `${baseUrl}/audio/transcriptions`;
      const mimeType = request.mimeType && request.mimeType.trim() ? request.mimeType : 'audio/wav';
      const ext = extForMime(mimeType);

      const formData = new FormData();
      const audioBytes = request.audio.buffer.slice(request.audio.byteOffset, request.audio.byteOffset + request.audio.byteLength) as ArrayBuffer;
      formData.append('file', new Blob([audioBytes], { type: mimeType }), `audio.${ext}`);
      formData.append('model', request.model && request.model.trim() ? request.model : 'whisper-1');
      formData.append('response_format', 'verbose_json');
      // segment granularity is the whisper-1 default for verbose_json; keep it explicit + portable.
      if (request.language) formData.append('language', request.language);
      if (request.prompt) formData.append('prompt', request.prompt);

      try {
        const res = await openaiFetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...(opts.organization ? { 'OpenAI-Organization': opts.organization } : {}),
            ...opts.defaultHeaders,
          },
          body: formData,
          signal,
        });
        if (!res.ok) {
          const errorBody = await res.text().catch(() => '');
          throw new WeaveIntelError({
            code: 'PROVIDER_ERROR',
            message: `OpenAI STT error (${res.status}): ${errorBody}`,
            provider: 'openai',
            retryable: res.status >= 500,
          });
        }
        const result = (await res.json()) as Record<string, unknown>;
        const text = String(result['text'] ?? '');
        const rawSegments = Array.isArray(result['segments']) ? (result['segments'] as Array<Record<string, unknown>>) : [];
        const segments: TranscriptSegment[] = rawSegments.map((s) => ({
          start: Number(s['start'] ?? 0),
          end: Number(s['end'] ?? 0),
          text: String(s['text'] ?? '').trim(),
        })).filter((s) => s.text.length > 0);
        // If the provider returned no segments (e.g. an older format), fall back to one segment = whole text.
        const finalSegments = segments.length ? segments : (text.trim() ? [{ start: 0, end: Number(result['duration'] ?? 0), text: text.trim() }] : []);
        return {
          text,
          ...(typeof result['language'] === 'string' ? { language: result['language'] as string } : {}),
          ...(result['duration'] !== undefined ? { duration: Number(result['duration']) } : {}),
          segments: finalSegments,
        };
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },
  };
}

/** Map a MIME type to a filename extension the OpenAI upload accepts. */
function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('webm')) return 'webm';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('flac')) return 'flac';
  return 'wav';
}

/** Convenience function */
export function weaveOpenAIAudio(options?: OpenAIProviderOptions): AudioModel {
  return weaveOpenAIAudioModel(options);
}
