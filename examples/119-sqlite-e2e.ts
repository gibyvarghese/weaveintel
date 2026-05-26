/**
 * Example 119 — SQLite-backed conversation persistence + @weaveintel/skills +
 *               @weaveintel/memory end-to-end (in-process :memory: DB, no API keys).
 *
 * PROBLEM THIS EXAMPLE SOLVES
 * ----------------------------
 * A production AI assistant needs durable conversation history so that:
 *
 *   1. A process restart does not erase context.
 *   2. Skill activation can be informed by what was already said.
 *   3. Semantic and entity memory complement structured conversation logs —
 *      each layer answers different retrieval queries.
 *
 * This example shows an adopter how to wire all three layers together in a
 * production-style setup, using SQLite (via better-sqlite3) as the backbone:
 *
 *   - A **custom SQLite conversation store** — a hand-rolled table
 *     (messages: id, role, content, created_at) that gives the adopter full
 *     control of schema, indexes, and retention policies.
 *
 *   - **@weaveintel/skills** — `createSkillRegistry` + `activateSkills` +
 *     `collectSkillTools` determine which skills are relevant to each user
 *     message.  Skills are re-evaluated on every turn so context changes can
 *     change which capabilities are surfaced.
 *
 *   - **@weaveintel/memory** in-memory stores — `weaveConversationMemory`,
 *     `weaveSemanticMemory`, and `weaveEntityMemory` run alongside the SQLite
 *     store, illustrating the tradeoff between each memory strategy:
 *       • weaveConversationMemory  — ordered message history (like SQLite, but
 *         purely in-memory; useful for unit tests and ephemeral sessions).
 *       • weaveSemanticMemory      — embedding-based fuzzy recall.
 *       • weaveEntityMemory        — named-fact key-value lookup.
 *
 *   - A **"full turn" loop** that models the production request/response cycle:
 *       user message → SQLite insert → retrieve recent context →
 *       skill activation → response generated → SQLite insert.
 *
 * Run: `npx tsx examples/119-sqlite-e2e.ts`
 */

import assert from 'node:assert/strict';

// better-sqlite3 is a synchronous SQLite binding — no async/await needed for
// DB operations, which simplifies the control flow considerably.
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

import {
  createSkillRegistry,
  activateSkills,
  collectSkillTools,
  type SkillDefinition,
  type SkillActivationResult,
} from '@weaveintel/skills';

import {
  weaveConversationMemory,
  weaveSemanticMemory,
  weaveEntityMemory,
} from '@weaveintel/memory';

import { weaveContext } from '@weaveintel/core';
import { weaveFakeEmbedding } from '@weaveintel/testing';

// ── Presentation helpers ──────────────────────────────────────────────────────

const PASS = '[32m✓[0m';
const DIM  = '[2m';
const RESET = '[0m';

function section(title: string): void {
  console.log(`\n${'─'.repeat(65)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(65));
}

function ok(label: string): void {
  console.log(`  ${PASS} ${label}`);
}

function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

// ── SQLite conversation store ─────────────────────────────────────────────────

/**
 * The shape of a row returned from the messages table.
 * We deliberately keep this simple — real adopters add columns like
 * tenant_id, session_id, model_id, token_count, etc.
 */
interface MessageRow {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;  // ISO-8601 string stored as TEXT
}

/**
 * createSqliteConversationStore — wraps a better-sqlite3 Database instance
 * with the three operations needed for a conversation loop:
 *   - insert(row)         — write one message turn
 *   - listAll()           — retrieve all messages ordered by creation time
 *   - listRecent(n)       — retrieve the n most recent messages (latest last)
 *
 * WHY better-sqlite3: it ships as a native Node addon and is already a
 * dependency of geneweave.  Its synchronous API avoids the async overhead of
 * database/sql drivers, which is ideal for in-process usage.
 */
function createSqliteConversationStore(db: DatabaseType) {
  // CREATE TABLE IF NOT EXISTS — safe to call on every startup; idempotent.
  // TEXT affinity for all columns: SQLite stores them efficiently and we never
  // need numeric comparisons on these fields.
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Prepare statements once at construction time — better-sqlite3 caches the
  // compiled bytecode, so repeated calls are faster than repeated db.prepare().
  const insertStmt = db.prepare<[string, string, string, string]>(
    'INSERT INTO messages (id, role, content, created_at) VALUES (?, ?, ?, ?)',
  );

  // ORDER BY created_at ensures chronological order even if ids are not
  // sequential (e.g., when using UUID v7 or random ids).
  const selectAllStmt = db.prepare<[], MessageRow>(
    'SELECT id, role, content, created_at FROM messages ORDER BY created_at ASC',
  );

  // LIMIT applied in SQL rather than JS to keep large histories off the heap.
  // We use a sub-query trick so "recent" means the *last* n rows, still
  // returned oldest-first so the LLM context reads naturally.
  const selectRecentStmt = db.prepare<[number], MessageRow>(`
    SELECT id, role, content, created_at
    FROM (
      SELECT id, role, content, created_at
      FROM messages
      ORDER BY created_at DESC
      LIMIT ?
    )
    ORDER BY created_at ASC
  `);

  let counter = 0;

  return {
    /**
     * Insert one message.  Generates a simple sequential id with a timestamp
     * prefix to guarantee created_at ordering even within the same millisecond.
     */
    insert(role: MessageRow['role'], content: string): MessageRow {
      const id = `msg_${Date.now()}_${++counter}`;
      const created_at = new Date().toISOString();
      insertStmt.run(id, role, content, created_at);
      return { id, role, content, created_at };
    },

    /**
     * Return every message, oldest first.
     * better-sqlite3's .all() returns a plain JS array synchronously.
     */
    listAll(): MessageRow[] {
      return selectAllStmt.all();
    },

    /**
     * Return the n most recent messages, oldest first.
     * Passing limit via prepared statement prevents SQL injection and reuses
     * the compiled plan.
     */
    listRecent(n: number): MessageRow[] {
      return selectRecentStmt.all(n);
    },
  };
}

// ── Skill fixtures ────────────────────────────────────────────────────────────

/**
 * A data-analysis skill that should activate for queries about numbers, stats,
 * or aggregations.  toolNames lists what the orchestrator may call when this
 * skill is active.
 */
const dataAnalysisSkill: SkillDefinition = {
  id: 'skill-data-analysis',
  name: 'Data Analysis',
  category: 'analysis',
  summary: 'Answers quantitative questions by running aggregations, statistics, and trend analysis.',
  whenToUse: 'Use when the user asks about data, metrics, statistics, counts, or trends.',
  executionGuidance: 'Query the relevant dataset, compute the requested aggregations, and present results clearly.',
  toolNames: ['query_engine', 'chart_renderer'],
  triggerPatterns: ['data', 'statistics', 'metrics', 'analysis', 'aggregate'],
  priority: 80,
};

/**
 * A research-synthesis skill that activates on open-ended knowledge questions.
 */
const researchSynthesisSkill: SkillDefinition = {
  id: 'skill-research-synthesis',
  name: 'Research Synthesis',
  category: 'research',
  summary: 'Synthesises background knowledge, literature, and definitions into concise notes.',
  whenToUse: 'Use when the user asks for explanations, definitions, or background research.',
  executionGuidance: 'Compose a prose answer that cites sources and acknowledges uncertainty.',
  toolNames: ['web_search', 'knowledge_base'],
  triggerPatterns: ['research', 'explain', 'what is', 'background', 'summary'],
  priority: 60,
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\nSQLite + @weaveintel/skills + @weaveintel/memory — production-style turn loop\n');

  // ════════════════════════════════════════════════════════════════════════════
  // 1. Open an in-process SQLite database
  // ════════════════════════════════════════════════════════════════════════════
  section('1. Open in-process SQLite database (":memory:")');

  // ":memory:" tells better-sqlite3 to keep everything in RAM.
  // Replace with a file path (e.g. "/tmp/weave-chat.db") for disk persistence.
  // The constructor is synchronous — no await needed.
  const db: DatabaseType = new Database(':memory:');

  // Enable WAL journal mode for better concurrent read performance.
  // In a :memory: database this is a no-op, but it's good practice to always
  // set it so the code works unchanged when switched to a file path.
  db.pragma('journal_mode = WAL');

  ok('SQLite opened at ":memory:" with WAL mode');

  // ════════════════════════════════════════════════════════════════════════════
  // 2. Create the custom SQLite conversation store
  // ════════════════════════════════════════════════════════════════════════════
  section('2. Create messages table and verify insert / list');

  // createSqliteConversationStore runs CREATE TABLE IF NOT EXISTS on init and
  // returns an object with insert() / listAll() / listRecent() methods.
  const sqliteStore = createSqliteConversationStore(db);
  ok('messages table created');

  // Insert a system prompt — always the first message in a session.
  const systemMsg = sqliteStore.insert(
    'system',
    'You are a helpful assistant for WeaveIntel data analysis workflows.',
  );
  ok(`Inserted system message: id="${systemMsg.id}"`);

  // Insert a user turn.
  const firstUserMsg = sqliteStore.insert(
    'user',
    'Can you explain what statistical analysis means for our sales data?',
  );
  ok(`Inserted user message: id="${firstUserMsg.id}"`);

  // Verify the table has exactly two rows.
  const allAfterTwo = sqliteStore.listAll();
  assert.equal(allAfterTwo.length, 2);
  ok(`listAll() returns ${allAfterTwo.length} rows (system + first user)`);

  // Verify ordering — system message should appear first.
  assert.equal(allAfterTwo[0]!.role, 'system');
  assert.equal(allAfterTwo[1]!.role, 'user');
  ok(`Row ordering is chronological: [${allAfterTwo.map((r) => r.role).join(', ')}]`);

  // Verify listRecent(1) returns only the most recent message.
  const recentOne = sqliteStore.listRecent(1);
  assert.equal(recentOne.length, 1);
  assert.equal(recentOne[0]!.id, firstUserMsg.id);
  ok(`listRecent(1) returns the most recent row: role="${recentOne[0]!.role}"`);

  // ════════════════════════════════════════════════════════════════════════════
  // 3. Set up @weaveintel/skills on top of the SQLite store
  // ════════════════════════════════════════════════════════════════════════════
  section('3. @weaveintel/skills — activate skills based on conversation context');

  // createSkillRegistry() keeps all registered skills in a private Map.
  // There is no global singleton — each call returns an independent registry,
  // making multi-tenant and test isolation trivial.
  const skillRegistry = createSkillRegistry();
  skillRegistry.register(dataAnalysisSkill);
  skillRegistry.register(researchSynthesisSkill);
  ok(`Registered ${skillRegistry.list().length} skills`);

  // Retrieve the most recent user message from SQLite — this is the "context"
  // fed to skill activation.  In production you might concatenate the last N
  // messages or use a summarised working-memory window.
  const recentContext = sqliteStore.listRecent(5);
  const latestUserContent = recentContext.filter((r) => r.role === 'user').at(-1)?.content ?? '';
  ok(`Query for skill activation: "${latestUserContent.slice(0, 80)}"`);

  // activateSkills() scores every registered skill against the query using
  // semantic similarity and returns a SkillActivationResult describing which
  // skills were considered, selected, and rejected.
  const activation: SkillActivationResult = await activateSkills(
    latestUserContent,
    skillRegistry.list(),
    {
      mode: 'reasoning_support',
      maxSelected: 2,      // at most 2 skills active at once
      minScore: 0.10,      // low threshold to show both skills can match
    },
  );

  ok(`activateSkills() considered=${activation.considered.length}, selected=${activation.selected.length}`);
  for (const match of activation.selected) {
    ok(`  Selected skill: "${match.skill.name}" (score=${match.score.toFixed(3)}, source=${match.source})`);
    console.log(dim(`      rationale: ${match.rationale}`));
  }

  // collectSkillTools() merges the toolNames from all selected skills into a
  // deduplicated list, respecting allowedTools and disallowedTools policies.
  // The orchestrator uses this list to filter which tools the LLM may call.
  const activatedTools = collectSkillTools(activation.selected);
  ok(`collectSkillTools() → [${activatedTools.join(', ')}]`);

  // ════════════════════════════════════════════════════════════════════════════
  // 4. @weaveintel/memory in-memory stores alongside the SQLite store
  // ════════════════════════════════════════════════════════════════════════════
  section('4. @weaveintel/memory — in-memory stores alongside SQLite');

  // Shared ExecutionContext — weaveContext() from @weaveintel/core builds
  // the minimal context object that all memory and tool functions require.
  // In production this carries tenantId, userId, and a per-request executionId.
  const ctx = weaveContext({
    userId: 'user-example-119',
    tenantId: 'tenant-acme',
    metadata: { sessionId: 'session-sqlite-demo' },
  });

  // ── 4a. weaveConversationMemory — in-memory ordered message history ──

  // weaveConversationMemory() mirrors what the SQLite store does but lives
  // purely in RAM.  It is ideal for:
  //   • Unit tests (no file I/O, fast)
  //   • Ephemeral chat sessions (browser REPL, interactive notebooks)
  //   • Comparison baselines when benchmarking SQLite overhead
  const convMemory = weaveConversationMemory({ maxHistory: 50 });

  // addMessage() accepts (ctx, role, content) or (ctx, Message) — both signatures work.
  await convMemory.addMessage(ctx, 'user', 'What is statistical analysis?');
  await convMemory.addMessage(ctx, 'assistant', 'Statistical analysis is the process of...');
  await convMemory.addMessage(ctx, 'user', 'Can you show me an example with sales data?');

  const convMessages = await convMemory.getMessages(ctx);
  assert.equal(convMessages.length, 3);
  ok(`weaveConversationMemory: ${convMessages.length} messages stored in RAM`);
  ok(`  last message: role="${convMessages.at(-1)!.role}", content="${String(convMessages.at(-1)!.content).slice(0, 50)}"`);

  // getHistory() returns MemoryEntry objects (with id, type, createdAt) instead
  // of raw Message objects — useful when passing to the memory store's query API.
  const historyEntries = await convMemory.getHistory(ctx, 2);
  assert.equal(historyEntries.length, 2);
  ok(`getHistory(ctx, 2) returns ${historyEntries.length} MemoryEntry objects`);

  // ── 4b. weaveSemanticMemory — embedding-based fuzzy recall ──

  // weaveFakeEmbedding() produces deterministic pseudo-embeddings based on a
  // content hash — no OpenAI / Anthropic API call required.  Dimensions default
  // to 384 to match common embedding model output sizes.
  const fakeEmbedder = weaveFakeEmbedding({ dimensions: 384 });
  const semanticMem = weaveSemanticMemory(fakeEmbedder);

  // Store facts as semantic memories so they can be recalled by similarity.
  await semanticMem.store(ctx, 'Sales data shows a 12% YoY growth in Q3 2025.', { source: 'report-q3' });
  await semanticMem.store(ctx, 'Customer churn rate dropped to 3.2% after product improvements.', { source: 'cs-metrics' });
  await semanticMem.store(ctx, 'Statistical analysis involves descriptive and inferential methods.', { source: 'wiki' });
  ok('weaveSemanticMemory: stored 3 facts with fake embeddings');

  // recall() embeds the query with the same fakeEmbedder and returns the top-K
  // most similar stored memories by cosine distance.  With fake embeddings the
  // similarity scores are hash-based, so results are deterministic.
  const recalled = await semanticMem.recall(ctx, 'quarterly sales growth statistics', 2);
  ok(`recall('quarterly sales growth statistics', topK=2) → ${recalled.length} result(s)`);
  for (const entry of recalled) {
    console.log(dim(`      id="${entry.id}", content="${entry.content.slice(0, 60)}"`));
  }

  // ── 4c. weaveEntityMemory — named-fact key-value lookup ──

  // weaveEntityMemory() stores structured facts about named entities.
  // It is ideal for user preferences, account attributes, and other
  // well-scoped facts that don't need fuzzy recall.
  const entityMem = weaveEntityMemory();

  // upsertEntity() merges new facts with any existing facts for the same name.
  await entityMem.upsertEntity(ctx, 'ACME Corp', {
    industry: 'Software',
    employeeCount: 500,
    plan: 'enterprise',
  });
  await entityMem.upsertEntity(ctx, 'ACME Corp', {
    // Subsequent upsert merges into existing record — employeeCount is preserved.
    dataRetentionDays: 90,
  });

  // getEntity() retrieves a specific entity by exact name match.
  const acme = await entityMem.getEntity(ctx, 'ACME Corp');
  assert.ok(acme !== undefined, 'ACME Corp entity should exist');
  assert.equal(acme!.metadata['industry'], 'Software');
  assert.equal(acme!.metadata['dataRetentionDays'], 90);
  ok(`weaveEntityMemory: getEntity('ACME Corp') → ${JSON.stringify(acme!.metadata)}`);

  // searchEntities() does a keyword scan across all entity names in the store.
  await entityMem.upsertEntity(ctx, 'ACME Sales Team', { headcount: 42 });
  const acmeEntities = await entityMem.searchEntities(ctx, 'ACME');
  ok(`searchEntities('ACME') → ${acmeEntities.length} entity(ies) found`);

  // ════════════════════════════════════════════════════════════════════════════
  // 5. Full turn loop — user message → SQLite → skill activation → response
  // ════════════════════════════════════════════════════════════════════════════
  section('5. Full turn loop — 3 conversation turns');

  /**
   * simulateTurn() models one request/response cycle:
   *   1. Insert the user message into SQLite.
   *   2. Retrieve recent context from SQLite.
   *   3. Activate skills against the user message.
   *   4. Generate a stub response (would be replaced by an LLM call in prod).
   *   5. Insert the assistant response into SQLite.
   *   6. Mirror both messages to weaveConversationMemory for in-memory access.
   *
   * This function is deliberately kept short; a production version would also:
   *   - Feed the SQLite context + semantic recall into the model's system prompt.
   *   - Pass collectSkillTools() output to the tool-calling loop.
   *   - Commit telemetry on skill selection.
   */
  async function simulateTurn(
    userMessage: string,
    turnIndex: number,
  ): Promise<{ skillsSelected: number; responseStored: boolean }> {
    // Step 1: Persist the user message to SQLite.
    const userRow = sqliteStore.insert('user', userMessage);
    console.log(`\n  [Turn ${turnIndex}] User: "${userMessage}"`);

    // Step 2: Retrieve the last 10 messages as conversation context.
    // In production this window would be token-budget-aware.
    const context = sqliteStore.listRecent(10);
    const contextSummary = context.map((r) => `${r.role}: ${r.content.slice(0, 40)}`).join(' | ');
    console.log(dim(`    context window: ${context.length} rows — [${contextSummary.slice(0, 100)}…]`));

    // Step 3: Activate skills against the user's message.
    // We pass the user message directly; a production system might concatenate
    // the last few turns to give semantic matching more signal.
    const turnActivation = await activateSkills(userMessage, skillRegistry.list(), {
      mode: 'reasoning_support',
      maxSelected: 2,
      minScore: 0.05,
    });
    console.log(dim(`    skills activated: ${turnActivation.selected.map((m) => m.skill.name).join(', ') || 'none'}`));

    // Step 4: Generate a deterministic stub response (replaces LLM call).
    // We embed the skill names in the response so we can assert on them later.
    const skillNames = turnActivation.selected.map((m) => m.skill.name).join(', ');
    const stubResponse = skillNames
      ? `[Stub response for turn ${turnIndex}, skills active: ${skillNames}] — analysed your request.`
      : `[Stub response for turn ${turnIndex}, no skills matched] — general reply.`;

    // Step 5: Persist the assistant response to SQLite.
    const assistantRow = sqliteStore.insert('assistant', stubResponse);
    console.log(`  [Turn ${turnIndex}] Assistant: "${stubResponse.slice(0, 80)}"`);

    // Step 6: Mirror both messages to weaveConversationMemory so in-memory
    // consumers (e.g., a semantic memory extraction pipeline) see them too.
    await convMemory.addMessage(ctx, 'user', userMessage);
    await convMemory.addMessage(ctx, 'assistant', stubResponse);

    assert.ok(userRow.id.length > 0);
    assert.ok(assistantRow.id.length > 0);

    return {
      skillsSelected: turnActivation.selected.length,
      responseStored: true,
    };
  }

  // Run three turns with progressively specific queries.
  const turn1 = await simulateTurn(
    'What is statistical analysis and how does it apply to sales?',
    1,
  );
  ok(`Turn 1: skillsSelected=${turn1.skillsSelected}, responseStored=${turn1.responseStored}`);

  const turn2 = await simulateTurn(
    'Show me a detailed breakdown of quarterly revenue trends.',
    2,
  );
  ok(`Turn 2: skillsSelected=${turn2.skillsSelected}, responseStored=${turn2.responseStored}`);

  const turn3 = await simulateTurn(
    'Summarise the key research findings on customer retention.',
    3,
  );
  ok(`Turn 3: skillsSelected=${turn3.skillsSelected}, responseStored=${turn3.responseStored}`);

  // ── Verify the SQLite store now holds all messages ──────────────────────────

  // We started with 1 system + 1 user (from step 2), then added 3 turns each
  // with 1 user + 1 assistant = 6 messages.  Total = 2 + 6 = 8.
  const finalHistory = sqliteStore.listAll();
  assert.equal(finalHistory.length, 8, `Expected 8 rows, got ${finalHistory.length}`);
  ok(`SQLite final row count: ${finalHistory.length} messages`);

  // Verify role distribution.
  const roleCounts = finalHistory.reduce<Record<string, number>>((acc, row) => {
    acc[row.role] = (acc[row.role] ?? 0) + 1;
    return acc;
  }, {});
  ok(`Role distribution: ${JSON.stringify(roleCounts)}`);
  assert.equal(roleCounts['system'], 1);
  assert.equal(roleCounts['user'], 4);    // 1 seed + 3 turns
  assert.equal(roleCounts['assistant'], 3);

  // ── Verify weaveConversationMemory mirrors the turn messages ────────────────

  // We added 3 user messages from simulateTurn calls (plus the 3 from step 4a),
  // and 3 assistant messages.  The first 3 messages added in section 4a are
  // also present (2 user + 1 assistant).
  const finalConvMessages = await convMemory.getMessages(ctx);
  // section 4a: 3 messages; turns: 2 × 3 = 6 messages => total 9
  assert.equal(finalConvMessages.length, 9, `Expected 9 in-memory conv messages, got ${finalConvMessages.length}`);
  ok(`weaveConversationMemory: ${finalConvMessages.length} messages (mirrors turns + section 4a seed)`);

  // ── Side-by-side comparison summary ────────────────────────────────────────
  console.log('\n  COMPARISON: SQLite vs weaveConversationMemory vs weaveSemanticMemory');
  console.log(dim('  ┌──────────────────────────────────┬──────────┬─────────┐'));
  console.log(dim('  │ Store                            │ Messages │ Notes   │'));
  console.log(dim('  ├──────────────────────────────────┼──────────┼─────────┤'));
  console.log(dim(`  │ SQLite (custom messages table)   │    ${String(finalHistory.length).padStart(4)}  │ durable │`));
  console.log(dim(`  │ weaveConversationMemory (RAM)    │    ${String(finalConvMessages.length).padStart(4)}  │ ephemeral│`));
  console.log(dim(`  │ weaveSemanticMemory (RAM+embeds) │       3  │ fuzzy   │`));
  console.log(dim(`  │ weaveEntityMemory (RAM+facts)    │       2  │ keyed   │`));
  console.log(dim('  └──────────────────────────────────┴──────────┴─────────┘'));

  // ── Close the SQLite connection cleanly ────────────────────────────────────
  // Always close the DB before process exit to flush WAL and release the file
  // lock.  With :memory: this is a no-op for state but still good practice.
  db.close();
  ok('SQLite connection closed cleanly');

  // ════════════════════════════════════════════════════════════════════════════
  // Done
  // ════════════════════════════════════════════════════════════════════════════
  console.log(`\n${'═'.repeat(65)}`);
  console.log('  All SQLite + skills + memory assertions passed.');
  console.log(`${'═'.repeat(65)}\n`);
}

// Exit with code 1 on any unexpected error so CI picks it up.
main().catch((err: unknown) => {
  console.error('\n[FATAL]', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
