/**
 * Example 157 — weaveAgent Supervisor with a geneWeave A2A Worker
 *
 * Demonstrates a supervisor agent that:
 *   1. Discovers available skills from a live geneWeave server via the A2A
 *      Agent Card (GET /.well-known/agent-card.json)
 *   2. Builds its own system prompt dynamically from those discovered skills
 *   3. Routes tasks to a `geneweave_agent` worker backed by geneWeave's
 *      A2A endpoint (POST /api/a2a) using real HTTP JSON-RPC 2.0 calls
 *
 * The demonstration task is CSV sales-data analysis — the same CSV that
 * lives in examples/data/sales.csv is embedded in the A2A call as a
 * base64-encoded FilePart, matching the wire format geneWeave expects.
 *
 * Architecture
 * ────────────
 *   LocalSupervisor (weaveAgent, claude-sonnet-4-6)
 *     └─ geneweave_agent  (worker)
 *          └─ call_geneweave_skill  (weaveTool → HTTP → geneWeave /api/a2a)
 *
 * The supervisor sees the discovered skills in its system prompt and decides
 * which skill_id to pass to the worker based on the user's request.
 *
 * Prerequisites
 * ─────────────
 *   • geneWeave running  (NODE_ENV=test ./scripts/start-geneweave.sh)
 *   • OPENAI_API_KEY  set in .env
 *
 * Run:
 *   GENEWEAVE_BASE_URL=http://localhost:3500 npx tsx examples/157-weaveagent-a2a-supervisor.ts
 *
 * Env vars:
 *   GENEWEAVE_BASE_URL   server base URL (default: http://localhost:3500)
 *   OPENAI_API_KEY       OpenAI key for the supervisor + worker models (uses gpt-4o-mini)
 *   GENEWEAVE_EMAIL      (optional) pre-existing verified account email
 *   GENEWEAVE_PASSWORD   (optional) matching password
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { weaveAgent } from '@weaveintel/agents';
import { weaveA2AClient } from '@weaveintel/a2a';
import {
  weaveContext,
  weaveToolRegistry,
  weaveTool,
} from '@weaveintel/core';
import type { AgentCard, AgentSkill } from '@weaveintel/core';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = (process.env['GENEWEAVE_BASE_URL'] ?? 'http://localhost:3500').replace(/\/$/, '');
const A2A_URL = `${BASE_URL}/api/a2a`;
const CSV_PATH = join(__dirname, 'data', 'sales.csv');

// ─── Logging helpers ──────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', blue: '\x1b[34m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', magenta: '\x1b[35m',
};
const c = (k: keyof typeof C, t: string) => `${C[k]}${t}${C.reset}`;

function section(title: string) {
  console.log(`\n${c('bold', `── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)}`);
}

// ─── Step 1: Authenticate with geneWeave ─────────────────────────────────────

async function authenticate(): Promise<string> {
  const email = process.env['GENEWEAVE_EMAIL'] ?? `supervisor-demo-${Date.now()}@test.local`;
  const password = process.env['GENEWEAVE_PASSWORD'] ?? `Demo_${Date.now()}!`;

  if (!process.env['GENEWEAVE_EMAIL']) {
    // Register a throwaway account for the demo run
    await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Supervisor Demo' }),
    });
    // When the server runs without NODE_ENV=test, email verification is required.
    // Fall back to direct DB update (dev-only, sqlite3 must be on PATH).
    const dbPath = join(process.cwd(), 'geneweave.db');
    if (existsSync(dbPath)) {
      try {
        execSync(`sqlite3 "${dbPath}" "UPDATE users SET email_verified=1 WHERE email='${email}';"`, { stdio: 'pipe' });
      } catch { /* sqlite3 not available; server must be running with NODE_ENV=test */ }
    }
  }

  const res = await fetch(`${BASE_URL}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Auth failed: HTTP ${res.status}. ` +
      'Set GENEWEAVE_EMAIL + GENEWEAVE_PASSWORD for an existing account, ' +
      `or run geneWeave with NODE_ENV=test.\n  ${detail.slice(0, 200)}`,
    );
  }

  const json = (await res.json()) as { token?: string; accessToken?: string };
  const token = json.token ?? json.accessToken;
  if (!token) throw new Error('No auth token in response');
  return token;
}

// ─── Step 2: Discover Agent Card from geneWeave ───────────────────────────────

async function discoverAgentCard(): Promise<AgentCard> {
  // Try the strict client first (validates origin); fall back to a raw fetch
  // when the server's configured BASE_URL doesn't match how we're connecting
  // (common in dev when the port in .env differs from the listen port).
  try {
    const client = weaveA2AClient();
    return await client.discover(BASE_URL);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('origin mismatch') && !msg.includes('PROTOCOL_ERROR')) throw err;

    console.log(c('yellow', `  ⚠ Strict discovery failed (${msg.split('\n')[0]}); using raw fetch`));
    const res = await fetch(`${BASE_URL}/.well-known/agent-card.json`, {
      headers: { 'A2A-Version': '1.0' },
    });
    if (!res.ok) throw new Error(`Agent card fetch failed: HTTP ${res.status}`);
    return (await res.json()) as AgentCard;
  }
}

// ─── Step 3: Build the geneweave_agent worker ─────────────────────────────────

/**
 * Creates a worker whose sole tool calls the geneWeave A2A endpoint.
 *
 * The tool accepts:
 *   skill_id   — which geneWeave skill to invoke (from the agent card)
 *   prompt     — the user's instruction
 *   include_csv — whether to attach the pre-loaded sales CSV
 *
 * Auth (Bearer token) and the CSV bytes are captured in the closure so the
 * model never sees credentials and file handling is transparent.
 */
function buildGeneWeaveWorker(
  token: string,
  csvBase64: string,
  skills: readonly AgentSkill[],
  model: ReturnType<typeof weaveOpenAIModel>,
) {
  const skillList = skills
    .map(s => `  • ${s.id}: ${s.description}`)
    .join('\n');

  const tools = weaveToolRegistry();

  tools.register(
    weaveTool<{ skill_id: string; prompt: string; include_csv: boolean }>({
      name: 'call_geneweave_skill',
      description:
        'Invoke a skill on the remote geneWeave AI agent via A2A JSON-RPC 2.0. ' +
        'Pass the skill_id from the agent card, the user prompt, and whether to ' +
        'attach the pre-loaded sales CSV file.',
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: `The skill to invoke. Known skills:\n${skillList}`,
          },
          prompt: {
            type: 'string',
            description: 'The instruction to send to the remote agent.',
          },
          include_csv: {
            type: 'boolean',
            description: 'Attach the sales CSV as a FilePart (set true for data-analysis tasks).',
          },
        },
        required: ['skill_id', 'prompt', 'include_csv'],
      },
      execute: async (args, _ctx) => {
        const parts: Array<Record<string, unknown>> = [{ text: args.prompt }];

        if (args.include_csv) {
          parts.push({
            raw: csvBase64,
            mediaType: 'text/csv',
            filename: 'sales.csv',
          });
        }

        const rpcBody = {
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'SendMessage',
          params: {
            message: {
              role: 'user',
              parts,
            },
            metadata: {
              skillId: args.skill_id,
              mode: 'agent',
            },
          },
        };

        console.log(c('dim', `  [geneweave_agent] → POST ${A2A_URL} (skill=${args.skill_id})`));

        const res = await fetch(A2A_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'A2A-Version': '1.0',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(rpcBody),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`geneWeave A2A HTTP ${res.status}: ${text.slice(0, 200)}`);
        }

        const envelope = (await res.json()) as {
          result?: { artifacts?: Array<{ parts?: Array<{ text?: string }> }>; status?: { state: string } };
          error?: { code: number; message: string };
        };

        if (envelope.error) {
          throw new Error(`geneWeave A2A RPC error ${envelope.error.code}: ${envelope.error.message}`);
        }

        const task = envelope.result;
        const state = task?.status?.state ?? 'unknown';
        const text = task?.artifacts?.[0]?.parts?.[0]?.text ?? '';

        console.log(c('dim', `  [geneweave_agent] ← task state=${state}, ${text.length} chars`));

        return text || `Task completed with state: ${state} (no text output)`;
      },
    }),
  );

  return {
    name: 'geneweave_agent',
    description:
      'Remote AI agent running on geneWeave. Capable of Python code execution ' +
      'for data analysis, web search, reasoning, and multi-step orchestration. ' +
      'Delegate tasks here when the user needs data insights, computations, or ' +
      'knowledge retrieval that requires tool use.',
    model,
    tools,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(c('bold', '\n=== weaveAgent Supervisor + geneWeave A2A Worker ==='));
  console.log(c('dim', `geneWeave: ${BASE_URL}  |  CSV: ${CSV_PATH}\n`));

  // ── 1. Load CSV ─────────────────────────────────────────────────────────────
  section('Loading CSV');
  let csvBytes: Buffer;
  try {
    csvBytes = readFileSync(CSV_PATH);
  } catch {
    throw new Error(`CSV not found at ${CSV_PATH} — run from the repo root`);
  }
  const csvBase64 = csvBytes.toString('base64');
  const rowCount = csvBytes.toString('utf8').split('\n').filter(Boolean).length - 1;
  console.log(`  ${c('green', '✓')} Loaded sales.csv  (${rowCount} rows, ${(csvBytes.length / 1024).toFixed(1)} KB)`);

  // ── 2. Authenticate ──────────────────────────────────────────────────────────
  section('Authenticating with geneWeave');
  const token = await authenticate();
  console.log(`  ${c('green', '✓')} Bearer token obtained`);

  // ── 3. Discover Agent Card ───────────────────────────────────────────────────
  section('Discovering geneWeave Agent Card');
  let agentCard: AgentCard;
  try {
    agentCard = await discoverAgentCard();
  } catch (err) {
    throw new Error(`Agent Card discovery failed — is geneWeave running?\n  ${err}`);
  }

  console.log(`  ${c('green', '✓')} Agent: ${agentCard.name} v${agentCard.version}`);
  console.log(`  ${c('green', '✓')} ${agentCard.skills.length} skill(s) discovered:`);
  for (const skill of agentCard.skills) {
    const tags = skill.tags?.join(', ') ?? '';
    console.log(`      ${c('cyan', skill.id)}: ${skill.description.slice(0, 70)}${tags ? `  [${tags}]` : ''}`);
  }

  // ── 4. Build model ───────────────────────────────────────────────────────────
  section('Building model');
  const model = weaveOpenAIModel('gpt-4o-mini');
  console.log(`  ${c('green', '✓')} Using gpt-4o-mini`);

  // ── 5. Build supervisor ──────────────────────────────────────────────────────
  section('Building supervisor agent');

  const skillsContext = agentCard.skills
    .map(s => `• ${s.id}\n  ${s.description}${s.tags?.length ? `\n  Tags: ${s.tags.join(', ')}` : ''}`)
    .join('\n\n');

  const supervisorSystemPrompt = [
    `You are a routing supervisor. You have access to a remote AI agent called "geneweave_agent"`,
    `that is running on ${BASE_URL}.`,
    '',
    'The remote agent exposes the following skills (use the exact skill_id when calling it):',
    '',
    skillsContext,
    '',
    'When the user gives you a task:',
    '  1. Decide which skill best matches the request.',
    '  2. Delegate to geneweave_agent with the chosen skill_id and a clear prompt.',
    '  3. For data-analysis tasks, always set include_csv=true so the sales CSV is attached.',
    '  4. Return the remote agent\'s answer directly to the user.',
  ].join('\n');

  const geneWeaveWorker = buildGeneWeaveWorker(token, csvBase64, agentCard.skills, model);

  const supervisor = weaveAgent({
    name: 'supervisor',
    model,
    systemPrompt: supervisorSystemPrompt,
    workers: [geneWeaveWorker],
    maxSteps: 6,
  });

  console.log(`  ${c('green', '✓')} Supervisor built with 1 worker (geneweave_agent)`);

  // ── 6. Run the demo task ─────────────────────────────────────────────────────
  section('Running task');

  const userTask =
    'I have a sales dataset. Please analyse it using Python code execution: ' +
    '(1) Show basic stats — rows, columns, data types. ' +
    '(2) Compute total revenue and profit by region, sorted by revenue descending. ' +
    '(3) Identify the top 3 products by total revenue. ' +
    '(4) Find the best and worst performing month by revenue. ' +
    'After each section, give a 1-sentence insight for a sales manager.';

  console.log(`  Task: "${userTask.slice(0, 100)}..."\n`);

  const ctx = weaveContext({ userId: 'supervisor-demo' });

  const result = await supervisor.run(ctx, {
    messages: [{ role: 'user', content: userTask }],
  });

  // ── 7. Report results ────────────────────────────────────────────────────────
  section('Result');

  console.log(`\n${c('bold', 'Supervisor output:')}\n`);
  console.log(result.output);

  console.log(`\n${c('bold', 'Steps:')}`);
  for (const step of result.steps) {
    const label =
      step.type === 'tool_call' ? `[tool] ${step.toolCall?.name ?? '?'}`
      : step.type === 'delegation' ? `[delegate] ${step.delegation?.agent ?? '?'}`
      : `[${step.type}]`;
    const preview = (step.content ?? step.toolCall?.name ?? '').slice(0, 80);
    console.log(`  ${c('dim', label)}  ${preview}`);
  }

  console.log(`\n${c('green', '✓ Done')}  (${result.steps.length} steps)\n`);
}

main().catch((err) => {
  console.error(c('red', `\n✗ Error: ${err instanceof Error ? err.message : String(err)}`));
  if (err instanceof Error && err.stack) {
    console.error(c('dim', err.stack.split('\n').slice(1).join('\n')));
  }
  process.exit(1);
});
