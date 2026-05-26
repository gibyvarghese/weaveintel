/**
 * Example 117 — @weaveintel/tools-time end-to-end (no API keys, in-memory only).
 *
 * PROBLEM THIS PACKAGE SOLVES
 * ----------------------------
 * AI agents frequently need to answer time-sensitive questions ("what time is
 * it in Tokyo?", "start a 30-minute timer", "how long has this task been
 * running?") but JavaScript's native Date API gives no ergonomic way to handle
 * multiple timezones, format switching, or stateful countdown/stopwatch
 * management.
 *
 * @weaveintel/tools-time provides:
 *
 *   - **getTimezoneSnapshot()** — a single call that returns the localised date,
 *     time, and human-readable string for any IANA timezone.  Agents embed this
 *     snapshot into context so they never answer with stale time data.
 *   - **formatCurrentTime()** — switches between six output formats ('iso',
 *     'unix', 'human', 'date', 'time', 'weekday') in one line, without the
 *     boilerplate of Intl.DateTimeFormat construction.
 *   - **TemporalStore / createInMemoryTemporalStore()** — a scoped persistence
 *     layer (keyed by tenantId+chatId) for TimerRecords and StopwatchRecords.
 *     Persisted state survives between tool calls within the same chat session.
 *   - **createTimeTools()** — manufactures a set of `weaveTool`-shaped Tool
 *     objects that an orchestrator can hand directly to an LLM: `timer_start`,
 *     `timer_pause`, `timer_resume`, `timer_stop`, `stopwatch_start`,
 *     `stopwatch_lap`, `stopwatch_pause`, `stopwatch_resume`, `stopwatch_stop`,
 *     `datetime`, `timezone_info`, `datetime_add`, and reminder tools.
 *     Because they conform to the `Tool` interface from @weaveintel/core they
 *     slot into any WeaveIntel mesh without additional wiring.
 *
 * COVERED IN THIS EXAMPLE
 * -----------------------
 *   1. getTimezoneSnapshot() for UTC, America/New_York, Pacific/Auckland
 *   2. formatCurrentTime() across all six format strings
 *   3. Timer lifecycle: start → pause → resume → stop, with elapsed tracking
 *   4. Stopwatch: start → lap × 3 → pause → resume → stop, showing lap splits
 *   5. Tool schema inspection — name, description, inputSchema for every Tool
 *
 * Run: `npx tsx examples/117-tools-time.ts`
 */

import assert from 'node:assert/strict';
import {
  getTimezoneSnapshot,
  formatCurrentTime,
  createInMemoryTemporalStore,
  createTimeTools,
  isValidTimezone,
  resolveTimezone,
  type TimezoneSnapshot,
  type TimerRecord,
  type StopwatchRecord,
} from '@weaveintel/tools-time';
import { weaveContext } from '@weaveintel/core';

// ── Presentation helpers ──────────────────────────────────────────────────────

const PASS = '[32m✓[0m';

function section(title: string): void {
  console.log(`\n${'─'.repeat(62)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(62));
}

function ok(label: string): void {
  console.log(`  ${PASS} ${label}`);
}

// ── Deterministic "now" for snapshot tests ────────────────────────────────────
// We pin a fixed Date so the assertions on date/time strings are reproducible.
// The real tool uses new Date() internally, but every exposed function accepts
// an optional `now` parameter for exactly this kind of deterministic testing.
const FIXED_NOW = new Date('2026-05-27T12:00:00.000Z');

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n@weaveintel/tools-time — full surface-area example\n');

  // ════════════════════════════════════════════════════════════════════════════
  // 1. getTimezoneSnapshot() — multiple timezones
  // ════════════════════════════════════════════════════════════════════════════
  section('1. getTimezoneSnapshot() — UTC, America/New_York, Pacific/Auckland');

  // getTimezoneSnapshot(timezone?, locale?, now?) resolves the IANA timezone,
  // then formats the same instant four ways so agents can embed any of them
  // directly into prose without additional conversion.

  const snapshots: Array<{ label: string; tz: string }> = [
    { label: 'UTC', tz: 'UTC' },
    { label: 'US/Eastern (America/New_York)', tz: 'America/New_York' },
    { label: 'New Zealand (Pacific/Auckland)', tz: 'Pacific/Auckland' },
  ];

  for (const { label, tz } of snapshots) {
    // Pass FIXED_NOW so the output is deterministic across machines/CI.
    const snap: TimezoneSnapshot = getTimezoneSnapshot(tz, 'en-US', FIXED_NOW);

    // Structural checks — every field must be a non-empty string.
    assert.equal(snap.timezone, tz);
    assert.ok(snap.nowIso.startsWith('2026-05-27'), `nowIso should be 2026-05-27, got ${snap.nowIso}`);
    assert.ok(snap.date.length > 0, 'date should be non-empty');
    assert.ok(snap.time.length > 0, 'time should be non-empty');
    assert.ok(snap.human.length > 0, 'human should be non-empty');

    ok(`${label}`);
    console.log(`      nowIso : ${snap.nowIso}`);
    console.log(`      date   : ${snap.date}`);
    console.log(`      time   : ${snap.time}`);
    console.log(`      human  : ${snap.human}`);
  }

  // Also validate isValidTimezone() and resolveTimezone() — the guards used
  // internally before any Intl construction.
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('Not/ATimezone'), false);
  ok('isValidTimezone(\'UTC\') → true, isValidTimezone(\'Not/ATimezone\') → false');

  // resolveTimezone() falls back to the provided default when preferred is bad.
  const resolved = resolveTimezone('Bad/Zone', 'UTC');
  assert.equal(resolved, 'UTC');
  ok(`resolveTimezone('Bad/Zone', 'UTC') → '${resolved}'`);

  // ════════════════════════════════════════════════════════════════════════════
  // 2. formatCurrentTime() — all six formats
  // ════════════════════════════════════════════════════════════════════════════
  section('2. formatCurrentTime() — iso / unix / human / date / time / weekday');

  // formatCurrentTime() switches output format with a single string option.
  // All formats respect the timezone and locale options.  We use FIXED_NOW
  // (UTC noon on 2026-05-27, which is a Wednesday).

  const formats: Array<'iso' | 'unix' | 'human' | 'date' | 'time' | 'weekday'> = [
    'iso', 'unix', 'human', 'date', 'time', 'weekday',
  ];

  for (const fmt of formats) {
    const result = formatCurrentTime({ format: fmt, timezone: 'UTC', locale: 'en-US', now: FIXED_NOW });
    assert.ok(typeof result === 'string' && result.length > 0, `format '${fmt}' produced empty output`);
    ok(`format='${fmt}'  →  "${result}"`);
  }

  // Specific assertions for the most important formats:
  const isoResult = formatCurrentTime({ format: 'iso', now: FIXED_NOW });
  assert.ok(isoResult.includes('2026-05-27'), `ISO format should contain date, got: ${isoResult}`);

  const unixResult = formatCurrentTime({ format: 'unix', now: FIXED_NOW });
  // Unix timestamp for 2026-05-27T12:00:00Z
  assert.equal(unixResult, String(Math.floor(FIXED_NOW.getTime() / 1000)));
  ok(`unix format matches expected epoch: ${unixResult}`);

  const weekdayResult = formatCurrentTime({ format: 'weekday', timezone: 'UTC', locale: 'en-US', now: FIXED_NOW });
  // 2026-05-27 is a Wednesday.
  assert.equal(weekdayResult, 'Wednesday');
  ok(`weekday for 2026-05-27 → "${weekdayResult}" ✓`);

  // ════════════════════════════════════════════════════════════════════════════
  // 3. Timer lifecycle — start → pause → resume → stop
  // ════════════════════════════════════════════════════════════════════════════
  section('3. Timer lifecycle — create / pause / resume / stop (in-memory store)');

  // The timer tools use an ExecutionContext to scope timers per user/chat.
  // weaveContext() from @weaveintel/core builds a minimal context object.
  const ctx = weaveContext({
    userId: 'user-example-117',
    metadata: { chatId: 'chat-timer-demo' },
  });

  // createInMemoryTemporalStore() is the default store backing createTimeTools().
  // We create it explicitly here so we can inspect state directly without going
  // through the tool execute() calls (which also accept an ExecutionContext).
  const store = createInMemoryTemporalStore();

  // Helper: derive the scope key the same way getScope() does inside the package.
  // Scope = "<userId>:<chatId>"
  const scope = `${ctx.userId}:chat-timer-demo`;

  // 3a. Create and save a TimerRecord manually to show the raw shape.
  //     createTimeTools() does this for you via the 'timer_start' tool, but
  //     here we demonstrate the underlying store API directly.
  const startMs = Date.now();
  const timerRecord: TimerRecord = {
    id: 'timer_demo_001',
    label: 'Example countdown',
    durationMs: 60_000,   // 60-second countdown
    state: 'running',
    createdAt: new Date(startMs).toISOString(),
    startedAt: new Date(startMs).toISOString(),
    elapsedMs: 0,
  };
  store.saveTimer(scope, timerRecord);

  // Retrieve and verify the saved timer.
  const retrieved = store.getTimer(scope, 'timer_demo_001');
  assert.ok(retrieved !== null);
  assert.equal(retrieved!.state, 'running');
  ok(`saveTimer → getTimer: state="${retrieved!.state}", label="${retrieved!.label}"`);

  // 3b. Simulate pause: freeze elapsedMs, clear startedAt.
  const pauseMs = startMs + 5_000;  // 5 seconds of elapsed time
  const pausedTimer: TimerRecord = {
    ...timerRecord,
    state: 'paused',
    elapsedMs: 5_000,
    startedAt: undefined,
    pausedAt: new Date(pauseMs).toISOString(),
  };
  store.saveTimer(scope, pausedTimer);

  const afterPause = store.getTimer(scope, 'timer_demo_001');
  assert.equal(afterPause!.state, 'paused');
  assert.equal(afterPause!.elapsedMs, 5_000);
  ok(`After pause: state="${afterPause!.state}", elapsedMs=${afterPause!.elapsedMs}ms`);

  // 3c. Simulate resume: re-set startedAt to now, leave elapsedMs at the
  //     frozen value so that live elapsed = elapsedMs + (now - startedAt).
  const resumeMs = pauseMs + 2_000;
  const resumedTimer: TimerRecord = {
    ...pausedTimer,
    state: 'running',
    resumedAt: new Date(resumeMs).toISOString(),
    startedAt: new Date(resumeMs).toISOString(),
    pausedAt: undefined,
  };
  store.saveTimer(scope, resumedTimer);

  const afterResume = store.getTimer(scope, 'timer_demo_001');
  assert.equal(afterResume!.state, 'running');
  ok(`After resume: state="${afterResume!.state}", startedAt set to ${afterResume!.startedAt}`);

  // 3d. Simulate stop: freeze final elapsedMs, clear startedAt.
  const stopMs = resumeMs + 8_000;  // 8 more seconds
  const stoppedTimer: TimerRecord = {
    ...resumedTimer,
    state: 'stopped',
    elapsedMs: 5_000 + 8_000,  // total = pause carry-over + new segment
    startedAt: undefined,
    stoppedAt: new Date(stopMs).toISOString(),
  };
  store.saveTimer(scope, stoppedTimer);

  const afterStop = store.getTimer(scope, 'timer_demo_001');
  assert.equal(afterStop!.state, 'stopped');
  assert.equal(afterStop!.elapsedMs, 13_000);
  ok(`After stop: state="${afterStop!.state}", total elapsedMs=${afterStop!.elapsedMs}ms (13 s)`);

  // 3e. listTimers() returns all timers in scope.
  const allTimers = store.listTimers(scope);
  assert.equal(allTimers.length, 1);
  ok(`listTimers(scope) → ${allTimers.length} timer in scope`);

  // ════════════════════════════════════════════════════════════════════════════
  // 4. Stopwatch — start → lap × 3 → pause → resume → stop
  // ════════════════════════════════════════════════════════════════════════════
  section('4. Stopwatch — start / lap splits / pause / resume / stop');

  // StopwatchRecord stores lap times as an array of absolute elapsed-ms values
  // at the moment each lap was recorded.  The splits (time between laps) are
  // derived by differencing consecutive entries.

  const watchStart = Date.now();
  const watch: StopwatchRecord = {
    id: 'watch_demo_001',
    label: 'Race lap timer',
    state: 'running',
    createdAt: new Date(watchStart).toISOString(),
    startedAt: new Date(watchStart).toISOString(),
    elapsedMs: 0,
    laps: [],
  };
  store.saveStopwatch(scope, watch);
  ok(`Stopwatch created: id="${watch.id}", label="${watch.label}"`);

  // 4a. Record three laps.  Each lap snapshot captures the current elapsedMs.
  //     We simulate wall-clock advancement manually for determinism.
  const lapTimestamps = [3_200, 7_500, 12_800];  // ms from start
  let currentWatch = { ...watch };

  for (let i = 0; i < lapTimestamps.length; i++) {
    const lapElapsed = lapTimestamps[i]!;
    // Live stopwatch elapsed = stored elapsedMs + (now - startedAt).
    // Here we pretend "now - startedAt" gives us lapElapsed directly.
    const lapSnapshot: StopwatchRecord = {
      ...currentWatch,
      elapsedMs: lapElapsed,
      laps: [...currentWatch.laps, lapElapsed],
    };
    store.saveStopwatch(scope, lapSnapshot);
    currentWatch = lapSnapshot;
    ok(`Lap ${i + 1} recorded at ${lapElapsed}ms`);
  }

  const afterLaps = store.getStopwatch(scope, 'watch_demo_001');
  assert.equal(afterLaps!.laps.length, 3);
  assert.deepEqual([...afterLaps!.laps], [3_200, 7_500, 12_800]);
  ok(`laps array: [${afterLaps!.laps.join(', ')}]ms`);

  // Compute lap splits (time between consecutive laps).
  const splits = afterLaps!.laps.map((lap, idx) => {
    const prev = idx === 0 ? 0 : afterLaps!.laps[idx - 1]!;
    return lap - prev;
  });
  ok(`lap splits: [${splits.join(', ')}]ms`);

  // 4b. Pause the stopwatch — freeze elapsedMs.
  const pausedWatch: StopwatchRecord = {
    ...currentWatch,
    state: 'paused',
    elapsedMs: 14_000,
    startedAt: undefined,
    pausedAt: new Date().toISOString(),
  };
  store.saveStopwatch(scope, pausedWatch);
  assert.equal(store.getStopwatch(scope, 'watch_demo_001')!.state, 'paused');
  ok(`Stopwatch paused at elapsedMs=${pausedWatch.elapsedMs}ms`);

  // 4c. Resume the stopwatch.
  const resumedWatch: StopwatchRecord = {
    ...pausedWatch,
    state: 'running',
    resumedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    pausedAt: undefined,
  };
  store.saveStopwatch(scope, resumedWatch);
  assert.equal(store.getStopwatch(scope, 'watch_demo_001')!.state, 'running');
  ok(`Stopwatch resumed`);

  // 4d. Stop the stopwatch.
  const stoppedWatch: StopwatchRecord = {
    ...resumedWatch,
    state: 'stopped',
    elapsedMs: 18_500,
    startedAt: undefined,
    stoppedAt: new Date().toISOString(),
  };
  store.saveStopwatch(scope, stoppedWatch);

  const finalWatch = store.getStopwatch(scope, 'watch_demo_001');
  assert.equal(finalWatch!.state, 'stopped');
  assert.equal(finalWatch!.elapsedMs, 18_500);
  assert.equal(finalWatch!.laps.length, 3);
  ok(`Stopwatch stopped: state="${finalWatch!.state}", total=${finalWatch!.elapsedMs}ms, laps=${finalWatch!.laps.length}`);

  // ════════════════════════════════════════════════════════════════════════════
  // 5. Tool objects — inspect schema for every weaveTool exported by createTimeTools()
  // ════════════════════════════════════════════════════════════════════════════
  section('5. createTimeTools() — Tool schemas (name / description / inputSchema)');

  // createTimeTools() returns an array of Tool objects.  Each Tool has:
  //   .name         — the string identifier the LLM uses to invoke it
  //   .description  — plain-English docstring fed to the model
  //   .parameters   — JSON Schema for the tool's input arguments
  //   .execute()    — async function called by the orchestrator
  //
  // We only inspect the schema here (no execute() calls) to keep the example
  // free of execution-context wiring.  A real agent would pass these directly
  // to its tool-call loop.
  const tools = createTimeTools({ defaultTimezone: 'UTC', locale: 'en-US', store });

  // Expected tool names — covers every weaveTool in the package.
  const expectedNames = [
    'datetime',
    'timezone_info',
    'datetime_add',
    'timer_start',
    'timer_pause',
    'timer_resume',
    'timer_stop',
    'timer_status',
    'timer_list',
    'stopwatch_start',
    'stopwatch_lap',
    'stopwatch_pause',
    'stopwatch_resume',
    'stopwatch_stop',
    'stopwatch_status',
    'reminder_create',
    'reminder_list',
    'reminder_cancel',
  ];

  assert.equal(
    tools.length,
    expectedNames.length,
    `Expected ${expectedNames.length} tools, got ${tools.length}`,
  );
  ok(`createTimeTools() returned ${tools.length} Tool objects`);

  for (const tool of tools) {
    // Each Tool from @weaveintel/tools-time has a .schema object (ToolSchema)
    // with .name, .description, and .parameters (JSON Schema), plus an .invoke()
    // method. The .schema shape matches what @weaveintel/tool-schema uses when
    // translating for Anthropic/OpenAI/Google formats.
    const schema = tool.schema as { name: string; description: string; parameters: Record<string, unknown> };
    assert.ok(typeof schema.name === 'string' && schema.name.length > 0, `Tool missing name`);
    assert.ok(typeof schema.description === 'string' && schema.description.length > 0, `Tool ${schema.name} missing description`);
    assert.ok(schema.parameters !== undefined, `Tool ${schema.name} missing parameters schema`);
    assert.ok(typeof tool.invoke === 'function', `Tool ${schema.name} missing invoke function`);

    const paramProps = (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    const propNames = Object.keys(paramProps);

    ok(`  [${schema.name}]`);
    console.log(`      description : "${schema.description.slice(0, 80)}${schema.description.length > 80 ? '…' : ''}"`);
    console.log(`      parameters  : ${propNames.length > 0 ? propNames.join(', ') : '(none)'}`);
  }

  // Verify the full set of names is present (order-independent).
  const actualNames = tools.map((t) => (t.schema as { name: string }).name).sort();
  const sortedExpected = [...expectedNames].sort();
  assert.deepEqual(actualNames, sortedExpected, 'Tool name set mismatch');
  ok(`All ${tools.length} tool names verified`);

  // ════════════════════════════════════════════════════════════════════════════
  // Done
  // ════════════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(62)}`);
  console.log('  All @weaveintel/tools-time assertions passed.');
  console.log(`${'═'.repeat(62)}\n`);
}

// Exit with code 1 on any unexpected error so CI picks it up.
main().catch((err: unknown) => {
  console.error('\n[FATAL]', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
