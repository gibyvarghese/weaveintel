#!/usr/bin/env node

/**
 * Comprehensive Live-Agents Workflow Example
 * 
 * Demonstrates all core live-agents concepts in a realistic scenario:
 * - Mesh creation and agent spawning
 * - Account binding and permission boundaries
 * - Contract-driven evidence collection
 * - Cross-mesh collaboration via bridges
 * - Context compression for long-lived agents
 * - Heartbeat scheduling and tick execution
 * - MCP tool integration with credential scoping
 * 
 * Scenario: Research → Compliance → Legal team collaboration
 * 1. Research team discovers findings and saves contracts
 * 2. Compliance team reviews via bridge
 * 3. Legal team approves via second bridge
 * 4. Research agent compresses context daily
 * 5. Heartbeat scheduler coordinates all work
 */

import {
  createMesh,
  Mesh,
  Agent,
  Contract,
  Bridge,
  HeartbeatTick,
  StateStore,
  weaveInMemoryStateStore,
  Action,
  TickSpec,
} from '@weaveintel/live-agents';

// Mock StateStore for demo (use PostgresStateStore for production)
const stateStore = weaveInMemoryStateStore();

/**
 * Part 1: Setup meshes for three teams
 */
async function setupMeshes() {
  console.log('\n=== Part 1: Creating Team Meshes ===\n');

  const researchMesh = await createMesh('research-team', { stateStore });
  const complianceMesh = await createMesh('compliance-team', { stateStore });
  const legalMesh = await createMesh('legal-team', { stateStore });

  console.log(`✓ Created research mesh: ${researchMesh.id}`);
  console.log(`✓ Created compliance mesh: ${complianceMesh.id}`);
  console.log(`✓ Created legal mesh: ${legalMesh.id}`);

  return { researchMesh, complianceMesh, legalMesh };
}

/**
 * Part 2: Spawn agents with attention policies
 */
async function spawnAgents(meshes: {
  researchMesh: Mesh;
  complianceMesh: Mesh;
  legalMesh: Mesh;
}) {
  console.log('\n=== Part 2: Spawning Agents with Attention Policies ===\n');

  // Research agent: Compress daily at midnight, search for findings hourly
  const researcher = await meshes.researchMesh.spawnAgent('data-scientist', {
    instructions: `
You are a research analyst. Your job is to:
1. Search for scientific findings on coronavirus variants
2. Summarize key papers and their conclusions
3. Store findings as contracts with evidence
4. Daily: compress context to memory
    `,
    compressionStrategy: {
      window: 'daily',
      summaryPrompt: `Summarize today's research findings:
- Key papers reviewed
- Important conclusions
- Questions for tomorrow`,
      tokenBudget: 2000,
      retention: 90,
    },
    attentionPolicy: (agent) => {
      const now = new Date();
      const hour = now.getHours();
      const minute = now.getMinutes();
      const ticks: TickSpec[] = [];

      // Compress at midnight
      if (hour === 0 && minute === 0) {
        ticks.push(
          new TickSpec({
            action: new Action({ name: 'COMPRESS_CONTEXT' }),
            scheduledFor: now,
          })
        );
      }

      // Search for findings every 2 hours
      if (minute === 0 && hour % 2 === 0) {
        ticks.push(
          new TickSpec({
            action: new Action({
              name: 'SEARCH_FINDINGS',
              input: { query: 'COVID-19 variant transmissibility' },
            }),
            scheduledFor: now,
          })
        );
      }

      return ticks;
    },
  });

  // Compliance agent: Review all incoming research findings
  const reviewer = await meshes.complianceMesh.spawnAgent('compliance-officer', {
    instructions: `
You are a compliance reviewer. Your job is to:
1. Review research findings from the research team
2. Check for data quality and methodology soundness
3. Approve or request revisions
4. Pass approved findings to legal team
    `,
    attentionPolicy: (agent) => {
      // Check inbox every 30 minutes for new findings
      const now = new Date();
      const minute = now.getMinutes();
      if (minute === 0 || minute === 30) {
        return [
          new TickSpec({
            action: new Action({ name: 'CHECK_INBOX' }),
            scheduledFor: now,
          }),
        ];
      }
      return [];
    },
  });

  // Legal agent: Final approval and publication decision
  const counsel = await meshes.legalMesh.spawnAgent('legal-counsel', {
    instructions: `
You are a legal counsel. Your job is to:
1. Review approved compliance findings
2. Assess regulatory and liability risks
3. Make final publication decision
4. Archive approved findings
    `,
    attentionPolicy: (agent) => {
      // Check inbox daily at 9 AM
      const now = new Date();
      if (now.getHours() === 9 && now.getMinutes() === 0) {
        return [
          new TickSpec({
            action: new Action({ name: 'CHECK_INBOX' }),
            scheduledFor: now,
          }),
        ];
      }
      return [];
    },
  });

  console.log(`✓ Spawned researcher: ${researcher.id}`);
  console.log(`✓ Spawned reviewer: ${reviewer.id}`);
  console.log(`✓ Spawned counsel: ${counsel.id}`);

  return { researcher, reviewer, counsel };
}

/**
 * Part 3: Account binding (permission boundaries)
 */
async function setupAccountBindings(agents: {
  researcher: Agent;
  reviewer: Agent;
  counsel: Agent;
}) {
  console.log('\n=== Part 3: Account Binding (Permission Boundaries) ===\n');

  // Research team lead binds their email
  const researchLeadEmail = 'alice@company.com';
  await agents.researcher.bindAccount({
    accountId: researchLeadEmail,
    capabilities: ['SEND_EMAIL', 'READ_INBOX', 'WRITE_FINDINGS'],
    boundBy: 'alice@company.com', // Human-controlled binding
  });

  console.log(
    `✓ Bound ${researchLeadEmail} to researcher (READ/SEND/WRITE)`
  );

  // Compliance reviewer can only read and approve
  const complianceLeadEmail = 'bob@company.com';
  await agents.reviewer.bindAccount({
    accountId: complianceLeadEmail,
    capabilities: ['READ_FINDINGS', 'APPROVE_FINDINGS'],
    boundBy: 'bob@company.com',
  });

  console.log(
    `✓ Bound ${complianceLeadEmail} to reviewer (READ/APPROVE)`
  );

  // Legal counsel can only review and archive
  const legalLeadEmail = 'charlie@company.com';
  await agents.counsel.bindAccount({
    accountId: legalLeadEmail,
    capabilities: ['READ_FINDINGS', 'ARCHIVE_FINDINGS'],
    boundBy: 'charlie@company.com',
  });

  console.log(
    `✓ Bound ${legalLeadEmail} to counsel (READ/ARCHIVE)`
  );

  console.log(
    '\nKey point: Each agent can only use capabilities they were bound with.'
  );
  console.log(
    'Researcher cannot approve, reviewer cannot publish, counsel cannot research.'
  );
}

/**
 * Part 4: Create contracts (immutable work products)
 */
async function simulateResearchFindings(agents: {
  researcher: Agent;
  reviewer: Agent;
  counsel: Agent;
}) {
  console.log('\n=== Part 4: Create Research Finding Contracts ===\n');

  const finding = new Contract({
    type: 'RESEARCH_FINDING',
    statement:
      'Omicron XEC variant has 15% higher transmissibility than current dominant strain',
    evidence: [
      {
        tool: 'literature-search',
        result: {
          papers: ['Study A', 'Study B', 'Study C'],
          consensus: 'strong',
        },
      },
      {
        tool: 'data-analysis',
        result: {
          sampleSize: 10000,
          confidence: 0.95,
        },
      },
    ],
  });

  // Researcher saves finding locally
  await agents.researcher.execAction(finding, 'SAVE_CONTRACT');

  console.log(`✓ Researcher created finding: "${finding.statement}"`);
  console.log(`  - Evidence from 2 sources (literature + data)`);
  console.log(`  - Immutable (contracts are append-only)`);

  return finding;
}

/**
 * Part 5: Setup cross-mesh bridges for collaboration
 */
async function setupBridges(meshes: {
  researchMesh: Mesh;
  complianceMesh: Mesh;
  legalMesh: Mesh;
}) {
  console.log('\n=== Part 5: Setup Cross-Mesh Bridges ===\n');

  // Bridge 1: Research → Compliance
  // Only RESEARCH_FINDING type contracts cross this bridge
  const research2ComplianceBridge = new Bridge({
    sourceMeshId: meshes.researchMesh.id,
    targetMeshId: meshes.complianceMesh.id,
    messageFilter: (contract) => contract.type === 'RESEARCH_FINDING',
    authorized: false, // Pending compliance approval
  });

  await meshes.researchMesh.registerBridge(research2ComplianceBridge);
  console.log(
    `✓ Research → Compliance bridge created (awaiting approval)`
  );

  // Compliance team approves the bridge
  await meshes.complianceMesh.approveBridge(research2ComplianceBridge.id);
  console.log(`✓ Compliance team approved bridge`);

  // Bridge 2: Compliance → Legal
  // Only APPROVED_FINDING type contracts cross this bridge
  const compliance2LegalBridge = new Bridge({
    sourceMeshId: meshes.complianceMesh.id,
    targetMeshId: meshes.legalMesh.id,
    messageFilter: (contract) => contract.type === 'APPROVED_FINDING',
    authorized: false,
  });

  await meshes.complianceMesh.registerBridge(compliance2LegalBridge);
  console.log(
    `✓ Compliance → Legal bridge created (awaiting approval)`
  );

  await meshes.legalMesh.approveBridge(compliance2LegalBridge.id);
  console.log(`✓ Legal team approved bridge`);

  console.log(
    '\nKey point: Each mesh controls who sends to it. Bridges are asynchronous.'
  );
}

/**
 * Part 6: Simulate heartbeat scheduling
 */
async function simulateHeartbeatCycle(agents: {
  researcher: Agent;
  reviewer: Agent;
  counsel: Agent;
}) {
  console.log('\n=== Part 6: Heartbeat Scheduling ===\n');

  console.log(
    'Heartbeat runs every 10 minutes and asks each agent: "What should you do next?"'
  );
  console.log(
    'Agent attention policies respond with scheduled ticks (work items).'
  );

  console.log('\nExample heartbeat cycle:');
  console.log(
    '1. Heartbeat queries researcher.attentionPolicy(agent)'
  );
  console.log(
    '   → Response: [SEARCH_FINDINGS tick @ 2:00 PM, COMPRESS_CONTEXT tick @ midnight]'
  );
  console.log('2. Framework inserts ticks into database');
  console.log('3. Workers claim ticks atomically (no two workers claim same tick)');
  console.log('4. Workers execute ticks (run the action)');
  console.log('5. Ticks marked as COMPLETED or FAILED');

  console.log(
    '\nKey point: Agents work even when offline. Heartbeat resumes where they left off.'
  );
}

/**
 * Part 7: Context compression
 */
async function demonstrateCompression() {
  console.log('\n=== Part 7: Context Compression ===\n');

  console.log('Problem: After 6 months, researcher has:');
  console.log('  - 180 daily interactions');
  console.log('  - 2M+ tokens of raw history');
  console.log('  - $50+ in API costs just for context');

  console.log('\nSolution: Daily summaries');
  console.log('  - Day 1-180: 180 daily summaries × 2K tokens/day = 360K tokens');
  console.log('  - Plus: Recent 7 interactions (~10K tokens)');
  console.log('  - Total: 370K tokens (vs 2M without compression)');
  console.log('  - Cost: ~$4/month (vs $30+ without compression)');

  console.log('\nSchedule:');
  console.log('  - Daily: Summarize today\'s work at midnight');
  console.log('  - Weekly: (Optional) Summarize 7 daily summaries');
  console.log('  - Monthly: (Optional) Summarize 4 weekly summaries');
  console.log('  - Archive: Keep 90+ daily summaries for historical context');

  console.log('\nKey point: Automatic, predictable cost. Long-term memory preserved.');
}

/**
 * Part 8: MCP tool integration
 */
async function demonstrateMCPIntegration() {
  console.log('\n=== Part 8: MCP Tool Integration ===\n');

  console.log(
    'Agents call external tools via MCP (Model Context Protocol).'
  );
  console.log('Example: Researcher sends email with findings.\n');

  console.log('1. Researcher calls: agent.call("SEND_EMAIL", {...})');
  console.log(
    '2. Framework checks: Is "SEND_EMAIL" in researcher\'s account binding capabilities?'
  );
  console.log(
    '3. Yes: MCP tool executes with gmail_service_account_key env var'
  );
  console.log('4. Email sent via Gmail API');

  console.log('\nCredential scoping:');
  console.log(
    '  - Credentials live in environment variables (not in DB)'
  );
  console.log('  - Account bindings control which agent can use which account');
  console.log(
    '  - MCP fixtures enable testing without real API calls'
  );

  console.log(
    '\nSecurity: Only humans bind accounts. Agents cannot self-grant capabilities.'
  );
}

/**
 * Part 9: StateStore patterns
 */
async function demonstrateStateStore() {
  console.log('\n=== Part 9: StateStore Persistence ===\n');

  console.log('StateStore is the persistence boundary.');
  console.log('Applications implement StateStore to bring their own DB.\n');

  console.log('Shipped implementations:');
  console.log('  1. InMemoryStateStore (dev/testing only)');
  console.log('  2. RedisStateStore (ephemeral leasing)');
  console.log(
    '  3. PostgresStateStore (production, see apps/live-agents-demo)'
  );

  console.log('\nProxy pattern (recommended):');
  console.log('  - Ephemeral store (Redis): Fast leasing for heartbeat');
  console.log('  - Durable store (Postgres): Audit trail and contracts');
  console.log('  - Keeps both in sync via hooks');

  console.log('\nKey tables:');
  console.log('  - meshes: Mesh state (id, agents)');
  console.log('  - agents: Agent state (id, instructions, bindings)');
  console.log('  - contracts: Immutable work products');
  console.log('  - messages: Inter-agent messages');
  console.log('  - heartbeat_ticks: Scheduled work items');
  console.log('  - account_bindings: Permission boundaries');
}

/**
 * Main entry point
 */
async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Live-Agents Comprehensive Workflow Example            ║');
  console.log('║  Research → Compliance → Legal Team Collaboration     ║');
  console.log('╚════════════════════════════════════════════════════════╝');

  try {
    // 1. Setup meshes
    const meshes = await setupMeshes();

    // 2. Spawn agents
    const agents = await spawnAgents(meshes);

    // 3. Setup account bindings
    await setupAccountBindings(agents);

    // 4. Create contracts
    await simulateResearchFindings(agents);

    // 5. Setup bridges
    await setupBridges(meshes);

    // 6. Explain heartbeat
    await simulateHeartbeatCycle(agents);

    // 7. Explain compression
    await demonstrateCompression();

    // 8. Explain MCP
    await demonstrateMCPIntegration();

    // 9. Explain StateStore
    await demonstrateStateStore();

    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║  Summary                                               ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    console.log('This example demonstrated:');
    console.log('  ✓ Mesh creation and agent spawning');
    console.log('  ✓ Account binding (permission boundaries)');
    console.log('  ✓ Contracts (immutable work products)');
    console.log('  ✓ Cross-mesh bridges (team collaboration)');
    console.log('  ✓ Heartbeat scheduling (continuous work)');
    console.log('  ✓ Context compression (cost reduction)');
    console.log('  ✓ MCP integration (external tools)');
    console.log('  ✓ StateStore persistence (durability)');

    console.log('\nFor more details, see:');
    console.log('  - docs/live-agents/README.md — Framework overview');
    console.log('  - docs/live-agents/use-cases.md — Six production scenarios');
    console.log('  - docs/live-agents/account-model.md — Security model');
    console.log(
      '  - docs/live-agents/ADR/ — Architectural decision records'
    );
    console.log('  - apps/live-agents-demo — Reference implementation');

    console.log('\n✓ Example completed successfully!\n');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
