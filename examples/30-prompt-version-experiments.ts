/**
 * Phase 5 example: DB-driven prompt versions + experiments with deterministic selection.
 *
 * Run (after starting geneweave server):
 *   npm run tsx -- examples/30-prompt-version-experiments.ts
 */

const BASE = process.env.GENEWEAVE_BASE_URL ?? 'http://localhost:3500';

type Json = Record<string, unknown>;

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

async function main() {
  const promptName = `phase5-demo-${Date.now()}`;

  const createPrompt = await api('/api/admin/prompts', {
    method: 'POST',
    body: JSON.stringify({
      name: promptName,
      description: 'Phase 5 demo prompt with versioned variants for controlled experiments.',
      template: 'Base prompt fallback.',
      variables: '[]',
      enabled: true,
    }),
  });
  const prompt = createPrompt['prompt'] as Json;
  const promptId = String(prompt['id']);

  await api('/api/admin/prompt-versions', {
    method: 'POST',
    body: JSON.stringify({
      prompt_id: promptId,
      version: '1.0',
      status: 'published',
      template: 'You are concise. Answer in one sentence.',
      variables: '[]',
      is_active: true,
      enabled: true,
    }),
  });

  await api('/api/admin/prompt-versions', {
    method: 'POST',
    body: JSON.stringify({
      prompt_id: promptId,
      version: '2.0',
      status: 'published',
      template: 'You are detailed. Answer with 3 bullets and include reasoning.',
      variables: '[]',
      is_active: false,
      enabled: true,
    }),
  });

  await api('/api/admin/prompt-experiments', {
    method: 'POST',
    body: JSON.stringify({
      prompt_id: promptId,
      name: 'phase5-demo-experiment',
      description: 'Weighted version rollout for deterministic experiment assignment.',
      status: 'active',
      variants_json: JSON.stringify([
        { version: '1.0', weight: 70, label: 'concise' },
        { version: '2.0', weight: 30, label: 'detailed' },
      ]),
      assignment_key_template: '{{prompt_id}}:{{chat_id}}',
      enabled: true,
    }),
  });

  // Create a chat bound to the prompt name so runtime resolves by DB records.
  const createChat = await api('/api/chats', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Phase 5 Prompt Experiment Demo',
      settings: {
        systemPrompt: promptName,
        mode: 'direct',
      },
    }),
  });
  const chat = createChat['chat'] as Json;
  const chatId = String(chat['id']);

  const message = await api(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      content: 'Explain what prompt versioning enables for safe rollouts.',
    }),
  });

  const assistant = message['assistant'] as Json;
  const meta = (assistant['metadata'] as Json | undefined) ?? {};

  console.log('Assistant content:');
  console.log(String(assistant['content'] ?? ''));
  console.log('\nPrompt strategy metadata:');
  console.log(JSON.stringify(meta['promptStrategy'] ?? null, null, 2));
  console.log('\nPrompt resolution metadata (Phase 5):');
  console.log(JSON.stringify(meta['promptResolution'] ?? null, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
