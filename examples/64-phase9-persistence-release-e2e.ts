/**
 * Example 64 — Phase 9 Persistence Release Validation E2E
 *
 * Why this exists:
 * - Phase 9 focuses on operator-ready documentation + release confidence.
 * - We already have scenario examples for each phase/backend family.
 * - Release validation should be one command that executes those examples and
 *   reports an unambiguous pass/fail summary for operators.
 *
 * What this script does:
 * 1) Runs the persistence examples that cover Phase 6/7/8 behavior.
 * 2) Optionally includes the live-agents persistence scenario suite.
 * 3) Streams each child process output so operators can inspect details inline.
 * 4) Emits a final summary table and exits non-zero on any failure.
 *
 * Usage:
 *   node --import tsx examples/64-phase9-persistence-release-e2e.ts
 *
 * Optional:
 *   WEAVE_PHASE9_INCLUDE_LIVE_AGENTS=1 node --import tsx examples/64-phase9-persistence-release-e2e.ts
 */

import { spawn } from 'node:child_process';

interface ScenarioSpec {
  name: string;
  command: string;
  args: string[];
  requiredForPass: boolean;
}

interface ScenarioResult {
  name: string;
  commandLine: string;
  exitCode: number;
  passed: boolean;
  durationMs: number;
}

function nowMs(): number {
  return Date.now();
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Executes one scenario and streams child output directly to this process.
 * Streaming output is intentional because release operators need to see the
 * underlying example diagnostics (including skipped backends) in real time.
 */
async function runScenario(spec: ScenarioSpec): Promise<ScenarioResult> {
  const startedAt = nowMs();
  const commandLine = [spec.command, ...spec.args].join(' ');

  console.log(`\n==> Running ${spec.name}`);
  console.log(`    ${commandLine}`);

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(spec.command, spec.args, {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', () => {
      // Spawn failures are treated as immediate non-zero exits.
      resolve(1);
    });

    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });

  const durationMs = nowMs() - startedAt;
  const passed = exitCode === 0;

  console.log(
    `    ${passed ? 'PASS' : 'FAIL'} (${formatDuration(durationMs)})`,
  );

  return {
    name: spec.name,
    commandLine,
    exitCode,
    passed,
    durationMs,
  };
}

function getScenarioSpecs(): ScenarioSpec[] {
  const scenarios: ScenarioSpec[] = [
    {
      name: 'Phase 6 non-live memory backends',
      command: 'node',
      args: ['--import', 'tsx', 'examples/61-agent-persistence-methods-e2e.ts'],
      requiredForPass: true,
    },
    {
      name: 'Phase 7 observability/replay/eval persistence',
      command: 'node',
      args: ['--import', 'tsx', 'examples/62-phase7-observability-replay-eval-persistence-e2e.ts'],
      requiredForPass: true,
    },
    {
      name: 'Phase 8 performance/reliability benchmark',
      command: 'node',
      args: ['--import', 'tsx', 'examples/63-phase8-persistence-performance-reliability-e2e.ts'],
      requiredForPass: true,
    },
  ];

  if (process.env['WEAVE_PHASE9_INCLUDE_LIVE_AGENTS'] === '1') {
    scenarios.unshift({
      name: 'Live-agents persistence backends',
      command: 'node',
      args: ['--import', 'tsx', 'examples/60-live-agents-persistence-methods-e2e.ts'],
      requiredForPass: true,
    });
  }

  return scenarios;
}

function printSummary(results: readonly ScenarioResult[]): void {
  console.log('\nPhase 9 release validation summary');
  console.log('----------------------------------');

  for (const result of results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    console.log(
      `${status} | ${result.name} | code=${result.exitCode} | duration=${formatDuration(result.durationMs)}`,
    );
  }

  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const failed = total - passed;

  console.log('----------------------------------');
  console.log(`total=${total} passed=${passed} failed=${failed}`);
}

async function main(): Promise<void> {
  console.log('Phase 9 persistence release validation E2E');

  const specs = getScenarioSpecs();
  const results: ScenarioResult[] = [];

  for (const spec of specs) {
    // Run scenarios sequentially so logs stay grouped and operators can
    // correlate a failure with the precise scenario that produced it.
    const result = await runScenario(spec);
    results.push(result);

    // Fail fast on required scenarios to shorten feedback loops in CI.
    if (spec.requiredForPass && !result.passed) {
      printSummary(results);
      process.exit(1);
    }
  }

  printSummary(results);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
