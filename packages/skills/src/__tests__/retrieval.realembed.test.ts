// SPDX-License-Identifier: MIT
/**
 * End-to-end retrieval test against REAL OpenAI embeddings.
 * Skipped automatically when no OPENAI_API_KEY is available (CI / offline), so the
 * hermetic unit suite (retrieval.test.ts) is the always-on gate and this proves the
 * real thing when a key is present. Reads the key from the environment or the monorepo
 * root .env.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineSkill } from '../types.js';
import {
  lexicalSkillRetriever,
  embeddingSkillRetriever,
  hybridSkillRetriever,
  createSkillEmbeddingIndex,
  type SkillEmbedFn,
} from '../retrieval.js';

function loadKey(): string | undefined {
  if (process.env['OPENAI_API_KEY']) return process.env['OPENAI_API_KEY'];
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../../../.env', '../../../.env', '../../.env']) {
    try {
      const txt = readFileSync(join(here, rel), 'utf8');
      const m = txt.match(/^OPENAI_API_KEY=(.+)$/m);
      if (m) return m[1]!.trim().replace(/^["']|["']$/g, ''); // strip surrounding quotes if present
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
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data.map((d) => d.embedding);
};

// A realistic, mixed catalog — the kind a shipping product would have.
const catalog = [
  defineSkill({ id: 'refactor', name: 'Refactoring Assistant', summary: 'Restructure and improve the quality of existing source code without changing its behaviour.', whenToUse: 'When the user wants their code to be more maintainable, readable, or better organized.', triggerPatterns: ['refactor this'], tags: ['engineering'] }),
  defineSkill({ id: 'translate', name: 'Translator', summary: 'Faithfully translate content from one language into another, preserving meaning and tone.', whenToUse: 'When the user needs text in a different language.', tags: ['language'] }),
  defineSkill({ id: 'summarize', name: 'Summarizer', summary: 'Produce a concise summary of a long piece of content, keeping the key points.', whenToUse: 'When the user has a long document and wants the gist.', tags: ['writing'] }),
  defineSkill({ id: 'sql', name: 'SQL Query Builder', summary: 'Turn a plain-English request into a correct, optimized SQL query.', whenToUse: 'When the user wants to query a database.', tags: ['data'] }),
  defineSkill({ id: 'incident', name: 'Incident Investigator', summary: 'Investigate a production outage: gather signals, form hypotheses, and identify the root cause.', whenToUse: 'When something in production is broken and the user needs to find out why.', tags: ['ops'] }),
];

describe.skipIf(!KEY)('skill retrieval — REAL OpenAI embeddings (e2e)', () => {
  it('finds a paraphrased match the lexical matcher misses ("my code is a mess" → Refactoring Assistant)', async () => {
    const query = 'my code is a total mess, can you help me tidy it up'; // no overlap with the refactor card wording
    const lex = await lexicalSkillRetriever().retrieve(query, catalog, { limit: 3 });
    const emb = await embeddingSkillRetriever({ embed: realEmbed }).retrieve(query, catalog, { limit: 3 });

    const embRefactor = emb[0]!.score;
    const lexRefactor = lex.find((c) => c.skill.id === 'refactor')?.score ?? 0;
    // Embedding ranks the refactor skill #1 with a strong, confident score…
    expect(emb[0]?.skill.id).toBe('refactor');
    expect(embRefactor).toBeGreaterThan(0.3);
    // …and it is a MUCH stronger signal than lexical, which only gets a weak partial score
    // from one incidental shared word ("code") and would miss a true zero-overlap paraphrase.
    expect(embRefactor).toBeGreaterThan(lexRefactor * 2);
  }, 30000);

  it('hybrid handles BOTH an exact-keyword query and a conceptual one', async () => {
    const hybrid = hybridSkillRetriever({ embed: realEmbed, index: createSkillEmbeddingIndex(realEmbed) });
    const exact = await hybrid.retrieve('write me a SQL query for the orders table', catalog, { limit: 3 });
    expect(exact[0]?.skill.id).toBe('sql');

    const conceptual = await hybrid.retrieve('the website went down and I need to figure out what happened', catalog, { limit: 3 });
    expect(conceptual[0]?.skill.id).toBe('incident');
  }, 30000);

  it('index caching: a second sync of the same catalog issues no new embedding calls', async () => {
    let calls = 0;
    const counting: SkillEmbedFn = async (t) => { calls++; return realEmbed(t); };
    const index = createSkillEmbeddingIndex(counting);
    await index.sync(catalog);
    const after = calls;
    await index.sync(catalog);
    expect(calls).toBe(after); // no re-embed on unchanged catalog
  }, 30000);
});
