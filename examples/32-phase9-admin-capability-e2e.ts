/**
 * Phase 9 example: modular admin capability wiring + DB-driven runtime flow.
 *
 * Run (after starting geneweave server):
 *   npm run tsx -- examples/32-phase9-admin-capability-e2e.ts
 *
 * What this validates end-to-end:
 * 1) Creates DB records through admin APIs for prompt, strategy, and skill.
 * 2) Resolves the prompt through /api/prompts/resolve to exercise shared
 *    prompt runtime + telemetry path (not just CRUD).
 * 3) Sends a chat message bound to the DB prompt to verify runtime adoption.
 * 4) Reads dashboard traces to confirm capability telemetry is queryable.
 */
export {};

const BASE = process.env.GENEWEAVE_BASE_URL ?? 'http://localhost:3500';

type Json = Record<string, unknown>;

/**
 * Thin JSON API helper used by this example.
 * Throws with endpoint context so failures are easy to diagnose.
 */
async function api(path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json()) as Json;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}: ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Extracts an object field as string and fails fast when the payload shape
 * changes, which keeps the example deterministic across refactors.
 */
function asString(obj: Json, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Expected non-empty string field "${key}", got: ${JSON.stringify(value)}`);
  }
  return value;
}

async function main() {
  const suffix = Date.now();
  const promptName = `phase9-prompt-${suffix}`;
  const strategyKey = `phase9-strategy-${suffix}`;
  const skillName = `Phase 9 Skill ${suffix}`;

  // 1) Create prompt strategy in DB so runtime selection is data-driven.
  await api('/api/admin/prompt-strategies', {
    method: 'POST',
    body: JSON.stringify({
      key: strategyKey,
      name: `Phase 9 Strategy ${suffix}`,
      description: 'Model-facing strategy for Phase 9 modular admin runtime validation.',
      instruction_prefix: 'Respond with explicit sections: Summary, Evidence, Next Steps.',
      instruction_suffix: 'End with one concrete action item.',
      enabled: true,
    }),
  });

  // 2) Create prompt in DB and attach execution defaults to strategy key.
  const promptResp = await api('/api/admin/prompts', {
    method: 'POST',
    body: JSON.stringify({
      key: promptName,
      name: promptName,
      description: 'Model-facing Phase 9 prompt that validates DB-driven strategy resolution.',
      template: 'You are a reliability-focused assistant. User request: {{query}}',
      variables: JSON.stringify([{ name: 'query', required: true, description: 'User query to answer' }]),
      execution_defaults: JSON.stringify({ strategy: strategyKey }),
      enabled: true,
      status: 'published',
    }),
  });

  const promptObj = (promptResp['prompt'] as Json | undefined) ?? {};
  const promptId = asString(promptObj, 'id');

  // 3) Create skill in DB referencing prompt + strategy metadata.
  //    Trigger patterns include a unique suffix so we can assert this exact
  //    skill activated (not just any seed skill that matched 'rollout').
  const triggerPhrase = `phase9-trigger-${suffix}`;
  await api('/api/admin/skills', {
    method: 'POST',
    body: JSON.stringify({
      name: skillName,
      description: 'Model-facing skill that routes reliability requests through a DB-backed prompt strategy.',
      category: 'analysis',
      instructions: 'Use this skill for reliability, rollout, and observability analysis tasks.',
      trigger_patterns: JSON.stringify([triggerPhrase, 'reliability', 'rollout', 'observability']),
      examples: JSON.stringify(['Assess rollout risk', 'Summarize telemetry anomalies']),
      tool_names: JSON.stringify([]),
      prompt_id: promptId,
      prompt_strategy: strategyKey,
      enabled: true,
      version: '1.0',
      priority: 100,
    }),
  });

  // 4) Resolve prompt directly through admin resolve route to capture telemetry.
  const resolveResp = await api('/api/prompts/resolve', {
    method: 'POST',
    body: JSON.stringify({
      id: promptId,
      values: { query: 'Explain why modularization improves operational safety.' },
    }),
  });

  // 5) Create chat bound to prompt name and send a message for runtime validation.
  const chatResp = await api('/api/chats', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Phase 9 Admin Capability E2E',
      settings: {
        systemPrompt: promptName,
        mode: 'direct',
      },
    }),
  });
  const chat = (chatResp['chat'] as Json | undefined) ?? {};
  const chatId = asString(chat, 'id');

  const msgResp = await api(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      // Include the unique trigger so skill activation is deterministic.
      content: `${triggerPhrase}: give a rollout safety checklist for introducing shared admin schema modules.`,
    }),
  });

  // 6) Pull dashboard traces so observability remains shared and queryable.
  const tracesResp = await api('/api/dashboard/traces');

  const assistant = (msgResp['assistant'] as Json | undefined) ?? {};
  const metadata = (assistant['metadata'] as Json | undefined) ?? {};
  const telemetry = (resolveResp['telemetry'] as Json | undefined) ?? {};
  const traces = Array.isArray(tracesResp['traces']) ? tracesResp['traces'] : [];

  console.log('Created prompt:', promptName);
  console.log('Created strategy:', strategyKey);
  console.log('Created skill:', skillName);
  console.log('\nPrompt resolve telemetry summary:');
  console.log(JSON.stringify(telemetry['summary'] ?? telemetry, null, 2));
  console.log('\nChat prompt strategy metadata:');
  console.log(JSON.stringify(metadata['promptStrategy'] ?? null, null, 2));

  // Validate the skill we just created actually activated for this turn.
  const activeSkills = Array.isArray(metadata['activeSkills']) ? (metadata['activeSkills'] as Json[]) : [];
  const skillPromptApplied = metadata['skillPromptApplied'] === true;
  const matched = activeSkills.some((s) => (s as Json)['name'] === skillName);
  console.log('\nSkill activation:');
  console.log('  skillPromptApplied:', skillPromptApplied);
  console.log('  activeSkills:', activeSkills.map((s) => (s as Json)['name']).join(', ') || '(none)');
  console.log(matched ? `  ✓ Skill "${skillName}" activated.` : `  ⚠ Skill "${skillName}" did NOT activate.`);

  console.log('\nDashboard traces count:', traces.length);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
