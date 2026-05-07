/**
 * 98 — DB-driven declarative `prepare()` recipes for live agents.
 *
 * Phase 2 of the DB-driven capability plan introduces JSON recipes for
 * the live-agent `prepare()` step. Instead of hand-writing the closure
 * that builds `{ systemPrompt, userGoal, tools }` for every agent, you
 * store a small JSON recipe on `live_agents.prepare_config_json` and the
 * runtime synthesises an equivalent `prepare()` automatically.
 *
 * This example demonstrates three recipe shapes end-to-end with stubs —
 * no SQLite, no LLM, no external services. Run with:
 *
 *   npx tsx examples/98-live-agent-db-prepare.ts
 *
 * What it shows:
 *   1. Literal recipe — `systemPrompt` + `userGoal` are inline strings.
 *   2. Prompt-key recipe — `systemPrompt` references a registered prompt
 *      key; `resolvePromptText` (injected via `PrepareResolutionDeps`)
 *      pulls the text from your prompt registry.
 *   3. Inbound-template recipe — `userGoal` is built from inbound
 *      message fields via `{{subject}}` / `{{body}}` interpolation.
 *
 * Caller-supplied `prepare()` (passed through `weaveLiveAgent`) ALWAYS
 * wins over the recipe — this is the back-compat invariant. The recipe
 * path is the default when no custom prepare exists.
 */

import {
  parsePrepareConfig,
  dbPrepareFromConfig,
  type PrepareResolutionDeps,
} from '@weaveintel/live-agents-runtime';

async function main(): Promise<void> {
  const inbound = {
    subject: 'Quarterly review',
    body: 'Please summarise Q3 results and flag any risks.',
  };

  // ─── 1. Literal recipe ─────────────────────────────────────
  console.log('\n── 1. Literal recipe ─────────────────────────');
  {
    const raw = JSON.stringify({
      systemPrompt: 'You are a careful financial analyst.',
      userGoal: 'Summarise the inbound report in 3 bullets.',
    });
    const config = parsePrepareConfig(raw);
    if (!config) throw new Error('expected non-null config');
    const { prepare } = dbPrepareFromConfig(config, {});
    const out = await prepare({ inbound });
    console.log('systemPrompt →', out.systemPrompt);
    console.log('userGoal     →', out.userGoal);
  }

  // ─── 2. Prompt-key recipe with injected resolver ───────────
  console.log('\n── 2. Prompt-key recipe (resolvePromptText) ──');
  {
    // In production this would be `db.listPromptFragments()` /
    // `db.listPrompts()` — the resolver is whatever your app already
    // uses to pull prompt text out of its registry.
    const promptRegistry: Record<string, string> = {
      'live-agent.observer':
        'You are a long-running observer. Track patterns; flag anomalies.',
    };
    const deps: PrepareResolutionDeps = {
      resolvePromptText: async (key) => promptRegistry[key] ?? '',
      defaultSystemPrompt: 'You are a helpful assistant.',
    };

    const raw = JSON.stringify({
      systemPrompt: { promptKey: 'live-agent.observer' },
      userGoal: { from: 'inbound.body' },
    });
    const config = parsePrepareConfig(raw);
    if (!config) throw new Error('expected non-null config');
    const { prepare } = dbPrepareFromConfig(config, deps);
    const out = await prepare({ inbound });
    console.log('systemPrompt →', out.systemPrompt);
    console.log('userGoal     →', out.userGoal);
  }

  // ─── 3. Template recipe ────────────────────────────────────
  console.log('\n── 3. Inbound-template recipe ────────────────');
  {
    const raw = JSON.stringify({
      systemPrompt: 'You are a triage assistant.',
      userGoal: {
        template:
          'Subject: {{subject}}\n\nBody:\n{{body}}\n\nClassify and route.',
      },
    });
    const config = parsePrepareConfig(raw);
    if (!config) throw new Error('expected non-null config');
    const { prepare } = dbPrepareFromConfig(config, {});
    const out = await prepare({ inbound });
    console.log('systemPrompt →', out.systemPrompt);
    console.log('userGoal     →', out.userGoal);
  }

  // ─── 4. Empty / null recipe → null (caller falls back) ─────
  console.log('\n── 4. Empty recipe parses as null ────────────');
  console.log('parsePrepareConfig(null)  →', parsePrepareConfig(null));
  console.log('parsePrepareConfig("{}")  →', parsePrepareConfig('{}'));

  console.log('\n✅ Phase 2 (DB-driven prepare) demo complete.\n');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
