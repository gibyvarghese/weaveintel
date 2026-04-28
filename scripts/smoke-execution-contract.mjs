#!/usr/bin/env node
// Smoke test: verifies execution contract round-trips from DB row → rendered
// supervisor prompt → extraction. Run with `node scripts/smoke-execution-contract.mjs`.

import Database from 'better-sqlite3';
import {
  skillFromRow,
  buildSkillInvocationPrompt,
  extractSkillExecutionContractsFromPrompt,
} from '../packages/skills/dist/index.js';

const db = new Database('./geneweave.db', { readonly: true });
const rows = db.prepare(
  "SELECT * FROM skills WHERE execution_contract IS NOT NULL ORDER BY id",
).all();

console.log(`found ${rows.length} skill rows with execution_contract\n`);

for (const row of rows) {
  const skill = skillFromRow(row);
  console.log(`── ${skill.id} ──`);
  console.log(`  executionContract on definition: ${JSON.stringify(skill.executionContract)}`);

  const rendered = buildSkillInvocationPrompt(
    {
      selected: [{
        skill,
        score: 1,
        matchedTriggers: [],
        rationale: 'smoke test',
      }],
    },
    'reasoning',
    'analyse this csv',
  );

  const hasMarker = rendered.includes('[SKILL_EXEC_CONTRACT');
  console.log(`  marker present in rendered prompt: ${hasMarker}`);

  const extracted = extractSkillExecutionContractsFromPrompt(rendered);
  console.log(`  extracted contracts: ${JSON.stringify(extracted, null, 2)}`);
  console.log('');
}

db.close();
