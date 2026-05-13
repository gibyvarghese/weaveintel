/**
 * Example 107 — Cost Governor Phase 6: Intel-Gated Prompt Sections (L4) +
 *                History Compaction (L5).
 *
 * Pure in-memory demo. No DB, no LLM, no external services. Demonstrates:
 *
 *   1. `decideIntelGating` — pure decision over (config, score).
 *   2. `weaveIntelGate` — `CostPromptShaper` returning `PromptShape | null`.
 *   3. `shouldKeepSection` — section-key consumer helper.
 *   4. `decideCompaction` — pure decision over (history, config).
 *   5. `weaveHistoryCompactor` — slot returned by the governor bundle.
 *   6. End-to-end via `weaveCostGovernor(policy, { intelScoreProvider, historySummarizer })`.
 *   7. Tier-preset behavior (balanced enables both; max disables both).
 *
 * Run with:  npx tsx examples/107-intel-history.ts
 */

import {
  decideIntelGating,
  weaveIntelGate,
  shouldKeepSection,
  INTEL_HEADER_SECTION,
  INTEL_SNIPPETS_SECTION,
  decideCompaction,
  weaveCostGovernor,
  type IntelScoreProvider,
  type HistorySummarizer,
  type HistoryItem,
  type CostPolicy,
} from '@weaveintel/cost-governor';

const banner = (title: string) => console.log(`\n══ ${title} ${'═'.repeat(Math.max(0, 60 - title.length))}`);

// ── 1. Pure intel-gating decision table ──────────────────────────────
banner('1. decideIntelGating — pure decision');
const cfg = { enabled: true, thresholds: { low: 0.4, high: 0.7 } };
for (const score of [null, 0.2, 0.5, 0.8] as const) {
  const d = decideIntelGating(cfg, score);
  console.log(
    `  score=${String(score).padEnd(5)} → keepHeader=${String(d.keepIntelHeader).padEnd(5)} keepSnippets=${String(d.keepSnippets).padEnd(5)} reason=${d.reason}`,
  );
}

// ── 2. weaveIntelGate as a CostPromptShaper ──────────────────────────
banner('2. weaveIntelGate — PromptShape | null per call');
const stubProvider = (score: number | null): IntelScoreProvider => ({ compute: () => score });
const gateLow = weaveIntelGate(cfg, stubProvider(0.2));
const gateMid = weaveIntelGate(cfg, stubProvider(0.5));
const gateHigh = weaveIntelGate(cfg, stubProvider(0.8));
console.log('  score=0.2 →', await gateLow({ meshId: 'm1' }));
console.log('  score=0.5 →', await gateMid({ meshId: 'm1' }));
console.log('  score=0.8 →', await gateHigh({ meshId: 'm1' }));

// ── 3. shouldKeepSection consumer-side check ─────────────────────────
banner('3. shouldKeepSection — consumer prepare()');
const shape = await gateMid({ meshId: 'm1' }); // expect drop snippets only
console.log(`  keep ${INTEL_HEADER_SECTION}? ${shouldKeepSection(shape, INTEL_HEADER_SECTION)}`);
console.log(`  keep ${INTEL_SNIPPETS_SECTION}? ${shouldKeepSection(shape, INTEL_SNIPPETS_SECTION)}`);
console.log(`  null shape (graceful) keeps anything: ${shouldKeepSection(null, 'whatever')}`);

// ── 4. Pure history compaction ───────────────────────────────────────
banner('4. decideCompaction — sliding window over 10-message history');
const history: HistoryItem[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  ...Array.from({ length: 9 }, (_, i) => ({ role: 'user' as const, content: `turn ${i + 1}` })),
];
const sliding = await decideCompaction(history, { strategy: 'sliding', windowTurns: 4 }, { meshId: 'm1' });
console.log(`  ${sliding.reason}`);
console.log(`  → kept ${sliding.messages.length}, dropped ${sliding.dropped.length}`);
console.log(`  first kept: ${JSON.stringify(sliding.messages[0])}`);
console.log(`  last kept:  ${JSON.stringify(sliding.messages[sliding.messages.length - 1])}`);

// ── 5. Summary strategy with injected summariser ─────────────────────
banner('5. summary strategy — injected HistorySummarizer');
const summarizer: HistorySummarizer = (dropped) =>
  `[${dropped.length} earlier turns omitted]`;
const summary = await decideCompaction(
  history,
  { strategy: 'summary', windowTurns: 3 },
  { meshId: 'm1' },
  summarizer,
);
console.log(`  ${summary.reason} | summary="${summary.summary}"`);
console.log(`  → kept ${summary.messages.length}, dropped ${summary.dropped.length}`);

// ── 6. End-to-end via weaveCostGovernor (balanced tier) ──────────────
banner('6. weaveCostGovernor(balanced) — both levers wired');
const balancedPolicy: CostPolicy = { tier: 'balanced' };
const balancedBundle = weaveCostGovernor(balancedPolicy, {
  intelScoreProvider: stubProvider(0.85), // rich context → drop both
  historySummarizer: summarizer,
});
console.log(`  policy.intelGating.enabled = ${balancedBundle.policy.intelGating.enabled}`);
console.log(`  policy.historyCompaction.strategy = ${balancedBundle.policy.historyCompaction.strategy}`);
console.log(`  promptShaper(score=0.85) →`, await balancedBundle.promptShaper({ meshId: 'm1' }));
const compacted = await balancedBundle.historyCompactor(history, { meshId: 'm1' });
console.log(`  historyCompactor → kept ${compacted.length} of ${history.length}`);

// ── 7. tier=max disables both levers (max-quality, max-cost) ─────────
banner('7. weaveCostGovernor(max) — both levers off');
const maxBundle = weaveCostGovernor({ tier: 'max' }, {
  intelScoreProvider: stubProvider(0.95),
  historySummarizer: summarizer,
});
console.log(`  policy.intelGating.enabled = ${maxBundle.policy.intelGating.enabled}`);
console.log(`  policy.historyCompaction.strategy = ${maxBundle.policy.historyCompaction.strategy}`);
console.log(`  promptShaper → ${JSON.stringify(await maxBundle.promptShaper({ meshId: 'm1' }))}`);
const passthrough = await maxBundle.historyCompactor(history, { meshId: 'm1' });
console.log(`  historyCompactor (pass-through) → kept ${passthrough.length} of ${history.length}`);

// ── 8. Graceful degradation — provider throws → score=null → keep all ─
banner('8. graceful degradation — provider throws');
const throwingProvider: IntelScoreProvider = {
  compute: () => {
    throw new Error('intel store unreachable');
  },
};
const throwingGate = weaveIntelGate(cfg, throwingProvider, { log: () => {} });
console.log(`  shape on throw: ${JSON.stringify(await throwingGate({ meshId: 'm1' }))} (= keep everything)`);

console.log('\n✓ Phase 6 example complete.');
