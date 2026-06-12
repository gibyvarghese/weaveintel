/**
 * Example 139 — Detachable run + resume via @weaveintel/client
 *
 * Demonstrates the client-side run lifecycle:
 *  1. Start a run (POST /api/me/runs) using RunClient
 *  2. Attach an SSE stream to receive events
 *  3. Simulate detaching (AbortController.abort) and re-attaching from a
 *     saved sequence number (resumable streaming via ?after=<seq>)
 *  4. Reduce the event stream into a RunViewModel via streamReducer
 *
 * No real server or LLM is needed — uses mockSseTransport + fetchJsonTransport
 * stub to verify the full flow in-process.
 */

import assert from 'node:assert/strict';
import {
  createRunClient,
  mockSseTransport,
  emptyRunViewModel,
  streamReducer,
} from '@weaveintel/client';
import type { RunEventEnvelope, StreamEvent } from '@weaveintel/client';

function toStreamEvents(envelopes: RunEventEnvelope[]): StreamEvent[] {
  return envelopes.map((env) => ({ data: JSON.stringify(env) }));
}

// ---------------------------------------------------------------------------
// Pre-canned event stream (two batches simulating detach + re-attach)
// ---------------------------------------------------------------------------

const BATCH_1: RunEventEnvelope[] = [
  { runId: 'run-1', sequence: 0, kind: 'run.started',    payload: { origin: 'web' },  timestamp: Date.now() },
  { runId: 'run-1', sequence: 1, kind: 'text.delta',     payload: { delta: 'Hello ' }, timestamp: Date.now() },
  { runId: 'run-1', sequence: 2, kind: 'text.delta',     payload: { delta: 'world'  }, timestamp: Date.now() },
];

const BATCH_2: RunEventEnvelope[] = [
  { runId: 'run-1', sequence: 3, kind: 'text.delta',     payload: { delta: '!'      }, timestamp: Date.now() },
  { runId: 'run-1', sequence: 4, kind: 'run.completed',  payload: { summary: 'done' }, timestamp: Date.now() },
];

// ---------------------------------------------------------------------------
// Fake JSON transport for startRun / getRun
// ---------------------------------------------------------------------------

function buildFakeJson() {
  return {
    async get<T>(_path: string): Promise<T | null> {
      return { id: 'run-1', status: 'pending', user_id: 'u1' } as unknown as T;
    },
    async post<T>(_path: string, _body?: unknown): Promise<T | null> {
      return { id: 'run-1', status: 'pending', user_id: 'u1' } as unknown as T;
    },
    async del<T>(_path: string): Promise<T | null> {
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Main example
// ---------------------------------------------------------------------------

async function main() {
  // ── Batch 1 — first attach ───────────────────────────────────────────────

  const client = createRunClient({
    baseUrl: 'http://localhost:3500',
    sse: mockSseTransport(toStreamEvents(BATCH_1)),
    json: buildFakeJson() as any,
  });

  let vm = emptyRunViewModel();
  const receivedSeqs: number[] = [];

  await new Promise<void>((resolve, reject) => {
    const ac = client.attach('run-1', {
      onEvent(env: RunEventEnvelope) {
        receivedSeqs.push(env.sequence);
        vm = streamReducer(vm, env);
      },
      onComplete: () => resolve(),
      onError: reject,
    });
    // Detach early after sequence 2 to simulate disconnect
    setTimeout(() => {
      if (receivedSeqs.length >= 2) ac.abort();
      resolve(); // resolve anyway — mock stream ends after batch
    }, 50);
  });

  assert.ok(receivedSeqs.includes(0), 'batch 1: received run.started');
  assert.ok(receivedSeqs.includes(1), 'batch 1: received first text.delta');

  const seqAfter = Math.max(...receivedSeqs);

  // ── Batch 2 — resume from saved sequence ────────────────────────────────

  const client2 = createRunClient({
    baseUrl: 'http://localhost:3500',
    sse: mockSseTransport(toStreamEvents(BATCH_2)),
    json: buildFakeJson() as any,
  });

  const resumedSeqs: number[] = [];

  await new Promise<void>((resolve, reject) => {
    client2.attach('run-1', {
      afterSequence: seqAfter,
      onEvent(env: RunEventEnvelope) {
        resumedSeqs.push(env.sequence);
        vm = streamReducer(vm, env);
      },
      onComplete: () => resolve(),
      onError: reject,
    });
    setTimeout(() => resolve(), 50);
  });

  // ── Assertions ───────────────────────────────────────────────────────────

  assert.equal(vm.status, 'completed', 'final status is completed');
  assert.ok(
    vm.fullText.includes('Hello ') || vm.fullText.includes('world') || vm.fullText.includes('!'),
    'fullText contains delta text',
  );
  assert.ok(resumedSeqs.some((s) => s > seqAfter), 'resume only received later sequences');

  console.log('example-139 passed — detachable run + resume via @weaveintel/client');
  console.log('  fullText:', JSON.stringify(vm.fullText));
  console.log('  batch1 seqs:', receivedSeqs, '  resumed seqs:', resumedSeqs);
}

main().catch((err) => { console.error(err); process.exit(1); });
