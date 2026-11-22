// SPDX-License-Identifier: MIT
/**
 * Routing on what a model can READ: a request carrying a PDF, an image, audio
 * or a CSV skips every model that cannot read it, before any call is made.
 */
import { describe, expect, it } from 'vitest';
import { UnsupportedContentError, textOnlyProfile, type ModelRequest } from '@weaveintel/core';
import { createRuleRouter, needsForRequest } from './rule-router.js';
import type { RouteRule, RouteTarget } from './rule-router.js';
import { SmartModelRouter } from './router.js';

const pdfRequest: ModelRequest = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarise' }, { type: 'file', base64: 'JVBERi0=', mimeType: 'application/pdf' }] }],
};
const csvRequest: ModelRequest = {
  messages: [{ role: 'user', content: [{ type: 'file', base64: 'YSxi', mimeType: 'text/csv' }] }],
};

const textOnly: RouteTarget = { key: 'cheap', providerId: 'groq', modelId: 'llama', kind: 'chat', enabled: true, capabilities: ['tools'] };
const reader: RouteTarget = {
  key: 'reader', providerId: 'anthropic', modelId: 'claude', kind: 'chat', enabled: true,
  profile: textOnlyProfile({ vision: true, pdf: true, toolUse: true, documentMimeTypes: ['text/*'], contextTokens: 200_000, source: 'measured' }),
};
const listedPdf: RouteTarget = { key: 'listed', providerId: 'bedrock', modelId: 'nova', kind: 'chat', enabled: true, capabilities: ['pdf', 'document:text/*'] };
const rule: RouteRule = {
  key: 'chat', purpose: 'chat',
  steps: [{ targetKey: 'cheap', order: 1 }, { targetKey: 'listed', order: 2 }, { targetKey: 'reader', order: 3 }],
};

describe('rule router: required input capabilities', () => {
  it('works out what a request needs from its content', () => {
    expect(needsForRequest(pdfRequest)).toEqual({ capabilities: ['pdf'] });
    expect(needsForRequest({ ...csvRequest, responseFormat: { type: 'json_object' } }, { capabilities: ['tools'], minContextTokens: 10 }))
      .toEqual({ capabilities: ['document:text/csv', 'structured_output', 'tools'], minContextTokens: 10 });
  });

  it('skips a model that cannot read a PDF and says so in plain words', () => {
    const router = createRuleRouter({ targets: [textOnly, listedPdf, reader], rules: [rule] });
    const plan = router.plan({ purpose: 'chat', needs: needsForRequest(pdfRequest) });
    expect(plan.order).toEqual(['listed', 'reader']);
    const cheap = plan.candidates.find((c) => c.targetKey === 'cheap')!;
    expect(cheap).toMatchObject({ eligible: false, dropped: 'missing_capability', detail: 'missing capability: pdf' });
    expect(plan.explanation).toMatch(/Skipped groq llama \(does not support PDF files\)/);
  });

  it('matches a document type by wildcard, from capabilities or from the profile', () => {
    const router = createRuleRouter({ targets: [textOnly, listedPdf, reader], rules: [rule] });
    expect(router.plan({ purpose: 'chat', needs: needsForRequest(csvRequest) }).order).toEqual(['listed', 'reader']);
  });

  it('uses the profile for vision and context size', () => {
    const imageRequest: ModelRequest = { messages: [{ role: 'user', content: [{ type: 'image', base64: 'x' }] }] };
    const router = createRuleRouter({ targets: [textOnly, listedPdf, reader], rules: [rule] });
    expect(router.plan({ purpose: 'chat', needs: needsForRequest(imageRequest, { minContextTokens: 150_000 }) }).order).toEqual(['reader']);
  });

  it('fails before any call when no model can read the content', async () => {
    const router = createRuleRouter({ targets: [textOnly], rules: [{ key: 'c', purpose: 'chat', steps: [{ targetKey: 'cheap', order: 1 }] }] });
    let called = false;
    await expect(router.run({ purpose: 'chat', needs: needsForRequest(pdfRequest) }, async () => { called = true; return 'x'; }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(called).toBe(false);
  });
});

describe('smart router: profiles count as capabilities', () => {
  const policy = {
    id: 'p', name: 'p', strategy: 'balanced' as const, enabled: true,
    fallbackModelId: 'llama', fallbackProviderId: 'groq',
  };

  it('filters on required input features using profiles', async () => {
    const router = new SmartModelRouter({
      candidates: [{ modelId: 'llama', providerId: 'groq', capabilities: ['tools'] }, { modelId: 'claude', providerId: 'anthropic' }],
      profiles: new Map([['anthropic:claude', textOnlyProfile({ pdf: true, documentMimeTypes: ['text/*'] })]]),
    });
    const d = await router.route({ prompt: 'x', context: { requiredCapabilities: needsForRequest(csvRequest).capabilities as string[] } }, policy);
    expect(d.modelId).toBe('claude');
  });

  it('never falls back to a model that cannot read the content', async () => {
    const router = new SmartModelRouter({ candidates: [{ modelId: 'llama', providerId: 'groq', capabilities: ['tools'] }] });
    await expect(router.route({ prompt: 'x', context: { requiredCapabilities: ['pdf'] } }, policy)).rejects.toBeInstanceOf(UnsupportedContentError);
  });
});
