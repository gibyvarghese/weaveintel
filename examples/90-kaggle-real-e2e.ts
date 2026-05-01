/**
 * Example 90 — Real Kaggle Live-Agents E2E (LLM-driven)
 *
 * This example provisions a real Kaggle research mesh using your credentials and LLMs.
 * It:
 *   1. Boots the mesh with LLM-driven strategist
 *   2. Discovers real competitions
 *   3. Strategist (LLM) analyzes and proposes a modeling plan
 *   4. Implementer builds and pushes a real kernel
 *   5. Validator checks submission
 *   6. Submitter submits (with approval)
 *   7. Prints/logs all results
 *
 * Requirements:
 *   - KAGGLE_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY set in your environment
 *   - MCP server for Kaggle tools running and reachable
 *   - Approve kernel push and submission in admin UI when prompted
 */


import 'dotenv/config';
import { weaveSqliteStateStore, createLiveAgentsRuntime, createHeartbeat, createLiveAgentsRunLogger, createActionExecutor } from '@weaveintel/live-agents';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { bootKaggleMesh, createDbKagglePlaybookResolver } from '../apps/geneweave/src/live-agents/kaggle/index.js';
import { createKaggleRoleHandlers } from '../apps/geneweave/src/live-agents/kaggle/role-handlers.js';
import { seedKaggleArcPlaybook } from '../apps/geneweave/src/live-agents/kaggle/playbook-seed.js';
import { createDatabaseAdapter } from '@weaveintel/geneweave';

async function main() {
  // Use the correct async factory and path for the live-agents store
  const store = await weaveSqliteStateStore({ path: './live-agents.db' });

  // Open GeneWeave DB and seed (idempotent) the Kaggle playbooks. The
  // strategist's system prompt and the deterministic implementer's solver
  // template are loaded from this DB at runtime per competition slug.
  const geneweaveDbPath = process.env.DATABASE_PATH || './geneweave.db';
  const db = await createDatabaseAdapter({ type: 'sqlite', path: geneweaveDbPath });
  const seedResult = await seedKaggleArcPlaybook(db);
  console.log('Kaggle playbook seed:', seedResult);
  const playbookResolver = createDbKagglePlaybookResolver(db);
  const tenantId = process.env.KAGGLE_TENANT_ID || 'real-tenant';
  const kaggleUsername = process.env.KAGGLE_USERNAME || 'your-kaggle-username';
  const mcpUrl = process.env.KAGGLE_MCP_URL || 'http://localhost:8788/mcp';
  const humanOwnerId = process.env.KAGGLE_HUMAN_ID || 'human:' + kaggleUsername;
  const userMeshId = 'mesh-user-' + tenantId;



  // Boot mesh with LLM-driven strategist
  const result = await bootKaggleMesh({
    store,
    tenantId,
    kaggleUsername,
    mcpUrl,
    humanOwnerId,
    userMeshId,
    credentialVaultRef: 'env:KAGGLE_KEY',
    // strategistAttentionPolicy: createModelAttentionPolicy({ /* LLM config */ }),
  });

  const mesh = result.template.mesh;
  console.log(`Mesh provisioned: ${mesh.id}`);

  // Schedule the first discoverer backlog item to kick off the pipeline
  const discoverer = Object.values(result.template.agents).find(a => a.role === 'Competition Discoverer');
  if (discoverer) {
    const now = new Date().toISOString();
    await store.saveBacklogItem({
      id: `backlog-${discoverer.id}-initial-${Date.now()}`,
      agentId: discoverer.id,
      priority: 'NORMAL',
      status: 'PROPOSED',
      originType: 'SYSTEM',
      originRef: null,
      blockedOnMessageId: null,
      blockedOnGrantRequestId: null,
      blockedOnPromotionRequestId: null,
      blockedOnAccountBindingRequestId: null,
      estimatedEffort: 'PT1H',
      deadline: null,
      acceptedAt: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      title: 'Initial: Discover competitions',
      description: 'Kick off the pipeline by discovering Kaggle competitions.',
    });
    console.log('Scheduled initial discoverer backlog item.');
  } else {
    console.error('Could not find discoverer agent to schedule initial backlog item.');
  }

  // Start a heartbeat to drive the pipeline
  const runtime = createLiveAgentsRuntime({ stateStore: store });
  const workerId = 'worker-e2e-demo';
  // Dummy model for now; replace with LLM if needed
  const model = { id: 'noop', call: async () => ({ text: 'noop' }) };
  const runLogger = createLiveAgentsRunLogger();
  // Real LLM that drives the strategist's ReAct loop with Kaggle tools.
  // Default to Claude (Anthropic) — set KAGGLE_PLANNER_PROVIDER=openai to switch.
  const provider = (process.env.KAGGLE_PLANNER_PROVIDER || 'anthropic').toLowerCase();
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  let plannerModel;
  if (provider === 'openai') {
    if (!openaiKey) {
      console.error('OPENAI_API_KEY not set in env.');
      process.exit(1);
    }
    plannerModel = weaveOpenAIModel(process.env.KAGGLE_PLANNER_MODEL || 'gpt-4o', { apiKey: openaiKey });
  } else {
    if (!anthropicKey) {
      console.error('ANTHROPIC_API_KEY not set in env. The agentic strategist requires it (or set KAGGLE_PLANNER_PROVIDER=openai).');
      process.exit(1);
    }
    plannerModel = weaveAnthropicModel(process.env.KAGGLE_PLANNER_MODEL || 'claude-haiku-4-5', { apiKey: anthropicKey });
  }
  const taskHandlers = createKaggleRoleHandlers({ plannerModel, maxIterations: 5, playbookResolver });
  const actionExecutor = createActionExecutor({
    observability: { runLogger },
    taskHandlers,
  });
  const heartbeat = createHeartbeat({
    stateStore: store,
    workerId,
    concurrency: 1,
    model,
    actionExecutor,
    runOptions: { observability: { runLogger } },
  });

  // Helper: ensure each agent that has pending work has a SCHEDULED tick row.
  // The heartbeat only processes ticks that exist in the heartbeat_tick table;
  // backlog items alone won't kick anything off.
  async function ensureScheduledTicks(): Promise<number> {
    const agents = await store.listAgents(mesh.id);
    let scheduled = 0;
    const nowIso = new Date().toISOString();
    for (const agent of agents) {
      const [inbox, backlog] = await Promise.all([
        store.listMessagesForRecipient('AGENT', agent.id),
        store.listBacklogForAgent(agent.id),
      ]);
      const hasPendingMsg = inbox.some((m) => m.status === 'PENDING' || m.status === 'DELIVERED');
      const hasOpenBacklog = backlog.some((b) => b.status === 'PROPOSED' || b.status === 'ACCEPTED' || b.status === 'IN_PROGRESS');
      if (!hasPendingMsg && !hasOpenBacklog) continue;
      const tickId = `tick_${agent.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await store.saveHeartbeatTick({
        id: tickId,
        agentId: agent.id,
        scheduledFor: nowIso,
        pickedUpAt: null,
        completedAt: null,
        workerId: '',
        leaseExpiresAt: null,
        actionChosen: null,
        actionOutcomeProse: null,
        actionOutcomeStatus: null,
        status: 'SCHEDULED',
      });
      scheduled++;
    }
    return scheduled;
  }

  // Run the heartbeat for a fixed number of ticks or until pipeline completes
  let ticks = 0;
  const maxTicks = 120;
  let done = false;
  // Minimal execution context for heartbeat
  const ctx = { executionId: 'e2e-demo' };
  while (ticks < maxTicks && !done) {
    const scheduled = await ensureScheduledTicks();
    if (scheduled === 0) {
      console.log(`Tick #${ticks + 1}: nothing to schedule, pipeline idle.`);
      break;
    }
    // Run one heartbeat tick
    const tickResult = await heartbeat.tick(ctx);
    console.log(`Tick #${ticks + 1}: scheduled=${scheduled} processed=${tickResult.processed}`);
    ticks++;

    // Poll for progress: print messages and backlog items
    const agents = await store.listAgents(mesh.id);
    for (const agent of agents) {
      const inbox = await store.listMessagesForRecipient('AGENT', agent.id);
      const backlog = await store.listBacklogForAgent(agent.id);
      if (inbox.length > 0) {
        console.log(`  ${agent.role} inbox:`, inbox.map(m => ({ subject: m.subject, status: m.status })));
      }
      if (backlog.length > 0) {
        console.log(`  ${agent.role} backlog:`, backlog.map(b => ({ title: b.title, status: b.status })));
      }
      // Mark as done if submitter has completed a backlog item
      if (agent.role === 'Competition Submitter' && backlog.some(b => b.status === 'COMPLETED')) {
        done = true;
      }
    }
    // Slow the tick cadence so per-minute API budgets aren't blown by re-dispatches.
    await new Promise(r => setTimeout(r, 5_000));
  }

  if (done) {
    console.log('E2E pipeline completed! Check admin UI for full results.');
  } else {
    console.log('E2E pipeline did not complete within max ticks. Check admin UI for progress.');
  }
}

main().catch(console.error);
