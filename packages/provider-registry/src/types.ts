// SPDX-License-Identifier: MIT
/**
 * Contracts for model providers described as data.
 *
 * In plain terms: a provider (a company or server that runs AI models) is
 * written down as a small record — which wire format it speaks, where it lives,
 * and the NAMES of the keys it needs. The keys themselves are never part of the
 * record; they are fetched from a secret store at the moment of each call.
 *
 * Nothing here talks to the network. The registry (`registry.ts`) turns these
 * records into working models; adapters (`adapters/*`) translate one wire format.
 */

import type {
  EmbeddingModel,
  EmbeddingRequest,
  EmbeddingResponse,
  ExecutionContext,
  ModelRequest,
  ModelResponse,
  StreamChunk,
} from '@weaveintel/core';

// ─── Provider as data ────────────────────────────────────────

/**
 * How an OpenAI-compatible server differs from OpenAI. Every difference is a
 * value here, so supporting a new server is a row of data, never a code branch.
 */
export interface WireQuirks {
  /** Name of the output-token limit parameter. Default `max_completion_tokens`. */
  readonly tokenLimitParam?: 'max_tokens' | 'max_completion_tokens';
  /** Whether the server accepts `stream_options: { include_usage: true }`. Default true. */
  readonly streamUsage?: boolean;
  /** Whether tools can be sent at all. Default true. */
  readonly tools?: boolean;
  /** Whether `tool_choice` is accepted. Default true. */
  readonly toolChoice?: boolean;
  /** Whether `response_format` is accepted. Default true. */
  readonly responseFormat?: boolean;
  /**
   * How an embedding size is requested: the OpenAI `dimensions` parameter,
   * Mistral's `output_dimension`, or not at all. Default `dimensions`.
   */
  readonly embeddingSizeParam?: 'dimensions' | 'output_dimension' | 'none';
  /**
   * How the key is presented. `bearer` = `Authorization: Bearer <key>`;
   * `api-key` = an `api-key` header (Azure); `none` = no key (a local server).
   * Default `bearer`.
   */
  readonly auth?: 'bearer' | 'api-key' | 'none';
  /** Whether the model id is sent in the request body. Default true. */
  readonly modelInBody?: boolean;
  /** Path template for chat. `{model}` is replaced (URL-encoded). Default `/chat/completions`. */
  readonly chatPath?: string;
  /** Path template for embeddings. Default `/embeddings`. */
  readonly embeddingsPath?: string;
  /** Path for listing models. Empty string = the server cannot list. Default `/models`. */
  readonly modelsPath?: string;
  /** A cheap GET that proves the server answers, for servers that cannot list models. */
  readonly probePath?: string;
  /** Whether the server reports token usage for embeddings. Default true. */
  readonly embeddingUsage?: boolean;
  /** Whether embeddings accept the `input_type` (document / query) field. Default false. */
  readonly embeddingInputType?: boolean;
}

/** A provider, written down as plain data. Safe to log: it holds no secret. */
export interface ProviderDescription {
  /** The host's stable id for this provider (a row key). Used for resilience state and provenance. */
  readonly id: string;
  /** Which adapter speaks to it, e.g. `openai-compatible`, `azure-openai`, `bedrock`. */
  readonly kind: string;
  /** A name a person would recognise. */
  readonly displayName?: string;
  /** Where the provider lives. Adapters with a fixed public endpoint make this optional. */
  readonly baseUrl?: string;
  /** Region or location (an AWS region, a Vertex location). Also used by data-residency rules. */
  readonly region?: string;
  /** Plain adapter settings: API version, project id, and the like. Never a secret. */
  readonly settings?: Readonly<Record<string, string>>;
  /** Extra headers sent with every request. Never a secret. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Slot name → the reference the host's secret resolver understands. For
   * example `{ apiKey: 'vault:prov-17:apiKey' }`. The VALUE is fetched per call.
   */
  readonly secrets?: Readonly<Record<string, string>>;
  /** Wire differences for the OpenAI-compatible family. */
  readonly quirks?: WireQuirks;
  /** Per-request timeout. Default 60 s. */
  readonly timeoutMs?: number;
}

/** What an embedding model can do, as data. */
export interface EmbeddingModelDescriptor {
  /** The size of vector the model produces when not asked for another. */
  readonly nativeDimensions: number;
  /** Every size it can be asked for. Includes the native size. */
  readonly dimensions: readonly number[];
  /**
   * How a smaller size is obtained: the provider does it (`provider`), the
   * caller may keep the first N numbers and re-normalise (`truncate`, valid for
   * models trained for it), or it cannot be done (`none`).
   */
  readonly reduce: 'provider' | 'truncate' | 'none';
  /** Whether vectors arrive with unit length. When false the registry normalises them. */
  readonly normalized: boolean;
  /** Longest input, in tokens. */
  readonly maxInputTokens?: number;
  /** Most inputs per request. The registry splits larger calls. */
  readonly batchLimit?: number;
  /** Whether the model distinguishes text being stored from a search question. */
  readonly modes: readonly EmbeddingMode[];
}

/** Whether a text is being stored (`document`) or is a search question (`query`). */
export type EmbeddingMode = 'document' | 'query';

/** A model at a provider, as data. */
export interface ModelDescription {
  /** The provider-side id: a model name, an Azure deployment, a serving endpoint. */
  readonly id: string;
  readonly kind: 'chat' | 'embedding';
  /** Capability ids from `@weaveintel/core` (`Capabilities.*`). Defaults per kind. */
  readonly capabilities?: readonly string[];
  readonly maxContextTokens?: number;
  readonly maxOutputTokens?: number;
  /** Required for `kind: 'embedding'`. */
  readonly embedding?: EmbeddingModelDescriptor;
}

/** A model the provider reported when asked what it has. */
export interface DiscoveredModel {
  readonly id: string;
  readonly kind: 'chat' | 'embedding' | 'unknown';
  readonly displayName?: string;
  readonly maxContextTokens?: number;
  /** Whether the provider says it is ready to serve. */
  readonly ready?: boolean;
}

// ─── Private endpoints ───────────────────────────────────────

/**
 * An operator's explicit decision that one host and port on a private or local
 * network may be called. Without a matching entry the transport refuses every
 * loopback and private address.
 */
export interface PrivateEndpointAllowance {
  /** Hostname or IP literal, compared case-insensitively and exactly. */
  readonly host: string;
  /** Port. Compared exactly; 443/80 when the URL names none. */
  readonly port: number;
  /** When set, only the provider with this id may use the entry. */
  readonly providerId?: string;
}

// ─── Adapter contract ────────────────────────────────────────

/** One request an adapter wants sent. */
export interface WireRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** The guarded way out. Adapters never call the network any other way. */
export interface ProviderTransport {
  /** Send and buffer the response (subject to the timeout and size cap). */
  send(request: WireRequest): Promise<WireResponse>;
  /** Send and return the live body for a streaming endpoint. */
  open(request: WireRequest): Promise<WireStream>;
}

/**
 * A SUCCESSFUL response. The transport turns every non-2xx answer into a
 * `WeaveIntelError` (auth failed, rate limited, ...) before an adapter sees it,
 * so adapters only translate bodies.
 */
export interface WireResponse {
  readonly status: number;
  readonly headers: Headers;
  /** The body as text. Parsing is the adapter's job so malformed bodies are its error. */
  readonly text: string;
}

export interface WireStream {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  /** Read the whole body as text (used for an error status). */
  text(): Promise<string>;
}

/** Short-lived derived credentials (an OAuth access token) kept between calls. */
export interface DerivedTokenCache {
  /** `secretValue` keys the entry by a hash, so a rotated secret never reuses an old token. */
  get(name: string, secretValue: string): string | undefined;
  set(name: string, secretValue: string, token: string, expiresAtMs: number): void;
}

/** Everything an adapter needs for one call. Built fresh per call by the registry. */
export interface AdapterCall {
  readonly provider: ProviderDescription;
  readonly ctx: ExecutionContext;
  readonly transport: ProviderTransport;
  readonly tokens: DerivedTokenCache;
  /** Fetch a secret now. Fails with the slot NAME (never a value) when absent. */
  secret(slot: string): Promise<string>;
  /** Fetch a secret now, or `undefined` when the provider does not use that slot. */
  optionalSecret(slot: string): Promise<string | undefined>;
  /**
   * Tell the registry a derived value (an access token) must also be kept out
   * of errors and events.
   */
  protect(value: string): void;
  /**
   * Check an address against the registry's network rules without sending
   * anything. For adapters that hand the actual sending to another library:
   * they must call this first so a private address is still refused.
   */
  checkEndpoint(url: string): Promise<void>;
}

/** One embedding request in adapter terms. */
export interface AdapterEmbedInput {
  readonly texts: readonly string[];
  /** The size to ask the provider for, when the model reduces provider-side. */
  readonly dimensions?: number;
  readonly mode?: EmbeddingMode;
}

export interface AdapterEmbedOutput {
  readonly vectors: readonly (readonly number[])[];
  readonly totalTokens: number;
}

/** A named key a provider kind needs, for a host's "paste your key" form. */
export interface SecretSlot {
  readonly name: string;
  readonly label: string;
  readonly required: boolean;
  /** Longer than one line (a service-account file). */
  readonly multiline?: boolean;
}

/** Translates one wire format. Holds no state and no secret. */
export interface ProviderAdapter {
  readonly kind: string;
  /** A name a person would recognise for this kind of provider. */
  readonly label: string;
  readonly secretSlots: readonly SecretSlot[];
  generate?(call: AdapterCall, model: ModelDescription, request: ModelRequest): Promise<ModelResponse>;
  stream?(call: AdapterCall, model: ModelDescription, request: ModelRequest): AsyncIterable<StreamChunk>;
  embed?(call: AdapterCall, model: ModelDescription, input: AdapterEmbedInput): Promise<AdapterEmbedOutput>;
  /** Ask the provider what models it has. */
  listModels?(call: AdapterCall): Promise<readonly DiscoveredModel[]>;
  /** The cheapest authenticated request, for "test connection" where listing is impossible. */
  probe?(call: AdapterCall): Promise<void>;
  /**
   * Optional: correct how a failed HTTP response is classified, for providers
   * whose status codes mislead (Gemini answers a bad key with 400). Return
   * `undefined` to keep the registry's reading of the status code.
   */
  mapError?(status: number, headers: Headers, bodyText: string): WireErrorOverride | undefined;
}

/** What an adapter may correct about a failed response. */
export interface WireErrorOverride {
  readonly code?: 'AUTH_FAILED' | 'RATE_LIMITED' | 'NOT_FOUND' | 'INVALID_INPUT' | 'PROVIDER_ERROR' | 'TIMEOUT';
  readonly message?: string;
  readonly retryable?: boolean;
}

// ─── What the registry hands back ────────────────────────────

/** Which model produced a set of vectors, and how they were finished. */
export interface EmbeddingProvenance {
  readonly providerId: string;
  readonly providerKind: string;
  readonly modelId: string;
  /** The length of every vector in the response. */
  readonly dimensions: number;
  /** True when the registry brought the vectors to unit length itself. */
  readonly normalizedByRegistry: boolean;
  /** True when the registry cut a larger vector down to the requested size. */
  readonly reducedByRegistry: boolean;
}

export interface DescribedEmbeddingRequest extends EmbeddingRequest {
  /** Whether the texts are being stored or are a search question. Default `document`. */
  readonly mode?: EmbeddingMode;
}

export interface DescribedEmbeddingResponse extends EmbeddingResponse {
  /** Says which model identity and size produced every vector in this response. */
  readonly provenance: EmbeddingProvenance;
}

/** An embedding model that knows what it is and says so with every answer. */
export interface DescribedEmbeddingModel extends EmbeddingModel {
  readonly descriptor: EmbeddingModelDescriptor;
  /** The size this model was built to produce. */
  readonly dimensions: number;
  embed(ctx: ExecutionContext, request: DescribedEmbeddingRequest): Promise<DescribedEmbeddingResponse>;
}

/** The outcome of "test connection". Never carries a secret. */
export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  /** Machine-readable outcome: `ok`, `auth_failed`, `rate_limited`, `blocked`, `unreachable`, `error`. */
  readonly outcome: 'ok' | 'auth_failed' | 'rate_limited' | 'blocked' | 'unreachable' | 'error';
  /** One plain sentence for a person. */
  readonly message: string;
  /** How many models the provider reported, when it could list them. */
  readonly modelCount?: number;
}

/** Something the registry did, for a host's log or trace. Never carries a secret. */
export interface RegistryEvent {
  readonly kind: 'call' | 'error' | 'blocked';
  readonly providerId: string;
  readonly providerKind: string;
  readonly operation: 'generate' | 'stream' | 'embed' | 'listModels' | 'probe';
  readonly modelId?: string;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly message?: string;
}
