// SPDX-License-Identifier: MIT
/**
 * @weaveintel/core — Model capability profiles
 *
 * In plain words
 * --------------
 * A model (or a connection to one) can read some kinds of content and not
 * others. One reads images and PDFs, another only text; one can be forced to
 * answer in a JSON schema, another cannot. A CAPABILITY PROFILE writes that
 * down as plain data, so:
 *
 *   - a router can skip a model that cannot read what the request carries
 *     (`requiredFeatures` + `missingFeatures`);
 *   - an adapter can refuse, with a typed error that names the capability,
 *     instead of quietly replacing a file with placeholder text
 *     (`UnsupportedContentError`);
 *   - a conformance probe can MEASURE the profile of a real endpoint
 *     (`probeModelProfile` in `conformance-probe.ts`).
 *
 * Features are short strings, the same vocabulary the rule router already uses
 * for its `capabilities` lists: `vision`, `pdf`, `audio_in`, `structured_output`,
 * `tools`, and `document:<mime type>` for any other file type.
 */

import type { CapabilityId } from './capabilities.js';
import { Capabilities } from './capabilities.js';
import { WeaveIntelError } from './errors.js';
import type { ExecutionContext } from './context.js';
import type {
  ContentPart,
  EmbeddingModel,
  EmbeddingVector,
  ModelInfo,
  ModelRequest,
  MultimodalEmbeddingModel,
  MultimodalEmbeddingRequest,
  MultimodalEmbeddingResponse,
} from './models.js';

// ─── Feature vocabulary ──────────────────────────────────────

export const ModelFeatures = {
  /** Reads images. */
  Vision: 'vision',
  /** Reads PDF files natively. */
  Pdf: 'pdf',
  /** Reads audio inside a chat request. */
  AudioIn: 'audio_in',
  /** Can be forced to answer in a JSON schema. */
  StructuredOutput: 'structured_output',
  /** Can call tools. */
  ToolUse: 'tools',
  /** Embeds text. */
  Embedding: 'embedding',
  /** Embeds images into the same space as text. */
  ImageEmbedding: 'image_embedding',
} as const;

export type ModelFeature = (typeof ModelFeatures)[keyof typeof ModelFeatures] | `document:${string}`;

/** The feature a non-PDF, non-image, non-audio file of this type needs. */
export function documentFeature(mimeType: string): `document:${string}` {
  return `document:${normaliseMime(mimeType)}`;
}

function normaliseMime(mimeType: string | undefined): string {
  return (mimeType ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase() || 'application/octet-stream';
}

// ─── The profile ─────────────────────────────────────────────

/** One observation made by a conformance probe. */
export interface ProbeEvidence {
  /** The feature checked, or `chat` for the plain round trip every other check depends on. */
  readonly feature: ModelFeature | 'chat';
  readonly ok: boolean;
  /** One plain sentence: what was sent and what came back (never a secret, never the whole reply). */
  readonly note: string;
  readonly latencyMs?: number;
}

/**
 * What a model or connection can do, as data. Safe to store as a row and to log.
 * `false` and "absent" both mean "not supported": profiles fail closed.
 */
export interface ModelCapabilityProfile {
  readonly vision: boolean;
  readonly pdf: boolean;
  readonly audioIn: boolean;
  /**
   * Other file types read natively, as MIME types. `text/*` matches any text
   * type. Example for Bedrock Converse: csv, doc, docx, xls, xlsx, html, txt, md.
   */
  readonly documentMimeTypes?: readonly string[];
  /** Image types accepted. Absent = the common four (png, jpeg, gif, webp). */
  readonly imageMimeTypes?: readonly string[];
  /** Audio types accepted. Absent = any the adapter knows how to label. */
  readonly audioMimeTypes?: readonly string[];
  /** Whether a part may be a link (URL) rather than the bytes themselves. Default false. */
  readonly acceptsUrls?: boolean;
  readonly structuredOutput: boolean;
  readonly toolUse: boolean;
  readonly contextTokens?: number;
  readonly maxOutputTokens?: number;
  /** Present for embedding models. */
  readonly embedding?: {
    readonly dimensions: number;
    readonly inputs: readonly ('text' | 'image')[];
  };
  /** Written by a person or a seed (`declared`), worked out from capability ids (`derived`), or measured by a probe. */
  readonly source: 'declared' | 'derived' | 'measured';
  /** ISO time of the measurement, for `measured`. */
  readonly measuredAt?: string;
  readonly evidence?: readonly ProbeEvidence[];
}

const DEFAULT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** A profile that can do nothing but read and write text. The starting point for anything unknown. */
export function textOnlyProfile(overrides?: Partial<ModelCapabilityProfile>): ModelCapabilityProfile {
  return {
    vision: false,
    pdf: false,
    audioIn: false,
    structuredOutput: false,
    toolUse: false,
    source: 'declared',
    ...overrides,
  };
}

// ─── What a request needs ────────────────────────────────────

/** The feature one content part needs, or `undefined` for plain text. */
export function featureForPart(part: ContentPart): ModelFeature | undefined {
  switch (part.type) {
    case 'text':
      return undefined;
    case 'image':
      return ModelFeatures.Vision;
    case 'audio':
      return ModelFeatures.AudioIn;
    case 'file': {
      const mime = normaliseMime(part.mimeType);
      if (mime === 'application/pdf') return ModelFeatures.Pdf;
      if (mime.startsWith('image/')) return ModelFeatures.Vision;
      if (mime.startsWith('audio/')) return ModelFeatures.AudioIn;
      return documentFeature(mime);
    }
    default:
      // A part type this version of the library does not know. It is never
      // silently dropped: it needs a feature no profile declares.
      return documentFeature(`x-unknown/${(part as { type: string }).type}`);
  }
}

/**
 * Every feature a request needs: one per kind of content it carries, plus
 * `structured_output` when it asks for a JSON answer and `tools` when it offers tools.
 */
export function requiredFeatures(
  request: Pick<ModelRequest, 'messages'> & Partial<Pick<ModelRequest, 'tools' | 'responseFormat'>>,
): ModelFeature[] {
  const out = new Set<ModelFeature>();
  for (const msg of request.messages) {
    if (typeof msg.content === 'string') continue;
    for (const part of msg.content) {
      const f = featureForPart(part);
      if (f) out.add(f);
    }
  }
  if (request.responseFormat) out.add(ModelFeatures.StructuredOutput);
  if (request.tools && request.tools.length > 0) out.add(ModelFeatures.ToolUse);
  return [...out];
}

function mimeMatches(list: readonly string[], mime: string): boolean {
  return list.some((entry) => {
    const e = normaliseMime(entry);
    if (e.endsWith('/*')) return mime.startsWith(e.slice(0, -1));
    return e === mime;
  });
}

/** Whether the profile has one feature. `document:<mime>` is checked against `documentMimeTypes`. */
export function profileSupports(profile: ModelCapabilityProfile, feature: ModelFeature | string): boolean {
  switch (feature) {
    case ModelFeatures.Vision:
      return profile.vision;
    case ModelFeatures.Pdf:
      return profile.pdf;
    case ModelFeatures.AudioIn:
      return profile.audioIn;
    case ModelFeatures.StructuredOutput:
      return profile.structuredOutput;
    case ModelFeatures.ToolUse:
      return profile.toolUse;
    case ModelFeatures.Embedding:
      return profile.embedding?.inputs.includes('text') ?? false;
    case ModelFeatures.ImageEmbedding:
      return profile.embedding?.inputs.includes('image') ?? false;
    default:
      if (feature.startsWith('document:')) {
        return mimeMatches(profile.documentMimeTypes ?? [], feature.slice('document:'.length));
      }
      return false;
  }
}

/** The features a request needs that the profile lacks. Empty = the profile can serve it. */
export function missingFeatures(
  profile: ModelCapabilityProfile,
  request: Pick<ModelRequest, 'messages'> & Partial<Pick<ModelRequest, 'tools' | 'responseFormat'>>,
): ModelFeature[] {
  return requiredFeatures(request).filter((f) => !profileSupports(profile, f));
}

/**
 * The profile's features as a flat list, for a router's `capabilities` field.
 * Document types are listed as `document:<mime>`.
 */
export function profileFeatures(profile: ModelCapabilityProfile): string[] {
  const out: string[] = [];
  if (profile.vision) out.push(ModelFeatures.Vision);
  if (profile.pdf) out.push(ModelFeatures.Pdf);
  if (profile.audioIn) out.push(ModelFeatures.AudioIn);
  if (profile.structuredOutput) out.push(ModelFeatures.StructuredOutput);
  if (profile.toolUse) out.push(ModelFeatures.ToolUse);
  if (profile.embedding?.inputs.includes('text')) out.push(ModelFeatures.Embedding);
  if (profile.embedding?.inputs.includes('image')) out.push(ModelFeatures.ImageEmbedding);
  for (const mime of profile.documentMimeTypes ?? []) out.push(documentFeature(mime));
  return out;
}

/** A sentence fragment for a person: "read PDF files", "read text/csv files". */
export function featureLabel(feature: ModelFeature | string): string {
  switch (feature) {
    case ModelFeatures.Vision:
      return 'read images';
    case ModelFeatures.Pdf:
      return 'read PDF files';
    case ModelFeatures.AudioIn:
      return 'read audio';
    case ModelFeatures.StructuredOutput:
      return 'answer in a fixed JSON schema';
    case ModelFeatures.ToolUse:
      return 'call tools';
    case ModelFeatures.Embedding:
      return 'embed text';
    case ModelFeatures.ImageEmbedding:
      return 'embed images';
    default:
      return feature.startsWith('document:') ? `read ${feature.slice('document:'.length)} files` : feature;
  }
}

// ─── Capability ids ↔ profile ────────────────────────────────

/**
 * Work a profile out of `Capabilities.*` ids (what providers already declare).
 * PDF, audio and document input are only true when declared explicitly: a
 * model that "has vision" is not assumed to read PDFs.
 */
export function profileFromCapabilities(
  capabilities: Iterable<string>,
  info?: Pick<ModelInfo, 'maxContextTokens' | 'maxOutputTokens'>,
  extra?: Pick<ModelCapabilityProfile, 'documentMimeTypes' | 'imageMimeTypes' | 'audioMimeTypes' | 'acceptsUrls' | 'embedding'>,
): ModelCapabilityProfile {
  const set = new Set<string>(capabilities);
  return {
    vision: set.has(Capabilities.Vision),
    pdf: set.has(Capabilities.PdfInput),
    audioIn: set.has(Capabilities.AudioInput),
    structuredOutput: set.has(Capabilities.StructuredOutput),
    toolUse: set.has(Capabilities.ToolCalling),
    ...(info?.maxContextTokens !== undefined ? { contextTokens: info.maxContextTokens } : {}),
    ...(info?.maxOutputTokens !== undefined ? { maxOutputTokens: info.maxOutputTokens } : {}),
    ...(set.has(Capabilities.DocumentInput) && extra?.documentMimeTypes ? { documentMimeTypes: extra.documentMimeTypes } : {}),
    ...(extra?.imageMimeTypes ? { imageMimeTypes: extra.imageMimeTypes } : {}),
    ...(extra?.audioMimeTypes ? { audioMimeTypes: extra.audioMimeTypes } : {}),
    ...(extra?.acceptsUrls !== undefined ? { acceptsUrls: extra.acceptsUrls } : {}),
    ...(extra?.embedding ? { embedding: extra.embedding } : {}),
    source: 'derived',
  };
}

/** The `Capabilities.*` ids a profile implies. */
export function capabilitiesFromProfile(profile: ModelCapabilityProfile): CapabilityId[] {
  const out: CapabilityId[] = [];
  if (profile.vision) out.push(Capabilities.Vision);
  if (profile.pdf) out.push(Capabilities.PdfInput);
  if (profile.audioIn) out.push(Capabilities.AudioInput);
  if ((profile.documentMimeTypes ?? []).length > 0) out.push(Capabilities.DocumentInput);
  if (profile.structuredOutput) out.push(Capabilities.StructuredOutput);
  if (profile.toolUse) out.push(Capabilities.ToolCalling);
  if (profile.embedding) out.push(Capabilities.Embedding);
  if (profile.embedding?.inputs.includes('image')) out.push(Capabilities.ImageEmbedding);
  return out;
}

// ─── The typed refusal ───────────────────────────────────────

/**
 * Thrown when content cannot be sent to a model or connection. It always names
 * the missing capability, so nothing is ever quietly dropped or replaced with
 * placeholder text. Code `UNSUPPORTED_CONTENT`, never retryable on the same target.
 */
export class UnsupportedContentError extends WeaveIntelError {
  /** The missing feature, e.g. `pdf`, `audio_in`, `document:text/csv`. */
  readonly capability: string;
  readonly partType?: string;
  readonly mimeType?: string;
  readonly modelId?: string;

  constructor(opts: {
    capability: string;
    provider?: string;
    modelId?: string;
    partType?: string;
    mimeType?: string;
    /** Why, in a few words, when it is not just "the model cannot". E.g. "needs the bytes, not a link". */
    reason?: string;
    message?: string;
  }) {
    const who = [opts.provider, opts.modelId].filter(Boolean).join(' ') || 'This model';
    const message =
      opts.message ??
      `${who} cannot ${featureLabel(opts.capability)}${opts.reason ? ` (${opts.reason})` : ''}; the content was not sent.`;
    super({
      code: 'UNSUPPORTED_CONTENT',
      message,
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      retryable: false,
      details: {
        capability: opts.capability,
        ...(opts.partType !== undefined ? { partType: opts.partType } : {}),
        ...(opts.mimeType !== undefined ? { mimeType: opts.mimeType } : {}),
        ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      },
    });
    this.name = 'UnsupportedContentError';
    this.capability = opts.capability;
    if (opts.partType !== undefined) this.partType = opts.partType;
    if (opts.mimeType !== undefined) this.mimeType = opts.mimeType;
    if (opts.modelId !== undefined) this.modelId = opts.modelId;
  }
}

/** True for an `UnsupportedContentError`, including one from another copy of this package. */
export function isUnsupportedContentError(err: unknown): err is WeaveIntelError & { details: { capability: string } } {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'UNSUPPORTED_CONTENT'
  );
}

/** An `UnsupportedContentError` for one content part. */
export function unsupportedPart(
  part: ContentPart,
  opts: { provider?: string; modelId?: string; reason?: string; capability?: string },
): UnsupportedContentError {
  const capability = opts.capability ?? featureForPart(part) ?? 'text';
  const mimeType = 'mimeType' in part ? part.mimeType : undefined;
  return new UnsupportedContentError({
    capability,
    partType: part.type,
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
  });
}

/**
 * Refuse a request the profile cannot serve, naming the first missing feature
 * (all of them are in `details.missing`). Also refuses a link where the profile
 * needs bytes, and an image type the profile does not list.
 */
export function assertProfileSupports(
  profile: ModelCapabilityProfile,
  request: Pick<ModelRequest, 'messages'> & Partial<Pick<ModelRequest, 'tools' | 'responseFormat'>>,
  who?: { provider?: string; modelId?: string },
): void {
  const missing = missingFeatures(profile, request);
  if (missing.length > 0) {
    const err = new UnsupportedContentError({
      capability: missing[0]!,
      ...(who?.provider !== undefined ? { provider: who.provider } : {}),
      ...(who?.modelId !== undefined ? { modelId: who.modelId } : {}),
    });
    (err.details as Record<string, unknown>)['missing'] = missing;
    throw err;
  }
  for (const msg of request.messages) {
    if (typeof msg.content === 'string') continue;
    for (const part of msg.content) {
      if (part.type === 'text') continue;
      const hasBytes = typeof part.base64 === 'string' && part.base64.length > 0;
      if (!hasBytes && part.url && !profile.acceptsUrls) {
        throw unsupportedPart(part, { ...who, reason: 'it needs the content itself, not a link to it' });
      }
      if (!hasBytes && !part.url) {
        throw new WeaveIntelError({
          code: 'INVALID_INPUT',
          message: `A ${part.type} part has neither content nor a link.`,
          ...(who?.provider !== undefined ? { provider: who.provider } : {}),
          retryable: false,
        });
      }
      const isImage = part.type === 'image' || (part.type === 'file' && normaliseMime(part.mimeType).startsWith('image/'));
      if (isImage) {
        const allowed = profile.imageMimeTypes ?? DEFAULT_IMAGE_TYPES;
        const mime = normaliseMime(part.mimeType ?? 'image/png');
        if (!mimeMatches(allowed, mime)) {
          throw unsupportedPart(part, { ...who, reason: `images of type ${mime} are not accepted` });
        }
      }
      if (part.type === 'audio' && profile.audioMimeTypes && !mimeMatches(profile.audioMimeTypes, normaliseMime(part.mimeType ?? 'audio/wav'))) {
        throw unsupportedPart(part, { ...who, reason: `audio of type ${normaliseMime(part.mimeType)} is not accepted` });
      }
    }
  }
}

// ─── Embeddings: text models behind the multimodal shape ─────

/**
 * Put a text-only embedding model behind the multimodal shape. Text inputs are
 * embedded; an image input is refused with `UnsupportedContentError`
 * (`image_embedding`), never skipped. Every vector carries model and size.
 */
export function asMultimodalEmbeddingModel(model: EmbeddingModel): MultimodalEmbeddingModel {
  return {
    info: model.info,
    capabilities: model.capabilities,
    hasCapability: (id) => model.hasCapability(id),
    async embedMultimodal(ctx: ExecutionContext, request: MultimodalEmbeddingRequest): Promise<MultimodalEmbeddingResponse> {
      const texts: string[] = [];
      for (const input of request.inputs) {
        if (input.type !== 'text') {
          throw new UnsupportedContentError({
            capability: ModelFeatures.ImageEmbedding,
            provider: model.info.provider,
            modelId: model.info.modelId,
            partType: input.type,
            ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
          });
        }
        texts.push(input.text);
      }
      const res = await model.embed(ctx, {
        input: texts,
        ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
      });
      const dims = res.dimensions ?? res.embeddings[0]?.length ?? 0;
      const results: EmbeddingVector[] = res.embeddings.map((vector) => {
        if (vector.length !== dims) {
          throw new WeaveIntelError({
            code: 'PROVIDER_ERROR',
            message: `${res.model} returned vectors of different sizes (${dims} and ${vector.length}).`,
            provider: model.info.provider,
          });
        }
        return { vector, inputType: 'text', model: res.model, dimensions: dims };
      });
      return { results, model: res.model, dimensions: dims, usage: res.usage };
    },
  };
}
