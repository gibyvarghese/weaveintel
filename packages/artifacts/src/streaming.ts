/**
 * @weaveintel/artifacts — Streaming Artifact Lifecycle
 *
 * Provides `ArtifactStreamHandle<T>` and `streamArtifact<T>()` for
 * progressive, real-time artifact generation (large reports, live data).
 *
 * Flow:
 *   1. Caller calls `streamArtifact(store, opts)` — returns a handle with
 *      a pre-assigned artifact id (initial row saved to store immediately).
 *   2. As content is generated, caller calls `handle.update(partial, progress)`.
 *      Each update fires an optional `onProgress` callback so the host can
 *      push SSE events to subscribed clients.
 *   3. When done, caller calls `handle.complete(final, changelog)` — writes
 *      the finalised data to the store and marks the stream as complete.
 *   4. On failure, caller calls `handle.error(message)` to mark the stream
 *      as errored.
 *
 * The handle tracks `status` ('streaming' | 'complete' | 'error') and
 * `progress` (0.0–1.0) as plain getters. Hosts that need SSE delivery
 * should supply an `onProgress` callback and emit bus events from there.
 */

import type { ArtifactStore, Artifact } from '@weaveintel/core';
import type { CreateArtifactOptions } from './artifact.js';

export type ArtifactStreamStatus = 'streaming' | 'complete' | 'error';

export interface ArtifactStreamEvent<T = unknown> {
  /** Discriminant — 'update', 'complete', or 'error'. */
  kind: ArtifactStreamStatus | 'update';
  artifactId: string;
  /** 0.0–1.0 */
  progress: number;
  /** Latest partial (for 'update') or final (for 'complete') data. */
  data?: T;
  /** Human-readable version label (e.g. "v2"). */
  version?: number;
  /** Error message (for 'error' events). */
  message?: string;
}

export interface ArtifactStreamHandle<T = unknown> {
  /** Assigned artifact id — available immediately after `streamArtifact()` resolves. */
  readonly id: string;
  /** Lifecycle status. Starts as 'streaming'; transitions to 'complete' or 'error'. */
  readonly status: ArtifactStreamStatus;
  /** Normalised progress between 0.0 and 1.0. */
  readonly progress: number;

  /**
   * Send a partial update. Fires the host's `onProgress` callback with an
   * 'update' event. Does NOT write a new version to the store — keeps writes
   * minimal during high-frequency streaming.
   *
   * @param partial  Partial data accumulated so far.
   * @param progress  0.0–1.0 fraction complete. Defaults to current progress.
   */
  update(partial: Partial<T>, progress?: number): Promise<void>;

  /**
   * Finalise the stream. Writes the complete data as a new version (via
   * `store.update()`), fires 'complete', and transitions status.
   *
   * @param final     The complete artifact payload.
   * @param changelog Human-readable summary of what was generated.
   */
  complete(final: T, changelog?: string): Promise<Artifact>;

  /**
   * Mark the stream as failed. Updates artifact metadata with the error
   * message and transitions status to 'error'.
   */
  error(message: string): Promise<void>;
}

/**
 * Options for how progress events are delivered to the host.
 */
export interface StreamArtifactOptions<T = unknown> {
  /**
   * Called on every `update()`, `complete()`, and `error()`. The host uses
   * this to push Server-Sent Events to subscribed clients.
   */
  onProgress?: (event: ArtifactStreamEvent<T>) => void;
}

/**
 * Create a streaming artifact handle.
 *
 * Saves an initial artifact row to `store` immediately (so the id is known
 * before any streaming begins). Returns a handle the caller can use to push
 * partial updates and eventually finalise.
 *
 * @example
 * ```typescript
 * const store = createInMemoryArtifactStore();
 * const handle = await streamArtifact(store, {
 *   name: 'market-report.md', type: 'markdown', mimeType: 'text/markdown', data: '',
 * }, {
 *   onProgress: (ev) => sseClient.send(ev),
 * });
 *
 * // Progressively build content
 * for (let i = 0; i < chunks.length; i++) {
 *   await handle.update({ data: chunks.slice(0, i + 1).join('') }, (i + 1) / chunks.length);
 * }
 * const artifact = await handle.complete(fullContent, 'Generated market report');
 * ```
 */
export async function streamArtifact<T = unknown>(
  store: ArtifactStore,
  opts: CreateArtifactOptions,
  streamOpts?: StreamArtifactOptions<T>,
): Promise<ArtifactStreamHandle<T>> {
  const onProgress = streamOpts?.onProgress;

  // Save the initial (empty/partial) artifact row so we get a stable id.
  const initial = await store.save({
    name: opts.name,
    type: opts.type,
    mimeType: opts.mimeType,
    data: opts.data ?? '',
    sizeBytes: 0,
    version: 1,
    tags: opts.tags,
    runId: opts.runId,
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    userId: opts.userId,
    scope: opts.scope ?? 'session',
    metadata: {
      ...opts.metadata,
      streamingStatus: 'streaming',
      streamingProgress: 0,
    },
  });

  let _status: ArtifactStreamStatus = 'streaming';
  let _progress = 0;
  const artifactId = initial.id;

  const handle: ArtifactStreamHandle<T> = {
    get id() { return artifactId; },
    get status() { return _status; },
    get progress() { return _progress; },

    async update(partial: Partial<T>, progress?: number): Promise<void> {
      if (_status !== 'streaming') return;
      _progress = Math.max(0, Math.min(1, progress ?? _progress));
      const event: ArtifactStreamEvent<T> = {
        kind: 'update',
        artifactId,
        progress: _progress,
        data: partial as T,
      };
      onProgress?.(event);
    },

    async complete(final: T, changelog?: string): Promise<Artifact> {
      _status = 'complete';
      _progress = 1;
      const updated = await store.update(artifactId, {
        data: final as unknown,
        metadata: { streamingStatus: 'complete', streamingProgress: 1 },
      }, changelog);
      const event: ArtifactStreamEvent<T> = {
        kind: 'complete',
        artifactId,
        progress: 1,
        data: final,
        version: updated.version,
      };
      onProgress?.(event);
      return updated;
    },

    async error(message: string): Promise<void> {
      _status = 'error';
      await store.update(artifactId, {
        metadata: { streamingStatus: 'error', streamingError: message },
      });
      const event: ArtifactStreamEvent<T> = {
        kind: 'error',
        artifactId,
        progress: _progress,
        message,
      };
      onProgress?.(event);
    },
  };

  return handle;
}
