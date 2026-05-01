// One-shot generator: reads strategist-agent.ts DEFAULT_GOAL + arc_solver.py
// and emits playbook-seed-content.ts with both as JSON-escaped string constants.
import { readFileSync, writeFileSync } from 'node:fs';

const ts = readFileSync('apps/geneweave/src/live-agents/kaggle/strategist-agent.ts', 'utf8');
const m = ts.match(/const DEFAULT_GOAL = `([\s\S]*?)`;/);
if (!m) throw new Error('DEFAULT_GOAL not found');
const goalText = m[1];
const solver = readFileSync('apps/geneweave/src/live-agents/kaggle/arc_solver.py', 'utf8');

const out = `// AUTO-GENERATED. Source of truth at seed time was the legacy strategist-agent.ts
// DEFAULT_GOAL constant and arc_solver.py. After seeding, edit via admin UI.
/* eslint-disable */
export const KAGGLE_ARC_AGI_3_WORKFLOW = ${JSON.stringify(goalText)};
export const KAGGLE_ARC_AGI_3_SOLVER_TEMPLATE = ${JSON.stringify(solver)};
`;
writeFileSync('apps/geneweave/src/live-agents/kaggle/playbook-seed-content.ts', out);
console.log('wrote', out.length, 'bytes');
