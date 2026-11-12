// SPDX-License-Identifier: MIT
/**
 * Deterministic stand-in engines for tests. No network, no model, no keys.
 * Exported so host applications (geniWeave) test their wiring the same way.
 */

import type { ExecutionContext, Model, ModelRequest, ModelResponse } from '@weaveintel/core';
import { Capabilities, weaveCapabilities } from '@weaveintel/core';
import type { Embedder, Ocr, SpeechToText, VisionReader } from './ports.js';
import type { DocumentPage, TranscriptSegment } from './types.js';
import { contentHash } from './cache.js';

export interface StandInModel extends Model {
  /** Every request received, in order (to assert, e.g., that no tools were offered). */
  readonly requests: ModelRequest[];
}

/**
 * A chat model that answers with whatever `reply` returns for each request.
 * Declares vision, PDF input and structured output unless told otherwise.
 */
export function createStandInModel(
  reply: (request: ModelRequest) => string | Partial<ModelResponse>,
  opts: { modelId?: string; capabilities?: readonly string[] } = {},
): StandInModel {
  const caps = (opts.capabilities ?? [Capabilities.Chat, Capabilities.Vision, Capabilities.PdfInput, Capabilities.StructuredOutput]) as Parameters<typeof weaveCapabilities>;
  const set = weaveCapabilities(...caps);
  const requests: ModelRequest[] = [];
  const modelId = opts.modelId ?? 'stand-in-model';
  return {
    info: { provider: 'stand-in', modelId, capabilities: set.capabilities },
    ...set,
    requests,
    async generate(_ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      requests.push(request);
      const r = reply(request);
      const base: ModelResponse = { id: `r${requests.length}`, content: '', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, model: modelId };
      return typeof r === 'string' ? { ...base, content: r } : { ...base, ...r };
    },
  };
}

/** The text of every user message in a request (what the model was shown). */
export function requestText(request: ModelRequest): string {
  return request.messages
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n')))
    .join('\n');
}

/**
 * A deterministic embedder: hashed character trigrams and words into a fixed
 * number of dimensions, unit length. Similar texts get similar vectors, so
 * mapping tests are meaningful without a model.
 */
export function createStandInEmbedder(opts: { dimensions?: number; model?: string } = {}): Embedder & { calls: number } {
  const dims = opts.dimensions ?? 256;
  const model = opts.model ?? 'stand-in-embedding';
  const hash = (s: string): number => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0) % dims;
  };
  const self = {
    id: 'stand-in-embedder',
    calls: 0,
    async embed(texts: readonly string[]) {
      self.calls += 1;
      const vectors = texts.map((t) => {
        const v = new Array<number>(dims).fill(0);
        const s = ` ${t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
        for (let i = 0; i + 3 <= s.length; i++) v[hash(s.slice(i, i + 3))]! += 1;
        for (const w of s.trim().split(' ')) if (w) v[hash(`w:${w}`)]! += 2;
        const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
        return v.map((x) => x / n);
      });
      return { vectors, model, dimensions: dims };
    },
  };
  return self;
}

/** OCR that returns fixed pages per file (by SHA-256 of the bytes), or the same pages for anything. */
export function createStandInOcr(pages: readonly DocumentPage[] | ((hash: string) => readonly DocumentPage[]), accepts: (m: string) => boolean = () => true): Ocr {
  return {
    id: 'stand-in-ocr',
    version: '1',
    accepts,
    async read(file) {
      const p = typeof pages === 'function' ? pages(contentHash(file.bytes)) : pages;
      return { pages: p.map((x) => ({ ...x, source: 'ocr' as const })), provenance: { step: 'ocr', engine: 'stand-in-ocr', version: '1', region: 'in-process' } };
    },
  };
}

export function createStandInVision(text: string): VisionReader {
  return {
    id: 'stand-in-vision',
    async read() {
      return { text, provenance: { step: 'vision', engine: 'stand-in-vision', version: '1', region: 'in-process' } };
    },
  };
}

export function createStandInSpeech(segments: readonly TranscriptSegment[], language = 'en'): SpeechToText {
  return {
    id: 'stand-in-speech',
    async transcribe() {
      return { text: segments.map((s) => s.text).join(' '), segments, language, provenance: { step: 'transcribe', engine: 'stand-in-speech', version: '1', region: 'in-process' } };
    },
  };
}
