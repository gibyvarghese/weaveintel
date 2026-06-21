#!/usr/bin/env node
/**
 * demo-computer-use.mjs
 *
 * Demonstrates the `agentic.computer-use` handler via two paths:
 *
 *   1. weaveAgent path (new) — `createCuaWeaveAgent()` wires bash + file tools
 *      through the standard weaveAgent ReAct loop with visionLoop:true.
 *
 *   2. weaveLiveAgent path (existing) — the live-agents handler builds a
 *      TaskHandler that the heartbeat supervisor would call per tick.
 *
 * The demo runs a real task: "list the scripts/ directory and create a file
 * summarising what's there". This exercises bash, str_replace_editor, and
 * the screenshot fallback — no display required.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/demo-computer-use.mjs
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/demo-computer-use.mjs --path weave-agent
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/demo-computer-use.mjs --path live-agent
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/demo-computer-use.mjs --task "open a terminal and echo hello"
 */

import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';

const __dir = dirname(fileURLToPath(import.meta.url));
const root  = join(__dir, '..');
const require = createRequire(import.meta.url);

// Parse CLI args
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : (process.argv[++i] ?? true);
  }
}

const PATH_MODE    = args['path'] ?? 'weave-agent'; // 'weave-agent' | 'live-agent' | 'both'
const TASK         = args['task'] ?? `List the contents of the scripts/ directory at ${root} using the bash tool, then use str_replace_editor to create a file at /tmp/cua-demo-summary.txt summarising what scripts are available.`;
const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'] || '';
const OPENAI_KEY    = process.env['OPENAI_API_KEY']    || '';
// Prefer Anthropic for real CUA; fall back to OpenAI (bash+file tools still work)
const API_KEY       = ANTHROPIC_KEY || OPENAI_KEY;

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  red:    '\x1b[31m',
  dim:    '\x1b[2m',
};

function header(msg) { console.log(`\n${C.bold}${C.cyan}━━ ${msg} ━━${C.reset}\n`); }
function ok(msg)     { console.log(`${C.green}✓${C.reset} ${msg}`); }
function info(msg)   { console.log(`${C.blue}ℹ${C.reset} ${msg}`); }
function warn(msg)   { console.log(`${C.yellow}⚠${C.reset} ${msg}`); }
function err(msg)    { console.error(`${C.red}✗${C.reset} ${msg}`); }

if (!API_KEY) {
  err('Set ANTHROPIC_API_KEY or OPENAI_API_KEY before running this script.');
  process.exit(1);
}

// ── Dynamic imports (packages built with ESM) ─────────────────────────────

async function loadPackages() {
  const anthropicDist  = join(root, 'packages/provider-anthropic/dist/index.js');
  const openaiDist     = join(root, 'packages/provider-openai/dist/index.js');
  const agentsDist     = join(root, 'packages/agents/dist/index.js');
  const runtimeDist    = join(root, 'packages/live-agents-runtime/dist/index.js');
  const liveAgentsDist = join(root, 'packages/live-agents/dist/index.js');

  const { weaveAnthropic }    = await import(anthropicDist);
  const { weaveOpenAI }       = await import(openaiDist);
  const { weaveAgent }        = await import(agentsDist);
  const {
    createCuaWeaveAgent,
    createCuaToolRegistry,
    wrapModelForCua,
    agenticComputerUseHandler,
  } = await import(runtimeDist);
  const { weaveLiveAgent }    = await import(liveAgentsDist);

  // Pick provider. Anthropic gives real CUA native tools; OpenAI works
  // with the standard bash+file tools through the same ReAct loop.
  function makeModel(modelId, providerOpts = {}) {
    if (ANTHROPIC_KEY) return weaveAnthropic(modelId ?? 'claude-opus-4-8', { apiKey: ANTHROPIC_KEY, ...providerOpts });
    return weaveOpenAI(modelId ?? 'gpt-4o', { apiKey: OPENAI_KEY, ...providerOpts });
  }

  const provider = ANTHROPIC_KEY
    ? 'Anthropic (claude-opus-4-8) — native CUA tools active'
    : 'OpenAI (gpt-4o) — standard tool-calling; bash+file tools active';

  return { makeModel, provider, weaveAgent, createCuaWeaveAgent, createCuaToolRegistry, wrapModelForCua, agenticComputerUseHandler, weaveLiveAgent };
}

// ── Path 1: weaveAgent ─────────────────────────────────────────────────────

async function runViaWeaveAgent({ makeModel, provider, createCuaWeaveAgent }) {
  header('Path 1 — createCuaWeaveAgent() → weaveAgent');

  info(`Provider: ${provider}`);
  info(`Task:     ${TASK.slice(0, 100)}...`);
  info(`CWD:      ${root}`);
  info('Tools:    computer (screenshot/actions), bash, str_replace_editor');
  console.log();

  const model = makeModel();

  const agent = createCuaWeaveAgent({
    model,
    config: {
      max_steps: 20,
      allowed_actions: ['screenshot', 'left_click', 'type', 'key', 'scroll', 'mouse_move'],
    },
    tools: { cwd: root, bashTimeoutMs: 15_000 },
    display: { displayWidth: 1280, displayHeight: 800 },
    name: 'cua-demo-agent',
  });

  const ctx = { userId: 'demo-user', sessionId: `demo-sess-${Date.now()}` };
  const startMs = Date.now();

  const result = await agent.run(ctx, {
    messages: [{ role: 'user', content: TASK }],
    goal: TASK,
  });

  // Print steps inline as we parse the result
  for (const step of result.steps) {
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    if (step.type === 'tool_call') {
      const tool = step.toolCall?.name ?? step.content ?? '?';
      const argPreview = JSON.stringify(step.toolCall?.arguments ?? {}).slice(0, 80);
      console.log(`  ${C.yellow}[${elapsed}s]${C.reset} tool: ${C.bold}${tool}${C.reset} ${C.dim}${argPreview}${C.reset}`);
    }
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log();

  if (result.status === 'completed') {
    ok(`Completed in ${elapsed}s (${result.steps.length} steps, ${result.usage?.totalTokens ?? '?'} tokens)`);
    console.log();
    console.log(`${C.bold}Result:${C.reset}`);
    console.log(result.output?.slice(0, 2000));
  } else {
    warn(`Finished with status: ${result.status} in ${elapsed}s`);
    if (result.output) console.log(result.output.slice(0, 500));
  }

  return result;
}

// ── Path 2: weaveLiveAgent tick ────────────────────────────────────────────

async function runViaLiveAgent({ makeModel, provider, wrapModelForCua, createCuaToolRegistry, agenticComputerUseHandler }) {
  header('Path 2 — agentic.computer-use handler → weaveLiveAgent tick');

  info('This simulates a single heartbeat supervisor tick for the handler.');
  info(`Provider: ${provider}`);
  info(`Task:     ${TASK.slice(0, 100)}...`);
  console.log();

  const baseModel = makeModel();
  const cuaModel  = wrapModelForCua(baseModel, { displayWidth: 1280, displayHeight: 800 });
  const tools     = createCuaToolRegistry({ cwd: root, bashTimeoutMs: 15_000 });

  // Build the HandlerContext the supervisor would normally construct from DB rows
  const ctx = {
    binding: {
      id:          'demo-binding-1',
      agentId:     'demo-agent-1',
      handlerKind: 'agentic.computer-use',
      config: { max_steps: 15 },
    },
    agent: {
      id:      'demo-agent-1',
      meshId:  'demo-mesh-1',
      roleKey: 'cua-worker',
      name:    'CUA Demo Agent',
    },
    model: cuaModel,
    tools,
    log: (msg) => console.log(`  ${C.dim}[handler]${C.reset} ${msg}`),
  };

  const handler = agenticComputerUseHandler.factory(ctx);
  info('Handler built. Calling tick...');
  console.log();

  // Simulate the ActionExecutionContext the live-agents supervisor provides
  const execCtx = {
    tickId:  `tick-demo-${Date.now()}`,
    nowIso:  new Date().toISOString(),
    agent: {
      id: 'demo-agent-1', role: 'cua-worker', name: 'CUA Demo Agent',
      meshId: 'demo-mesh-1', status: 'ACTIVE',
    },
    activeBindings: [],
    stateStore: {
      listMessagesForRecipient: async () => [{
        id:        'msg-demo-1',
        kind:      'TASK',
        status:    'DELIVERED',
        subject:   'Computer use task',
        body:      TASK,
        fromType:  'HUMAN',
        fromId:    'human-1',
        toType:    'AGENT',
        toId:      'demo-agent-1',
        createdAt: new Date().toISOString(),
      }],
      saveMessage:    async () => {},
      saveBacklogItem: async () => {},
      listBacklogForAgent: async () => [],
    },
  };

  const startMs = Date.now();
  const result  = await handler({ type: 'StartTask' }, execCtx, {});
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

  console.log();
  if (result?.completed) {
    ok(`Tick completed in ${elapsed}s`);
    console.log();
    console.log(`${C.bold}Summary:${C.reset}`);
    console.log(result.summaryProse?.slice(0, 2000) ?? '(no summary)');
  } else {
    warn(`Tick returned completed=false in ${elapsed}s`);
  }

  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════╗`);
console.log(`║  Computer Use Demo — weaveintel      ║`);
console.log(`╚══════════════════════════════════════╝${C.reset}`);
info(`Mode: ${PATH_MODE}`);

let pkgs;
try {
  pkgs = await loadPackages();
} catch (e) {
  err(`Failed to load packages: ${e.message}`);
  err('Run `pnpm build` in the repo root first, then retry.');
  process.exit(1);
}

try {
  if (PATH_MODE === 'weave-agent' || PATH_MODE === 'both') {
    await runViaWeaveAgent(pkgs);
  }
  if (PATH_MODE === 'live-agent' || PATH_MODE === 'both') {
    await runViaLiveAgent(pkgs);
  }
  console.log(`\n${C.green}${C.bold}Demo complete.${C.reset}\n`);
} catch (e) {
  console.log();
  err(`Demo failed: ${e.message}`);
  if (e.stack) console.error(C.dim + e.stack + C.reset);
  process.exit(1);
}
