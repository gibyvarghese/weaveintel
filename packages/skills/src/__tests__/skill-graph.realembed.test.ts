// SPDX-License-Identifier: MIT
/**
 * End-to-end: REAL embedding retrieval (Phase 0) + composition graph (Phase 1).
 * A user asks for a multi-step task in plain language; embeddings find the relevant skills,
 * then resolveSkillGraph turns them into a correctly-ordered plan with dependencies pulled in.
 * Skipped when no OPENAI_API_KEY (read from env or the monorepo root .env).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineSkill } from '../types.js';
import { hybridSkillRetriever, type SkillEmbedFn } from '../retrieval.js';
import { resolveSkillGraph } from '../skill-graph.js';

function loadKey(): string | undefined {
  if (process.env['OPENAI_API_KEY']) return process.env['OPENAI_API_KEY'];
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../../../.env', '../../../.env', '../../.env']) {
    try {
      const m = readFileSync(join(here, rel), 'utf8').match(/^OPENAI_API_KEY=(.+)$/m);
      if (m) return m[1]!.trim().replace(/^["']|["']$/g, '');
    } catch { /* keep looking */ }
  }
  return undefined;
}
const KEY = loadKey();
const realEmbed: SkillEmbedFn = async (texts) => {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
  return ((await res.json()) as { data: Array<{ embedding: number[] }> }).data.map((d) => d.embedding);
};

// A realistic analytics-product catalog with a real dependency chain.
const catalog = [
  defineSkill({ id: 'load', name: 'Data Loader', summary: 'Load a CSV or spreadsheet into the workspace so it can be analysed.', whenToUse: 'When the user references a data file to work with.', provides: ['dataset.loaded'] }),
  defineSkill({ id: 'analyze', name: 'Data Analyst', summary: 'Compute statistics, correlations and trends over a loaded dataset.', whenToUse: 'When the user wants to understand what the data says.', requires: ['load'], precondition: { requires: ['dataset.loaded'] }, provides: ['analysis.done'] }),
  defineSkill({ id: 'report', name: 'Report Writer', summary: 'Write a clear written report of the findings from an analysis.', whenToUse: 'When the user wants a written summary of results.', requires: ['analyze'], precondition: { requires: ['analysis.done'] }, provides: ['report.done'] }),
  defineSkill({ id: 'translate', name: 'Translator', summary: 'Translate text between languages.', whenToUse: 'When content must be in another language.' }),
  defineSkill({ id: 'email', name: 'Email Composer', summary: 'Draft a professional email.', whenToUse: 'When the user wants to send a message.' }),
];

describe.skipIf(!KEY)('skill graph — REAL retrieval + composition (e2e)', () => {
  it('a plain-language compound request becomes a correctly-ordered, dependency-complete plan', async () => {
    const query = 'take my sales figures and give me a written summary of the key trends';
    // 1) real embeddings find the relevant skills (report + analyze — NOT translate/email)
    const candidates = await hybridSkillRetriever({ embed: realEmbed }).retrieve(query, catalog, { limit: 3 });
    const foundIds = candidates.map((c) => c.skill.id);
    expect(foundIds).toContain('report');
    expect(foundIds).not.toContain('translate');
    expect(foundIds).not.toContain('email');

    // 2) composition turns them into an ordered plan, pulling in the missing dependencies
    const plan = resolveSkillGraph(candidates.map((c) => c.skill), catalog);
    const order = plan.ordered.map((s) => s.id);
    // whatever was retrieved, the final plan must load → analyze → report in that order
    expect(order.indexOf('load')).toBeLessThan(order.indexOf('analyze'));
    expect(order.indexOf('analyze')).toBeLessThan(order.indexOf('report'));
    expect(order[order.length - 1]).toBe('report');
    // and it auto-added any dependency the retriever didn't surface
    expect(plan.ordered.map((s) => s.id)).toContain('load');
  }, 30000);
});
