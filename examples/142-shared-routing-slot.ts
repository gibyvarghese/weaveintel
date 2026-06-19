/**
 * Example 142: Shared Routing Slot (Phase 2)
 *
 * Demonstrates how WeaveRuntime's Phase 2 `RuntimeRoutingSlot` provides a single
 * shared `ModelHealthTracker` instance accessible through the DI container.
 * Both the chat path and the live-agent supervisor read/write the same health
 * state — a rate-limit block recorded in chat immediately deflects the supervisor
 * away from the degraded provider without any explicit coordination.
 *
 * Packages used:
 *   @weaveintel/core    — weaveRuntime, weaveContext, RuntimeCapabilities
 *   @weaveintel/routing — ModelHealthTracker, createRuntimeRoutingAdapter
 *
 * Quick-start:
 *   npx tsx examples/142-shared-routing-slot.ts
 */

import { weaveRuntime, weaveContext, RuntimeCapabilities } from '@weaveintel/core';
import { ModelHealthTracker, createRuntimeRoutingAdapter } from '@weaveintel/routing';

// ─── 1. Create the shared health tracker ─────────────────────────────────────
//
// One tracker per process. Both the chat path and the live-agent supervisor
// will record outcomes into this tracker and route using its health state.

const sharedTracker = new ModelHealthTracker();

// ─── 2. Wrap in a RuntimeRoutingSlot adapter ──────────────────────────────────
//
// The adapter bridges ModelHealthTracker to the RuntimeRoutingSlot interface
// so the runtime DI container can carry it without depending on the routing pkg.

const routingSlot = createRuntimeRoutingAdapter(sharedTracker);

// ─── 3. Wire into a WeaveRuntime ─────────────────────────────────────────────

const runtime = weaveRuntime({ tlsFloor: false, routing: routingSlot });
const ctx = weaveContext({ runtime, userId: 'example-user' });

console.log('Runtime capabilities:', Array.from(runtime.capabilities).join(', '));
console.log('Routing capability wired:', runtime.has(RuntimeCapabilities.Routing));

// ─── 4. Simulate the chat path recording model outcomes ───────────────────────
//
// In production, ChatEngine.recordModelOutcome() calls routing.recordOutcome()
// after every LLM call. The outcome data feeds the health tracker so future
// routing decisions can avoid degraded or rate-limited providers.

console.log('\n=== Chat path: recording model outcomes ===');
runtime.routing!.recordOutcome('claude-sonnet-4-6', 'anthropic', 145, true);
runtime.routing!.recordOutcome('claude-sonnet-4-6', 'anthropic', 183, true);
runtime.routing!.recordOutcome('gpt-4o', 'openai', 220, true);
runtime.routing!.recordOutcome('gpt-4o', 'openai', 195, false); // one failure

console.log('Recorded 4 outcomes across 2 providers.');

// ─── 5. Read health state via the supervisor path ────────────────────────────
//
// In production, the live-agent supervisor calls runtime.routing.listHealth()
// when building the health list to pass to routeModel(). Because both paths
// share the same underlying ModelHealthTracker, the supervisor sees the same
// outcomes the chat path recorded above.

console.log('\n=== Supervisor path: reading shared health state ===');

const health = ctx.runtime!.routing!.listHealth();
console.log(`\nHealth for ${health.length} tracked model+provider pair(s):`);
for (const h of health) {
  console.log(`  ${h.providerId}/${h.modelId}:`);
  console.log(`    available: ${h.available}`);
  console.log(`    avgLatencyMs: ${h.avgLatencyMs}`);
  console.log(`    errorRate: ${(h.errorRate * 100).toFixed(1)}%`);
  console.log(`    requestsPerMinute: ${h.requestsPerMinute}`);
}

// ─── 6. Simulate a rate-limit block ──────────────────────────────────────────
//
// When the chat path gets a 429 from a provider it calls blockProvider() so
// subsequent routing (in chat AND in the supervisor) skips that provider.

console.log('\n=== Chat path: blocking provider after rate-limit ===');
runtime.routing!.blockProvider('openai', 5 * 60_000); // 5-minute block

const blocked = ctx.runtime!.routing!.getBlockedProviders();
console.log('Currently blocked providers:', [...blocked].join(', ') || '(none)');

// Supervisor reads blocked providers before routing — openai is excluded
const supervisorBlocked = runtime.routing!.getBlockedProviders();
console.log('\nSupervisor sees the same blocked providers:', [...supervisorBlocked].join(', '));

// ─── 7. Show that require() works for Routing capability ─────────────────────

try {
  runtime.require(RuntimeCapabilities.Routing);
  console.log('\nruntime.require(RuntimeCapabilities.Routing) — OK');
} catch (e) {
  console.error('\nruntime.require failed (unexpected):', e);
}

console.log('\nPhase 2 shared routing slot demo complete.');
