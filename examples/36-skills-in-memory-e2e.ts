/**
 * Example 36 — Skills runtime, in-memory end-to-end (no GeneWeave, no DB, no server).
 *
 * Validates the full @weaveintel/skills lifecycle and the shape of every
 * intermediate object using `node:assert/strict`:
 *
 *   1. Registry: register two skills, list/get/discover.
 *   2. Activation: semantic match returns expected SkillActivationResult shape.
 *   3. Prompt composition: applySkillsToPrompt + buildSkillSystemPrompt.
 *   4. Tool collection: collectSkillTools honors policy allow/deny.
 *   5. Reasoning selector: useNoSkillPath produces noSkillReason.
 *   6. Policy evaluator: blocks a skill and reports rejection.
 *   7. Completion evaluation: complete vs incomplete vs blocked_by_policy.
 *   8. Lifecycle hooks: onActivation, onCompletion, onTelemetry all fire.
 *
 * Run: `npx tsx examples/36-skills-in-memory-e2e.ts`
 */

import assert from 'node:assert/strict';
import {
  activateSkills,
  applySkillsToPrompt,
  buildSkillSystemPrompt,
  collectSkillTools,
  createSkillRegistry,
  evaluateSkillCompletion,
  type SkillActivationResult,
  type SkillDefinition,
  type SkillLifecycleHooks,
} from '@weaveintel/skills';

const PASS = '\u001b[32m✓\u001b[0m';
const FAIL = '\u001b[31m✗\u001b[0m';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

function ok(label: string): void {
  console.log(`  ${PASS} ${label}`);
}

const mathSkill: SkillDefinition = {
  id: 'math-canary',
  name: 'Math Canary',
  category: 'analysis',
  summary: 'Performs deterministic arithmetic verification using a calculator tool.',
  whenToUse: 'Use when the user asks for arithmetic, sums, products, or numeric verification.',
  executionGuidance: 'Call the calculator tool with a normalized expression and return the numeric result.',
  toolNames: ['calculator'],
  triggerPatterns: ['arithmetic', 'calculate', 'compute'],
  completionContract: {
    narrative: 'Final answer must include the numeric result.',
    requiredEvidence: ['result'],
  },
  policy: {
    allowedTools: ['calculator'],
    disallowedTools: ['shell'],
  },
  priority: 100,
};

const researchSkill: SkillDefinition = {
  id: 'research-canary',
  name: 'Research Canary',
  category: 'research',
  summary: 'Synthesises a brief research note from the user query.',
  whenToUse: 'Use when the user asks for a literature summary, background, or definition.',
  executionGuidance: 'Compose a concise prose answer citing sources.',
  toolNames: ['web_search'],
  triggerPatterns: ['research', 'summarize', 'background'],
  priority: 50,
};

async function main(): Promise<void> {
  console.log('Skills in-memory E2E\n');

  // ── 1. Registry ──────────────────────────────────────────────────────────
  section('1. Registry register / list / get / discover');
  const registry = createSkillRegistry();
  registry.register(mathSkill);
  registry.register(researchSkill);

  assert.equal(registry.list().length, 2, 'registry should hold two skills');
  ok('registry holds two registered skills');

  const fetched = registry.get('math-canary');
  assert.ok(fetched, 'get(math-canary) returns the definition');
  assert.equal(fetched?.name, 'Math Canary');
  ok('get() returns the registered SkillDefinition by id');

  const discovered = registry.discover('please calculate the arithmetic sum 17 * 23');
  assert.ok(discovered.length >= 1, 'discover returns at least one match');
  assert.equal(discovered[0]?.skill.id, 'math-canary', 'top match is math skill');
  assert.ok(discovered[0]!.score > 0, 'match has non-zero semantic score');
  assert.equal(discovered[0]?.source, 'semantic');
  ok(`discover() ranks math-canary first (score=${discovered[0]?.score.toFixed(3)})`);

  // ── 2. Activation shape ──────────────────────────────────────────────────
  section('2. Activation result shape');
  const activation: SkillActivationResult = await registry.activate(
    'please calculate the arithmetic sum 17 * 23',
    { mode: 'tool_assisted' },
  );

  assert.equal(activation.mode, 'tool_assisted', 'mode is propagated');
  assert.ok(Array.isArray(activation.considered), 'considered is an array');
  assert.ok(Array.isArray(activation.selected), 'selected is an array');
  assert.ok(Array.isArray(activation.rejected), 'rejected is an array');
  assert.ok(activation.selected.length >= 1, 'at least one selected skill');
  assert.equal(activation.selected[0]?.skill.id, 'math-canary');
  ok(`activation.selected[0].skill.id === 'math-canary' (mode=${activation.mode})`);
  ok(`activation considered ${activation.considered.length}, selected ${activation.selected.length}`);

  // ── 3. Prompt composition ────────────────────────────────────────────────
  section('3. Prompt composition');
  const skillBlock = buildSkillSystemPrompt([...activation.selected]);
  assert.ok(skillBlock.length > 0, 'skill system block is non-empty');
  assert.match(skillBlock, /Math Canary/i, 'skill block contains skill name');
  ok('buildSkillSystemPrompt() emits a block containing the skill name');

  const composed = applySkillsToPrompt(
    'You are a helpful assistant.',
    [...activation.selected],
    activation.mode,
    'calculate 17 * 23',
  );
  assert.ok(composed, 'composed prompt exists');
  assert.match(composed!, /helpful assistant/i, 'base prompt preserved');
  assert.match(composed!, /Math Canary/i, 'skill block appended');
  ok('applySkillsToPrompt() merges base + skill block');

  // ── 4. Tool collection honors policy ─────────────────────────────────────
  section('4. collectSkillTools honors policy');
  const tools = collectSkillTools([...activation.selected]);
  assert.ok(tools.includes('calculator'), 'calculator collected');
  assert.ok(!tools.includes('shell'), 'shell excluded by disallowedTools policy');
  ok(`collectSkillTools() → ${JSON.stringify(tools)} (shell correctly excluded)`);

  // ── 5. Reasoning selector → no-skill path ────────────────────────────────
  section('5. Reasoning selector returns useNoSkillPath');
  const noSkillResult = await activateSkills(
    'please calculate the arithmetic sum 17 * 23',
    [mathSkill, researchSkill],
    {
      selector: async () => ({
        selectedSkillIds: [],
        useNoSkillPath: true,
        rationale: 'Selector decided plain reasoning is sufficient.',
      }),
    },
  );
  assert.equal(noSkillResult.selected.length, 0, 'nothing selected');
  assert.ok(noSkillResult.noSkillReason, 'noSkillReason is set');
  assert.match(noSkillResult.noSkillReason!, /reasoning/i);
  ok(`no-skill path → noSkillReason: "${noSkillResult.noSkillReason}"`);

  // ── 6. Policy evaluator blocks math-canary ───────────────────────────────
  section('6. Policy evaluator blocks a candidate');
  const policyResult = await activateSkills(
    'please calculate the arithmetic sum 17 * 23',
    [mathSkill, researchSkill],
    {
      policyEvaluator: ({ skill }) =>
        skill.id === 'math-canary'
          ? { allowed: false, reason: 'Calculator tool requires approval in this tenant.' }
          : { allowed: true },
    },
  );
  const blockedIds = policyResult.rejected.map((r) => r.skillId);
  assert.ok(blockedIds.includes('math-canary'), 'math-canary appears in rejected list');
  assert.ok(
    policyResult.selected.every((m) => m.skill.id !== 'math-canary'),
    'math-canary is not in selected list',
  );
  ok(`policy rejected: ${JSON.stringify(policyResult.rejected)}`);

  // ── 7. Completion evaluation (completion contract enforcement) ───────────
  section('7. evaluateSkillCompletion enforces completionContract');
  // mathSkill.completionContract.requiredEvidence === ['result']
  assert.deepEqual(
    mathSkill.completionContract?.requiredEvidence,
    ['result'],
    'sanity: math skill declares requiredEvidence: ["result"]',
  );

  const completeEval = evaluateSkillCompletion(mathSkill, 'The result is 391.');
  assert.equal(completeEval.state, 'complete', 'output containing required evidence → complete');
  assert.deepEqual(completeEval.missingEvidence, [], 'no missing evidence reported');
  ok(`evidence "result" present → state="${completeEval.state}", missingEvidence=[]`);

  // Negative path: contract requires the substring "result", omit it.
  const missingEvidenceEval = evaluateSkillCompletion(mathSkill, 'The answer is 391.');
  assert.equal(missingEvidenceEval.state, 'incomplete', 'missing required evidence → incomplete');
  assert.deepEqual(
    missingEvidenceEval.missingEvidence,
    ['result'],
    'missingEvidence array names the missing token',
  );
  assert.match(
    missingEvidenceEval.reasons.join(' '),
    /completion contract/i,
    'reason references the completion contract',
  );
  ok(`evidence "result" absent → state="${missingEvidenceEval.state}", missingEvidence=${JSON.stringify(missingEvidenceEval.missingEvidence)}`);

  // Warning tone path: evidence present but uncertainty language used.
  const warningEval = evaluateSkillCompletion(mathSkill, 'The result is possibly 391.');
  assert.equal(
    warningEval.state,
    'complete_with_warnings',
    'evidence + hedged language → complete_with_warnings',
  );
  ok(`evidence present + hedged ("possibly") → state="${warningEval.state}"`);

  const incompleteEval = evaluateSkillCompletion(mathSkill, '');
  assert.equal(incompleteEval.state, 'incomplete', 'empty output → incomplete');
  assert.deepEqual(
    incompleteEval.missingEvidence,
    ['result'],
    'empty output reports all contract evidence as missing',
  );
  ok(`empty output → state="${incompleteEval.state}", missingEvidence=${JSON.stringify(incompleteEval.missingEvidence)}`);

  const blockedEval = evaluateSkillCompletion(mathSkill, 'irrelevant', { blockedByPolicy: true });
  assert.equal(blockedEval.state, 'blocked_by_policy');
  ok(`blockedByPolicy=true → state="${blockedEval.state}"`);

  // ── 8. Lifecycle hooks ───────────────────────────────────────────────────
  section('8. Lifecycle hooks fire');
  let activationHookCalls = 0;
  let completionHookCalls = 0;
  let telemetryHookCalls = 0;
  const hooks: SkillLifecycleHooks = {
    onActivation: () => {
      activationHookCalls += 1;
    },
    onCompletion: () => {
      completionHookCalls += 1;
    },
    onTelemetry: () => {
      telemetryHookCalls += 1;
    },
  };

  await activateSkills('please calculate something arithmetic', [mathSkill], { hooks });
  evaluateSkillCompletion(mathSkill, 'The result is 42.', { hooks });

  assert.equal(activationHookCalls, 1, 'onActivation fired exactly once');
  assert.equal(completionHookCalls, 1, 'onCompletion fired exactly once');
  assert.ok(telemetryHookCalls >= 2, `onTelemetry fired ≥ 2 times (got ${telemetryHookCalls})`);
  ok(`hooks fired: activation=${activationHookCalls}, completion=${completionHookCalls}, telemetry=${telemetryHookCalls}`);

  console.log(`\n${PASS} All skills runtime assertions passed.`);
}

main().catch((err) => {
  console.error(`${FAIL} example failed:`, err);
  process.exit(1);
});
