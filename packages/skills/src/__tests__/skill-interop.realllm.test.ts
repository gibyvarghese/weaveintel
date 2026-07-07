// SPDX-License-Identifier: MIT
/**
 * REAL LLM end-to-end for interop.
 *
 *  1. Import a public-standard `SKILL.md`, fold its guidance into a real model, and confirm the model
 *     actually does the job the skill describes — i.e. an imported skill really works.
 *  2. Expose skills over the MCP bridge with REAL embeddings, and show an agent can *discover* the
 *     right skill for a plainly-worded request (semantic search on demand), then pull its SKILL.md.
 *
 * Skipped when no OPENAI_API_KEY (read from env or the monorepo root .env).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { importSkillMd } from '../skill-interop.js';
import { createSkillMcpBridge } from '../skill-mcp.js';
import { hybridSkillRetriever, type SkillEmbedFn } from '../retrieval.js';
import { defineSkill } from '../types.js';

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

async function chat(model: string, system: string, user: string, json = false): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, ...(json ? { response_format: { type: 'json_object' } } : {}), messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
  return ((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content;
}
const realEmbed: SkillEmbedFn = async (texts) => {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
  return ((await res.json()) as { data: Array<{ embedding: number[] }> }).data.map((d) => d.embedding);
};

// A public-standard SKILL.md an adopter downloads from the community.
const MEETING_SKILL_MD = `---
name: meeting-minutes
description: Turn a rough meeting transcript into clean minutes with decisions and action items.
version: 1.0.0
tags: [productivity, meetings]
---
# Meeting minutes
From the transcript:
1. Write a short summary.
2. List the DECISIONS made.
3. List ACTION ITEMS as "owner — task".
Be factual; do not invent details.
`;

const TRANSCRIPT = `Alice: We need to ship the export feature by Friday. Bob: I can do the backend, but the CSV
edge cases worry me. Alice: OK, Bob owns backend. Carol, can you take the UI? Carol: Yes, I'll have it
by Thursday. Alice: Decision — we go with CSV only for v1, XLSX later. Bob: Agreed.`;

describe.skipIf(!KEY)('skill interop — REAL LLM', () => {
  it('imports a public SKILL.md and a real model FOLLOWS it to do the job', async () => {
    const imported = await importSkillMd(MEETING_SKILL_MD);
    expect(imported.assessment.earnedTier).toBe(1); // untrusted on import, but usable as guidance

    // Fold the imported skill's guidance into the system prompt (as an agent would).
    const system = `You are an assistant. Follow this skill exactly:\n\n${imported.definition.executionGuidance}`;
    const output = await chat('gpt-4o-mini', system, `Transcript:\n${TRANSCRIPT}`);

    // A real judge checks the output actually followed the imported skill.
    const verdict = JSON.parse(await chat('gpt-4o',
      'Did the response include a summary, a DECISIONS list, and ACTION ITEMS with owners? Respond ONLY as JSON {"pass": boolean, "reason": string}.',
      output, true)) as { pass: boolean; reason?: string };
    expect(verdict.pass).toBe(true);
    // Sanity: it captured the real decision + owners from the transcript.
    expect(output.toLowerCase()).toMatch(/csv/);
    expect(output.toLowerCase()).toMatch(/bob|carol/);
  }, 120_000);

  it('over MCP, an agent DISCOVERS the right skill for a plainly-worded request (real embeddings)', async () => {
    const skills = [
      defineSkill({ id: 'meeting-minutes', name: 'Meeting Minutes', summary: 'Turn a meeting transcript into minutes with decisions and action items.', whenToUse: 'After a meeting when you need a clean write-up.' }),
      defineSkill({ id: 'translate-note', name: 'Translator', summary: 'Translate a document into another language.', whenToUse: 'When a user wants a translation.' }),
      defineSkill({ id: 'sql-explainer', name: 'SQL Explainer', summary: 'Explain what a SQL query does in plain English.', whenToUse: 'When a user pastes a SQL query.' }),
    ];
    const bridge = createSkillMcpBridge({ skills, retriever: hybridSkillRetriever({ embed: realEmbed }) });

    // The user's words don't literally match the skill ("write-up of who agreed to what").
    const found = await bridge.callTool('search_skills', { query: 'I need a tidy write-up of who agreed to what after our call', limit: 2 });
    expect(found.content[0]!.text).toContain('meeting-minutes'); // semantic match

    // Then pull its SKILL.md and confirm it round-trips.
    const md = await bridge.callTool('get_skill', { id: 'meeting-minutes' });
    const back = await importSkillMd(md.content[0]!.text);
    expect(back.package.name).toBe('meeting-minutes');
  }, 120_000);
});
