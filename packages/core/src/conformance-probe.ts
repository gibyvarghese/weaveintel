// SPDX-License-Identifier: MIT
/**
 * @weaveintel/core — Conformance probe
 *
 * In plain words: when an operator adds a connection ("our Azure deployment",
 * "a vLLM server in the tenant's network"), what it can really do is not known
 * until it is tried. This probe sends a handful of TINY requests — a one-word
 * chat, a 32×32 red square, a one-line PDF, a JSON-schema question, one tool
 * offer, one embedding — and writes down what worked as a measured
 * `ModelCapabilityProfile`. Hosts run it when a connection is saved and on a
 * schedule, and route on the result.
 *
 * It makes real calls through the models it is given. It never sends tenant
 * content: every input is fixed and harmless. Tests pass deterministic stand-ins.
 */

import type { ExecutionContext } from './context.js';
import type { EmbeddingModel, Model, ModelRequest, ModelResponse } from './models.js';
import {
  ModelFeatures,
  isUnsupportedContentError,
  type ModelCapabilityProfile,
  type ModelFeature,
  type ProbeEvidence,
} from './model-profile.js';

/** A 32×32 solid red PNG. */
export const PROBE_RED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC';

/** The number written in the probe PDF. */
export const PROBE_PDF_CODE = '4721';

/** A one-page PDF that says "Probe code 4721". Built here so no fixture file is needed. */
export function buildProbePdfBase64(text = `Probe code ${PROBE_PDF_CODE}`): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return btoa(out);
}

export interface ProbeAudioSample {
  readonly base64: string;
  readonly mimeType: string;
  /** A word that must appear (case-insensitively) in the model's answer. */
  readonly expectWord: string;
}

export interface ProbeOptions {
  /** The chat model to probe. */
  readonly chat?: Model;
  /** The embedding model to probe. */
  readonly embedding?: EmbeddingModel;
  /** Audio is probed only with a sample the host provides (the library ships no recordings). */
  readonly audioSample?: ProbeAudioSample;
  /** Features to skip (each costs one small call). */
  readonly skip?: readonly ModelFeature[];
  /** Clock, for tests. */
  readonly now?: () => number;
}

/** The measured profile, plus whether the plain chat round trip worked at all. */
export interface ProbeResult {
  readonly profile: ModelCapabilityProfile;
  readonly chatOk: boolean;
  readonly evidence: readonly ProbeEvidence[];
}

const short = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}...` : s);

/**
 * Measure what a connection can do. Each check is independent: one failure
 * never stops the rest. A refusal by the adapter (`UNSUPPORTED_CONTENT`) and a
 * wrong answer both count as "not supported".
 */
export async function probeModelProfile(ctx: ExecutionContext, opts: ProbeOptions): Promise<ProbeResult> {
  const now = opts.now ?? Date.now;
  const evidence: ProbeEvidence[] = [];
  const skip = new Set(opts.skip ?? []);
  const results = new Map<string, boolean>();

  async function check(
    feature: ModelFeature,
    label: string,
    run: () => Promise<{ ok: boolean; note: string }>,
  ): Promise<boolean> {
    if (skip.has(feature)) return false;
    const started = now();
    try {
      const { ok, note } = await run();
      evidence.push({ feature, ok, note: `${label}: ${note}`, latencyMs: now() - started });
      results.set(feature, ok);
      return ok;
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'ERROR';
      const note = isUnsupportedContentError(err) ? 'refused by the adapter' : `failed (${code})`;
      evidence.push({ feature, ok: false, note: `${label}: ${note}`, latencyMs: now() - started });
      results.set(feature, false);
      return false;
    }
  }

  const chat = opts.chat;
  let chatOk = false;
  if (chat) {
    const ask = (request: ModelRequest): Promise<ModelResponse> => chat.generate(ctx, { maxTokens: 64, temperature: 0, ...request });
    const started = now();
    try {
      const res = await ask({ messages: [{ role: 'user', content: 'Reply with the single word PONG.' }] });
      chatOk = /pong/i.test(res.content);
      evidence.push({ feature: 'chat', ok: chatOk, note: `plain chat: replied "${short(res.content)}"`, latencyMs: now() - started });
    } catch (err) {
      evidence.push({ feature: 'chat', ok: false, note: `plain chat: failed (${(err as { code?: string }).code ?? 'ERROR'})`, latencyMs: now() - started });
    }

    if (chatOk) {
      await check(ModelFeatures.Vision, 'red square image', async () => {
        const res = await ask({
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'What single colour fills this image? Answer with one word.' },
              { type: 'image', base64: PROBE_RED_PNG_BASE64, mimeType: 'image/png' },
            ],
          }],
        });
        return { ok: /red/i.test(res.content), note: `replied "${short(res.content)}"` };
      });

      await check(ModelFeatures.Pdf, 'one-line PDF', async () => {
        const res = await ask({
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'What number is written in this document? Answer with the number only.' },
              { type: 'file', base64: buildProbePdfBase64(), mimeType: 'application/pdf', filename: 'probe.pdf' },
            ],
          }],
        });
        return { ok: res.content.includes(PROBE_PDF_CODE), note: `replied "${short(res.content)}"` };
      });

      await check(ModelFeatures.StructuredOutput, 'JSON schema answer', async () => {
        const res = await ask({
          messages: [{ role: 'user', content: 'What is 2 + 3? Answer in the requested JSON format.' }],
          responseFormat: {
            type: 'json_schema',
            name: 'probe_answer',
            strict: true,
            schema: {
              type: 'object',
              properties: { answer: { type: 'integer' } },
              required: ['answer'],
              additionalProperties: false,
            },
          },
        });
        let parsed: unknown;
        try {
          parsed = JSON.parse(res.content);
        } catch {
          return { ok: false, note: 'the answer was not JSON' };
        }
        const ok = typeof parsed === 'object' && parsed !== null && (parsed as { answer?: unknown }).answer === 5;
        return { ok, note: ok ? 'valid JSON with the right answer' : 'JSON without the right answer' };
      });

      await check(ModelFeatures.ToolUse, 'one tool offer', async () => {
        const res = await ask({
          messages: [{ role: 'user', content: 'Call the probe_value tool.' }],
          tools: [{ name: 'probe_value', description: 'Returns a fixed probe value.', parameters: { type: 'object', properties: {} } }],
          toolChoice: { name: 'probe_value' },
        });
        const ok = (res.toolCalls ?? []).some((c) => c.name === 'probe_value');
        return { ok, note: ok ? 'called the tool' : 'did not call the tool' };
      });

      const sample = opts.audioSample;
      if (sample) {
        await check(ModelFeatures.AudioIn, 'host audio sample', async () => {
          const res = await ask({
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: 'Transcribe this audio.' },
                { type: 'audio', base64: sample.base64, mimeType: sample.mimeType },
              ],
            }],
          });
          const ok = res.content.toLowerCase().includes(sample.expectWord.toLowerCase());
          return { ok, note: ok ? 'the expected word was heard' : 'the expected word was not heard' };
        });
      }
    }
  }

  let embedding: ModelCapabilityProfile['embedding'];
  const embedder = opts.embedding;
  if (embedder && !skip.has(ModelFeatures.Embedding)) {
    const started = now();
    try {
      const res = await embedder.embed(ctx, { input: ['probe'] });
      const dims = res.embeddings[0]?.length ?? 0;
      const ok = dims > 0 && res.embeddings[0]!.every((n) => Number.isFinite(n));
      evidence.push({ feature: ModelFeatures.Embedding, ok, note: `one embedding: ${dims} numbers`, latencyMs: now() - started });
      if (ok) embedding = { dimensions: dims, inputs: ['text'] };
    } catch (err) {
      evidence.push({ feature: ModelFeatures.Embedding, ok: false, note: `one embedding: failed (${(err as { code?: string }).code ?? 'ERROR'})`, latencyMs: now() - started });
    }
  }

  const profile: ModelCapabilityProfile = {
    vision: results.get(ModelFeatures.Vision) ?? false,
    pdf: results.get(ModelFeatures.Pdf) ?? false,
    audioIn: results.get(ModelFeatures.AudioIn) ?? false,
    structuredOutput: results.get(ModelFeatures.StructuredOutput) ?? false,
    toolUse: results.get(ModelFeatures.ToolUse) ?? false,
    ...(chat?.info.maxContextTokens !== undefined ? { contextTokens: chat.info.maxContextTokens } : {}),
    ...(chat?.info.maxOutputTokens !== undefined ? { maxOutputTokens: chat.info.maxOutputTokens } : {}),
    ...(embedding ? { embedding } : {}),
    source: 'measured',
    measuredAt: new Date(now()).toISOString(),
    evidence,
  };
  return { profile, chatOk, evidence };
}
