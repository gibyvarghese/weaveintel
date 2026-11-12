import { describe, expect, it } from 'vitest';
import {
  ModelFeatures,
  UnsupportedContentError,
  asMultimodalEmbeddingModel,
  assertProfileSupports,
  capabilitiesFromProfile,
  featureForPart,
  isUnsupportedContentError,
  missingFeatures,
  profileFeatures,
  profileFromCapabilities,
  profileSupports,
  requiredFeatures,
  textOnlyProfile,
} from './model-profile.js';
import { Capabilities, createCapabilitySet } from './capabilities.js';
import { probeModelProfile, buildProbePdfBase64, PROBE_PDF_CODE } from './conformance-probe.js';
import { createExecutionContext } from './context.js';
import type { EmbeddingModel, Model, ModelRequest } from './models.js';
import { WeaveIntelError } from './errors.js';

const ctx = createExecutionContext({ tenantId: 't1' });

describe('features a request needs', () => {
  it('maps each part type and file type to one feature', () => {
    expect(featureForPart({ type: 'text', text: 'hi' })).toBeUndefined();
    expect(featureForPart({ type: 'image', base64: 'x' })).toBe('vision');
    expect(featureForPart({ type: 'audio', base64: 'x' })).toBe('audio_in');
    expect(featureForPart({ type: 'file', base64: 'x', mimeType: 'application/pdf' })).toBe('pdf');
    expect(featureForPart({ type: 'file', base64: 'x', mimeType: 'image/png' })).toBe('vision');
    expect(featureForPart({ type: 'file', base64: 'x', mimeType: 'Text/CSV; charset=utf-8' })).toBe('document:text/csv');
    expect(featureForPart({ type: 'file', base64: 'x' })).toBe('document:application/octet-stream');
    expect(featureForPart({ type: 'video', url: 'x' } as never)).toBe('document:x-unknown/video');
  });

  it('adds structured output and tools from the request', () => {
    const req: ModelRequest = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'file', base64: 'x', mimeType: 'application/pdf' }] },
      ],
      responseFormat: { type: 'json_schema', schema: { type: 'object' } },
      tools: [{ name: 't', description: 'd', parameters: {} }],
    };
    expect(requiredFeatures(req).sort()).toEqual(['pdf', 'structured_output', 'tools']);
  });
});

describe('profiles', () => {
  it('fails closed: a text-only profile lacks everything', () => {
    const p = textOnlyProfile();
    for (const f of ['vision', 'pdf', 'audio_in', 'structured_output', 'tools', 'document:text/csv']) {
      expect(profileSupports(p, f)).toBe(false);
    }
  });

  it('matches document types, with text/* wildcards', () => {
    const p = textOnlyProfile({ documentMimeTypes: ['text/*', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] });
    expect(profileSupports(p, 'document:text/csv')).toBe(true);
    expect(profileSupports(p, 'document:application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
    expect(profileSupports(p, 'document:application/zip')).toBe(false);
  });

  it('lists missing features', () => {
    const p = textOnlyProfile({ vision: true });
    const req: ModelRequest = {
      messages: [{ role: 'user', content: [{ type: 'image', base64: 'x' }, { type: 'audio', base64: 'y' }] }],
    };
    expect(missingFeatures(p, req)).toEqual(['audio_in']);
  });

  it('derives a profile from capability ids and never assumes PDF from vision', () => {
    const p = profileFromCapabilities([Capabilities.Vision, Capabilities.ToolCalling], { maxContextTokens: 1000 });
    expect(p).toMatchObject({ vision: true, pdf: false, toolUse: true, contextTokens: 1000, source: 'derived' });
    const back = capabilitiesFromProfile({ ...p, pdf: true });
    expect(back).toContain(Capabilities.PdfInput);
    expect(profileFeatures(p)).toEqual(['vision', 'tools']);
  });
});

describe('the typed refusal', () => {
  it('names the capability and is never retryable', () => {
    const p = textOnlyProfile();
    const req: ModelRequest = { messages: [{ role: 'user', content: [{ type: 'file', base64: 'x', mimeType: 'application/pdf' }] }] };
    let caught: unknown;
    try {
      assertProfileSupports(p, req, { provider: 'acme', modelId: 'm1' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedContentError);
    expect(caught).toBeInstanceOf(WeaveIntelError);
    const e = caught as UnsupportedContentError;
    expect(e.code).toBe('UNSUPPORTED_CONTENT');
    expect(e.capability).toBe('pdf');
    expect(e.retryable).toBe(false);
    expect(e.message).toBe('acme m1 cannot read PDF files; the content was not sent.');
    expect(isUnsupportedContentError(e)).toBe(true);
    expect(isUnsupportedContentError({ code: 'UNSUPPORTED_CONTENT', details: { capability: 'x' } })).toBe(true);
  });

  it('refuses a link where the profile needs bytes, and an unlisted image type', () => {
    const p = textOnlyProfile({ vision: true });
    expect(() => assertProfileSupports(p, { messages: [{ role: 'user', content: [{ type: 'image', url: 'https://x/y.png' }] }] }))
      .toThrow(/not a link/);
    expect(() => assertProfileSupports(p, { messages: [{ role: 'user', content: [{ type: 'image', base64: 'x', mimeType: 'image/tiff' }] }] }))
      .toThrow(/image\/tiff/);
    expect(() => assertProfileSupports(p, { messages: [{ role: 'user', content: [{ type: 'image' }] }] }))
      .toThrow(/neither content nor a link/);
  });
});

describe('multimodal embedding shape over a text model', () => {
  const textModel: EmbeddingModel = {
    info: { provider: 'stand-in', modelId: 'embed-3', capabilities: new Set([Capabilities.Embedding]) },
    ...createCapabilitySet(Capabilities.Embedding),
    async embed(_ctx, req) {
      return { embeddings: req.input.map((t) => [t.length, 1, 0]), model: 'embed-3', usage: { totalTokens: req.input.length } };
    },
  };

  it('carries model and dimensions on every vector', async () => {
    const m = asMultimodalEmbeddingModel(textModel);
    const res = await m.embedMultimodal(ctx, { inputs: [{ type: 'text', text: 'ab' }, { type: 'text', text: 'abc' }] });
    expect(res.dimensions).toBe(3);
    expect(res.results).toEqual([
      { vector: [2, 1, 0], inputType: 'text', model: 'embed-3', dimensions: 3 },
      { vector: [3, 1, 0], inputType: 'text', model: 'embed-3', dimensions: 3 },
    ]);
  });

  it('refuses an image instead of skipping it', async () => {
    const m = asMultimodalEmbeddingModel(textModel);
    await expect(m.embedMultimodal(ctx, { inputs: [{ type: 'text', text: 'a' }, { type: 'image', base64: 'x' }] }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT', capability: ModelFeatures.ImageEmbedding });
  });
});

describe('conformance probe', () => {
  function standIn(opts: { vision: boolean; pdf: boolean; schema: boolean; tools: boolean; refusePdf?: boolean }): Model {
    return {
      info: { provider: 'stand-in', modelId: 'probe-me', capabilities: new Set(), maxContextTokens: 8000 },
      ...createCapabilitySet(),
      async generate(_ctx, req) {
        const parts = req.messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content));
        const base = { id: 'r', finishReason: 'stop' as const, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'probe-me' };
        if (parts.some((p) => p.type === 'image')) return { ...base, content: opts.vision ? 'Red.' : 'I see nothing.' };
        if (parts.some((p) => p.type === 'file')) {
          if (opts.refusePdf) throw new UnsupportedContentError({ capability: 'pdf', provider: 'stand-in' });
          const file = parts.find((p) => p.type === 'file') as { base64: string };
          const text = atob(file.base64);
          return { ...base, content: opts.pdf && text.includes(PROBE_PDF_CODE) ? PROBE_PDF_CODE : '?' };
        }
        if (req.responseFormat) return { ...base, content: opts.schema ? '{"answer":5}' : 'five' };
        if (req.tools?.length) return opts.tools
          ? { ...base, content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'probe_value', arguments: '{}' }] }
          : { ...base, content: 'no' };
        return { ...base, content: 'PONG' };
      },
    };
  }

  it('measures each feature independently', async () => {
    let t = 1_000;
    const res = await probeModelProfile(ctx, { chat: standIn({ vision: true, pdf: false, schema: true, tools: false }), now: () => (t += 5) });
    expect(res.chatOk).toBe(true);
    expect(res.profile).toMatchObject({ vision: true, pdf: false, structuredOutput: true, toolUse: false, audioIn: false, contextTokens: 8000, source: 'measured' });
    expect(res.evidence.map((e) => [e.feature, e.ok])).toEqual([
      ['chat', true], ['vision', true], ['pdf', false], ['structured_output', true], ['tools', false],
    ]);
  });

  it('counts an adapter refusal as unsupported and keeps going', async () => {
    const res = await probeModelProfile(ctx, { chat: standIn({ vision: false, pdf: true, schema: false, tools: true, refusePdf: true }) });
    expect(res.profile.pdf).toBe(false);
    expect(res.profile.toolUse).toBe(true);
    expect(res.evidence.find((e) => e.feature === 'pdf')?.note).toMatch(/refused by the adapter/);
  });

  it('measures embedding dimensions', async () => {
    const embedder: EmbeddingModel = {
      info: { provider: 's', modelId: 'e', capabilities: new Set() },
      ...createCapabilitySet(),
      async embed() { return { embeddings: [[0.1, 0.2, 0.3, 0.4]], model: 'e', usage: { totalTokens: 1 } }; },
    };
    const res = await probeModelProfile(ctx, { embedding: embedder });
    expect(res.profile.embedding).toEqual({ dimensions: 4, inputs: ['text'] });
  });

  it('builds a valid one-page PDF with the probe code', () => {
    const pdf = atob(buildProbePdfBase64());
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain(`(Probe code ${PROBE_PDF_CODE}) Tj`);
    const xref = Number(pdf.match(/startxref\n(\d+)/)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
  });
});
