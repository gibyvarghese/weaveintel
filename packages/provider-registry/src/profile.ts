// SPDX-License-Identifier: MIT
/**
 * A model row's capability profile.
 *
 * In plain terms: a model row says what it can do in its `capabilities` list,
 * using short names (`vision`, `pdf`, `audio_in`, `tools`, `structured_output`,
 * and `document:<mime type>` for each other file type it reads natively). This
 * turns that list into the shared `ModelCapabilityProfile` from core, so
 * routers and adapters judge content the same way. Anything not listed is not
 * supported: profiles fail closed.
 */

import type { ModelCapabilityProfile } from '@weaveintel/core';
import type { ModelDescription } from './types.js';

export function profileOfModel(model: ModelDescription): ModelCapabilityProfile {
  const caps = new Set(model.capabilities ?? []);
  const documentMimeTypes = [...caps].filter((c) => c.startsWith('document:')).map((c) => c.slice('document:'.length));
  return {
    vision: caps.has('vision'),
    pdf: caps.has('pdf'),
    audioIn: caps.has('audio_in'),
    structuredOutput: caps.has('structured_output'),
    toolUse: caps.has('tools'),
    ...(documentMimeTypes.length > 0 ? { documentMimeTypes } : {}),
    ...(model.maxContextTokens !== undefined ? { contextTokens: model.maxContextTokens } : {}),
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(model.kind === 'embedding' && model.embedding
      ? { embedding: { dimensions: model.embedding.nativeDimensions, inputs: ['text'] as const } }
      : {}),
    source: 'declared',
  };
}
