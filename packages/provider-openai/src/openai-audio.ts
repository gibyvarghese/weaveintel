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
      const body = {
        model: 'tts-1',
        input: request.input,
        voice: request.voice ?? 'alloy',
        ...(request.speed ? { speed: request.speed } : {}),
        ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
      };

      const signal = deadlineSignal(ctx);
      const url = `${baseUrl}/audio/speech`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify(body),
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
        const res = await fetch(url, {
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
  };
}

/** Convenience function */
export function weaveOpenAIAudio(options?: OpenAIProviderOptions): AudioModel {
  return weaveOpenAIAudioModel(options);
}
