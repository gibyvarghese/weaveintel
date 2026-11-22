// SPDX-License-Identifier: MIT
/**
 * The provider registry: turns a provider written down as data, plus a way to
 * fetch its key, into a chat model or an embedding model.
 *
 * In plain terms: the host application keeps providers as rows. For each
 * request it hands the row to this registry and gets back a model object. The
 * key is fetched at the moment of the call and thrown away afterwards, so:
 *
 *   - a key rotated a second ago is the one the next call uses;
 *   - the key is never stored on any object, and is removed from every error,
 *     event and log line before it leaves this file;
 *   - a provider added a second ago works at once, with no restart.
 *
 * The registry keeps no list of providers. It only knows the adapters (one per
 * kind of provider) it was created with.
 */

import { createHash } from 'node:crypto';
import {
  Capabilities,
  WeaveIntelError,
  assertSafeOutboundUrl,
  capabilityId,
  weaveContext,
  deadlineSignal,
  type CapabilityId,
  type ExecutionContext,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type SecretResolver,
  type StreamChunk,
} from '@weaveintel/core';
import {
  PROVIDER_RESILIENCE_DEFAULTS,
  createResilientCallable,
  type ResilientCallable,
  type RetryPolicyOptions,
} from '@weaveintel/resilience';
import { guardedSend, policyFor } from './_fetch.js';
import { SecretScrubber } from './scrub.js';
import { httpFailure, malformed } from './wire.js';
import { isUnitLength, normalizeVector, truncateVector } from './vectors.js';
import type {
  AdapterCall,
  ConnectionTestResult,
  DescribedEmbeddingModel,
  DescribedEmbeddingRequest,
  DescribedEmbeddingResponse,
  DiscoveredModel,
  ModelDescription,
  PrivateEndpointAllowance,
  ProviderAdapter,
  ProviderDescription,
  ProviderTransport,
  RegistryEvent,
  SecretSlot,
  WireRequest,
  WireResponse,
  WireStream,
} from './types.js';

type Operation = RegistryEvent['operation'];
type Job = () => Promise<unknown>;

/** Where the operator's allow entries come from. A function is asked on every call. */
export type PrivateEndpointSource =
  | readonly PrivateEndpointAllowance[]
  | ((provider: ProviderDescription) => readonly PrivateEndpointAllowance[] | Promise<readonly PrivateEndpointAllowance[]>);

export interface ProviderRegistryOptions {
  /** One adapter per kind of provider this registry can talk to. */
  readonly adapters: readonly ProviderAdapter[];
  /** Fetches a secret by the reference written on the provider description. */
  readonly secrets: SecretResolver;
  /**
   * Operator entries that allow a provider onto a private or loopback address.
   * Without a matching entry such an address is always refused.
   */
  readonly privateEndpoints?: PrivateEndpointSource;
  /** Told about every call, failure and refusal. Never receives a secret. */
  readonly onEvent?: (event: RegistryEvent) => void;
  /**
   * Retry and circuit-breaker settings (from the resilience package).
   * `false` sends every request exactly once.
   */
  readonly resilience?:
    | false
    | {
        readonly retry?: RetryPolicyOptions;
        readonly circuit?: { readonly failureThreshold?: number; readonly cooldownMs?: number };
      };
  /** Clock, for tests. */
  readonly now?: () => number;
}

/** What the host can show about one kind of provider. */
export interface AdapterSummary {
  readonly kind: string;
  readonly label: string;
  readonly secretSlots: readonly SecretSlot[];
  readonly chat: boolean;
  readonly streaming: boolean;
  readonly embeddings: boolean;
  readonly listsModels: boolean;
}

export interface ProviderRegistry {
  /** The kinds of provider this registry can talk to. */
  kinds(): readonly AdapterSummary[];
  /** A chat model for this provider and model. Nothing is sent until it is used. */
  chatModel(provider: ProviderDescription, model: ModelDescription): Model;
  /** An embedding model that always produces vectors of one size. */
  embeddingModel(
    provider: ProviderDescription,
    model: ModelDescription,
    opts?: { readonly dimensions?: number },
  ): DescribedEmbeddingModel;
  /** Try the provider with its current key. Never throws. */
  testConnection(provider: ProviderDescription, ctx?: ExecutionContext): Promise<ConnectionTestResult>;
  /** Ask the provider which models it offers. */
  listModels(provider: ProviderDescription, ctx?: ExecutionContext): Promise<readonly DiscoveredModel[]>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BATCH = 64;

const CAPABILITY_NAMES: Readonly<Record<string, CapabilityId>> = {
  tools: Capabilities.ToolCalling,
  vision: Capabilities.Vision,
  structured_output: Capabilities.StructuredOutput,
  reasoning: Capabilities.Reasoning,
  streaming: Capabilities.Streaming,
  pdf: Capabilities.PdfInput,
  audio_in: Capabilities.AudioInput,
};

function nameOf(provider: ProviderDescription): string {
  return provider.displayName ?? provider.id;
}

function config(message: string, provider: ProviderDescription, details?: Record<string, unknown>): WeaveIntelError {
  return new WeaveIntelError({
    code: 'INVALID_CONFIG',
    message,
    provider: provider.id,
    retryable: false,
    ...(details ? { details } : {}),
  });
}

export function createProviderRegistry(opts: ProviderRegistryOptions): ProviderRegistry {
  const adapters = new Map<string, ProviderAdapter>();
  for (const a of opts.adapters) adapters.set(a.kind, a);
  const now = opts.now ?? Date.now;
  const tokenStore = new Map<string, { token: string; expiresAtMs: number }>();
  const runners = new Map<string, ResilientCallable<[Job], unknown>>();

  function emit(event: RegistryEvent): void {
    try {
      opts.onEvent?.(event);
    } catch {
      /* a listener that throws must not break a model call */
    }
  }

  function adapterFor(provider: ProviderDescription): ProviderAdapter {
    const adapter = adapters.get(provider.kind);
    if (!adapter) throw config(`${nameOf(provider)} is a kind of provider this installation cannot talk to ("${provider.kind}").`, provider);
    return adapter;
  }

  async function allowancesFor(provider: ProviderDescription): Promise<readonly PrivateEndpointAllowance[]> {
    const src = opts.privateEndpoints;
    const all = typeof src === 'function' ? await src(provider) : (src ?? []);
    return all.filter((a) => a.providerId === undefined || a.providerId === provider.id);
  }

  /** One retry-and-circuit pipeline per provider, shared by all its calls. */
  function runnerFor(provider: ProviderDescription, direct: boolean): (job: Job) => Promise<unknown> {
    if (direct || opts.resilience === false) return (job) => job();
    const endpoint = `provider:${provider.kind}:${provider.id}`;
    let runner = runners.get(endpoint);
    if (!runner) {
      runner = createResilientCallable<[Job], unknown>((job) => job(), {
        endpoint,
        retry: { ...PROVIDER_RESILIENCE_DEFAULTS.retry, ...(opts.resilience?.retry ?? {}) },
        circuit: { ...PROVIDER_RESILIENCE_DEFAULTS.circuit, ...(opts.resilience?.circuit ?? {}) },
      });
      runners.set(endpoint, runner);
    }
    return runner;
  }

  function tokenKey(provider: ProviderDescription, name: string, secretValue: string): string {
    return `${provider.id}\u0000${name}\u0000${createHash('sha256').update(secretValue).digest('hex')}`;
  }

  /**
   * Everything one adapter call needs: the secrets (fetched now), the guarded
   * transport, and the scrubber that remembers what must not leak.
   */
  function openCall(
    provider: ProviderDescription,
    adapter: ProviderAdapter,
    ctx: ExecutionContext,
    operation: Operation,
    direct = false,
  ): { call: AdapterCall; scrub: SecretScrubber } {
    const scrub = new SecretScrubber();
    const timeoutMs = provider.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    async function resolveSlot(slot: string): Promise<string | undefined> {
      const reference = provider.secrets?.[slot];
      if (reference === undefined || reference === '') return undefined;
      const value = await opts.secrets.resolve(reference);
      if (value === undefined || value === '') return undefined;
      scrub.add(value);
      return value;
    }

    async function guard(url: string): Promise<readonly PrivateEndpointAllowance[]> {
      const allowances = await allowancesFor(provider);
      const { policy } = policyFor(url, allowances);
      try {
        await assertSafeOutboundUrl(url, { ...policy, errorTag: 'provider-registry' });
      } catch (err) {
        let where = 'that address';
        try {
          const u = new URL(url);
          where = `${u.hostname}:${u.port !== '' ? u.port : u.protocol === 'http:' ? '80' : '443'}`;
        } catch {
          /* keep the generic wording */
        }
        const reason = scrub.text(err instanceof Error ? err.message.replace(/^provider-registry: /, '') : 'refused');
        emit({ kind: 'blocked', providerId: provider.id, providerKind: provider.kind, operation, message: `${where}: ${reason}` });
        throw new WeaveIntelError({
          code: 'POLICY_DENIED',
          message:
            `${nameOf(provider)} was not contacted: ${where} is not an address this installation may call ` +
            `(${reason}). A private or local address needs an operator's allow entry for that exact host and port.`,
          provider: provider.id,
          retryable: false,
          details: { endpoint: where },
        });
      }
      return allowances;
    }

    async function exchange(request: WireRequest, streaming: boolean): Promise<WireResponse | WireStream> {
      const allowances = await guard(request.url);
      const job: Job = async () => {
        let headerTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          let signal = deadlineSignal(ctx);
          if (streaming) {
            const waitForHeaders = new AbortController();
            headerTimer = setTimeout(() => waitForHeaders.abort(new DOMException('timed out', 'TimeoutError')), timeoutMs);
            signal = signal ? AbortSignal.any([signal, waitForHeaders.signal]) : waitForHeaders.signal;
          }
          const res = await guardedSend(
            request.url,
            {
              method: request.method,
              ...(request.headers ? { headers: { ...request.headers } } : {}),
              ...(request.body !== undefined ? { body: request.body } : {}),
              ...(signal ? { signal } : {}),
            },
            { allowances, timeoutMs, streaming },
          );
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw httpFailure(nameOf(provider), res.status, res.headers, text, adapter.mapError?.(res.status, res.headers, text));
          }
          if (streaming) {
            if (!res.body) throw malformed(nameOf(provider), 'the stream had no body');
            const stream: WireStream = { status: res.status, headers: res.headers, body: res.body, text: () => res.text() };
            return stream;
          }
          const text = await res.text();
          const reply: WireResponse = { status: res.status, headers: res.headers, text };
          return reply;
        } catch (err) {
          // Scrub HERE, inside the job: the resilience pipeline publishes the
          // failure on its signal bus, so it must already be clean.
          throw failureOf(err);
        } finally {
          if (headerTimer) clearTimeout(headerTimer);
        }
      };
      try {
        return (await runnerFor(provider, direct)(job)) as WireResponse | WireStream;
      } catch (err) {
        // The circuit breaker speaks in endpoint ids; say it in plain words.
        if (err instanceof WeaveIntelError && err.code === 'CIRCUIT_OPEN') {
          throw new WeaveIntelError({
            code: 'CIRCUIT_OPEN',
            message: `${nameOf(provider)} has failed several times in a row and is being rested. It will be tried again shortly.`,
            provider: provider.id,
            retryable: false,
          });
        }
        throw err;
      }
    }

    function failureOf(err: unknown): WeaveIntelError {
      if (ctx.signal?.aborted) {
        return new WeaveIntelError({ code: 'CANCELLED', message: `The request to ${nameOf(provider)} was cancelled.`, provider: provider.id, retryable: false });
      }
      if (err instanceof WeaveIntelError) return scrub.error(err, provider.id);
      const e = err as { name?: string; message?: string; cause?: { code?: string; name?: string; message?: string } } | undefined;
      const text = `${e?.name ?? ''} ${e?.message ?? ''} ${e?.cause?.name ?? ''} ${e?.cause?.message ?? ''}`;
      if (/AbortError|TimeoutError|timed out|aborted/i.test(text)) {
        return new WeaveIntelError({
          code: 'TIMEOUT',
          message: `${nameOf(provider)} did not answer within ${Math.round(timeoutMs / 100) / 10} seconds.`,
          provider: provider.id,
          retryable: true,
        });
      }
      const netCode = typeof e?.cause?.code === 'string' ? e.cause.code : undefined;
      return new WeaveIntelError({
        code: 'PROVIDER_ERROR',
        message: scrub.text(`Could not reach ${nameOf(provider)}${netCode ? ` (${netCode})` : ''}.`),
        provider: provider.id,
        retryable: true,
        details: { phase: 'network' },
      });
    }

    const transport: ProviderTransport = {
      send: (request) => exchange(request, false) as Promise<WireResponse>,
      open: (request) => exchange(request, true) as Promise<WireStream>,
    };

    const call: AdapterCall = {
      provider,
      ctx,
      transport,
      tokens: {
        get(name, secretValue) {
          const entry = tokenStore.get(tokenKey(provider, name, secretValue));
          if (!entry || entry.expiresAtMs - 60_000 <= now()) return undefined;
          scrub.add(entry.token);
          return entry.token;
        },
        set(name, secretValue, token, expiresAtMs) {
          scrub.add(token);
          for (const [k, v] of tokenStore) if (v.expiresAtMs <= now()) tokenStore.delete(k);
          tokenStore.set(tokenKey(provider, name, secretValue), { token, expiresAtMs });
        },
      },
      async secret(slot) {
        const value = await resolveSlot(slot);
        if (value === undefined) {
          const label = adapter.secretSlots.find((s) => s.name === slot)?.label ?? slot;
          throw new WeaveIntelError({
            code: 'AUTH_FAILED',
            message: `No ${label} has been set for ${nameOf(provider)}.`,
            provider: provider.id,
            retryable: false,
            details: { missingSecret: slot },
          });
        }
        return value;
      },
      optionalSecret: resolveSlot,
      protect: (value) => scrub.add(value),
      async checkEndpoint(url) {
        await guard(url);
      },
    };
    return { call, scrub };
  }

  /** Run one adapter operation: time it, report it, and scrub whatever it throws. */
  async function run<T>(
    provider: ProviderDescription,
    operation: Operation,
    modelId: string | undefined,
    ctx: ExecutionContext,
    direct: boolean,
    fn: (adapter: ProviderAdapter, call: AdapterCall) => Promise<T>,
  ): Promise<T> {
    const startedAt = now();
    const adapter = adapterFor(provider);
    const { call, scrub } = openCall(provider, adapter, ctx, operation, direct);
    try {
      const result = await fn(adapter, call);
      emit({
        kind: 'call',
        providerId: provider.id,
        providerKind: provider.kind,
        operation,
        ...(modelId !== undefined ? { modelId } : {}),
        durationMs: now() - startedAt,
      });
      return result;
    } catch (err) {
      const clean = scrub.error(err, provider.id);
      emit({
        kind: 'error',
        providerId: provider.id,
        providerKind: provider.kind,
        operation,
        ...(modelId !== undefined ? { modelId } : {}),
        durationMs: now() - startedAt,
        errorCode: clean.code,
        message: clean.message,
      });
      throw clean;
    }
  }

  function capabilitiesOf(model: ModelDescription, extra: CapabilityId[]): CapabilityId[] {
    const out = new Set<CapabilityId>(extra);
    for (const name of model.capabilities ?? []) {
      // Every `document:<mime>` entry also means "reads some document files".
      if (name.startsWith('document:')) out.add(Capabilities.DocumentInput);
      out.add(CAPABILITY_NAMES[name] ?? capabilityId(name));
    }
    return [...out];
  }

  function chatModel(provider: ProviderDescription, model: ModelDescription): Model {
    const adapter = adapterFor(provider);
    if (!adapter.generate) throw config(`${adapter.label} does not offer chat models.`, provider);
    const caps = new Set(
      capabilitiesOf(model, [Capabilities.Chat, ...(adapter.stream ? [Capabilities.Streaming] : [])]),
    ) as ReadonlySet<CapabilityId>;
    const base: Model = {
      info: {
        provider: provider.id,
        modelId: model.id,
        capabilities: caps,
        ...(model.maxContextTokens !== undefined ? { maxContextTokens: model.maxContextTokens } : {}),
        ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
      },
      capabilities: caps,
      hasCapability: (id) => caps.has(id),
      generate(ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
        return run(provider, 'generate', model.id, ctx, false, (a, call) => a.generate!(call, model, request));
      },
    };
    if (!adapter.stream) return base;
    return {
      ...base,
      stream(ctx: ExecutionContext, request: ModelRequest): AsyncIterable<StreamChunk> {
        return (async function* () {
          const startedAt = now();
          const { call, scrub } = openCall(provider, adapter, ctx, 'stream');
          try {
            yield* adapter.stream!(call, model, request);
            emit({ kind: 'call', providerId: provider.id, providerKind: provider.kind, operation: 'stream', modelId: model.id, durationMs: now() - startedAt });
          } catch (err) {
            const clean = scrub.error(err, provider.id);
            emit({ kind: 'error', providerId: provider.id, providerKind: provider.kind, operation: 'stream', modelId: model.id, durationMs: now() - startedAt, errorCode: clean.code, message: clean.message });
            throw clean;
          }
        })();
      },
    };
  }

  function embeddingModel(
    provider: ProviderDescription,
    model: ModelDescription,
    options: { readonly dimensions?: number } = {},
  ): DescribedEmbeddingModel {
    const adapter = adapterFor(provider);
    if (!adapter.embed) throw config(`${adapter.label} does not offer embedding models.`, provider);
    const descriptor = model.embedding;
    if (model.kind !== 'embedding' || !descriptor) {
      throw config(`${model.id} is not described as an embedding model.`, provider);
    }
    const native = descriptor.nativeDimensions;
    const size = options.dimensions ?? native;
    const listed = descriptor.dimensions.includes(size);
    const anySmaller = descriptor.dimensions.length === 0 && descriptor.reduce !== 'none' && size > 0 && size < native;
    if (!Number.isInteger(size) || !(size === native || (descriptor.reduce !== 'none' && (listed || anySmaller)))) {
      const sizes = [...new Set([...descriptor.dimensions, native])].sort((a, b) => a - b).join(', ');
      throw config(`${model.id} cannot produce vectors of size ${size}. It can produce: ${sizes}.`, provider, { requested: size });
    }
    const caps = new Set([Capabilities.Embedding]) as ReadonlySet<CapabilityId>;
    const batchLimit = Math.max(1, descriptor.batchLimit ?? DEFAULT_BATCH);

    return {
      info: { provider: provider.id, modelId: model.id, capabilities: caps },
      capabilities: caps,
      hasCapability: (id) => caps.has(id),
      descriptor,
      dimensions: size,
      embed(ctx: ExecutionContext, request: DescribedEmbeddingRequest): Promise<DescribedEmbeddingResponse> {
        return run(provider, 'embed', model.id, ctx, false, async (a, call) => {
          if (request.dimensions !== undefined && request.dimensions !== size) {
            throw new WeaveIntelError({
              code: 'INVALID_INPUT',
              message: `This embedding model was set up for vectors of size ${size}; ${request.dimensions} was asked for. Vectors of different sizes cannot be compared.`,
              provider: provider.id,
              retryable: false,
            });
          }
          const mode = request.mode !== undefined && descriptor.modes.includes(request.mode) ? request.mode : undefined;
          const askProvider = descriptor.reduce === 'provider' && size !== native ? size : undefined;
          const vectors: number[][] = [];
          let totalTokens = 0;
          let normalized = false;
          let reduced = false;
          for (let i = 0; i < request.input.length; i += batchLimit) {
            const texts = request.input.slice(i, i + batchLimit);
            const out = await a.embed!(call, model, {
              texts,
              ...(askProvider !== undefined ? { dimensions: askProvider } : {}),
              ...(mode !== undefined ? { mode } : {}),
            });
            if (out.vectors.length !== texts.length) {
              throw malformed(nameOf(provider), `${texts.length} texts were sent and ${out.vectors.length} vectors came back`);
            }
            totalTokens += out.totalTokens;
            for (const raw of out.vectors) {
              let v: number[] = [...raw];
              if (v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) throw malformed(nameOf(provider), 'a vector held something that is not a number');
              if (v.length !== size) {
                if (descriptor.reduce === 'truncate' && v.length > size) {
                  // Cutting a vector down changes its length, so it is always brought back to unit length.
                  v = truncateVector(v, size);
                  reduced = true;
                  normalized = true;
                } else {
                  throw malformed(nameOf(provider), `a vector of size ${v.length} came back where ${size} was expected`);
                }
              }
              if (!isUnitLength(v)) {
                v = normalizeVector(v);
                normalized = true;
              }
              vectors.push(v);
            }
          }
          return {
            embeddings: vectors,
            model: model.id,
            usage: { totalTokens },
            provenance: {
              providerId: provider.id,
              providerKind: provider.kind,
              modelId: model.id,
              dimensions: size,
              normalizedByRegistry: normalized,
              reducedByRegistry: reduced,
            },
          };
        });
      },
    };
  }

  async function listModels(provider: ProviderDescription, ctx?: ExecutionContext): Promise<readonly DiscoveredModel[]> {
    const context = ctx ?? weaveContext();
    return run(provider, 'listModels', undefined, context, false, async (a, call) => {
      if (!a.listModels) throw config(`${a.label} cannot list its models.`, provider, { cannotList: true });
      return a.listModels(call);
    });
  }

  async function testConnection(provider: ProviderDescription, ctx?: ExecutionContext): Promise<ConnectionTestResult> {
    const context = ctx ?? weaveContext();
    const startedAt = now();
    try {
      const adapter = adapterFor(provider);
      let modelCount: number | undefined;
      let listed = false;
      if (adapter.listModels) {
        try {
          // `direct`: a test always really tries the provider, once, even when
          // earlier failures have opened the circuit.
          const models = await run(provider, 'listModels', undefined, context, true, (a, call) => a.listModels!(call));
          modelCount = models.length;
          listed = true;
        } catch (err) {
          const cannot = err instanceof WeaveIntelError && err.code === 'INVALID_CONFIG' && err.details?.['cannotList'] === true;
          if (!cannot || !adapter.probe) throw err;
        }
      }
      if (!listed) {
        if (!adapter.probe) throw config(`${adapter.label} has no way to test a connection.`, provider);
        await run(provider, 'probe', undefined, context, true, (a, call) => a.probe!(call));
      }
      return {
        ok: true,
        latencyMs: now() - startedAt,
        outcome: 'ok',
        message: modelCount !== undefined ? `Connected. ${modelCount} model${modelCount === 1 ? '' : 's'} found.` : 'Connected.',
        ...(modelCount !== undefined ? { modelCount } : {}),
      };
    } catch (err) {
      const e = err instanceof WeaveIntelError ? err : new WeaveIntelError({ code: 'INTERNAL_ERROR', message: 'The test could not be run.', retryable: false });
      const outcome: ConnectionTestResult['outcome'] =
        e.code === 'AUTH_FAILED' || e.code === 'PERMISSION_DENIED'
          ? 'auth_failed'
          : e.code === 'RATE_LIMITED'
            ? 'rate_limited'
            : e.code === 'POLICY_DENIED'
              ? 'blocked'
              : e.code === 'TIMEOUT' || e.details?.['phase'] === 'network'
                ? 'unreachable'
                : 'error';
      return { ok: false, latencyMs: now() - startedAt, outcome, message: e.message };
    }
  }

  return {
    kinds: () =>
      [...adapters.values()].map((a) => ({
        kind: a.kind,
        label: a.label,
        secretSlots: a.secretSlots,
        chat: !!a.generate,
        streaming: !!a.stream,
        embeddings: !!a.embed,
        listsModels: !!a.listModels,
      })),
    chatModel,
    embeddingModel,
    testConnection,
    listModels,
  };
}
