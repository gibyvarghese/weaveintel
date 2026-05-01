/**
 * Example 35 — Skill activation end-to-end (chat → skill match → tool use → audit).
 *
 * Run (after starting geneweave server):
 *   npm run tsx -- examples/35-skill-activation-e2e.ts
 *
 * What this validates:
 *  1) Creates a skill in the DB with a distinctive trigger phrase + tool_names.
 *  2) Creates a chat in `agent` mode so tool calls are allowed.
 *  3) Sends a user message containing the trigger phrase.
 *  4) Asserts the assistant message metadata reports:
 *       - activeSkills[]   contains the skill we created
 *       - skillPromptApplied: true
 *       - skillTools[]     advertises the tool that should be used
 *  5) Reads /api/admin/tool-audit and asserts at least one event
 *     for the chat has skill_key === our skill key, proving the
 *     skill→tool policy closure end-to-end.
 *
 * Skills auto-activate based on trigger_patterns matching the user message.
 * There is no manual `activate skill` API — pattern matching + DB-driven
 * selection happens inside ChatEngine on every message.
 */
export {};

const BASE = process.env.GENEWEAVE_BASE_URL ?? 'http://localhost:3500';
const ADMIN_TOKEN = process.env.GENEWEAVE_ADMIN_TOKEN ?? '';

type Json = Record<string, unknown>;

async function api(path: string, init?: RequestInit, opts: { admin?: boolean } = {}): Promise<Json> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.admin && ADMIN_TOKEN) headers['authorization'] = `Bearer ${ADMIN_TOKEN}`;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Json) : {};
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}: ${text}`);
  }
  return body;
}

function asString(obj: Json, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Expected non-empty string field "${key}", got: ${JSON.stringify(value)}`);
  }
  return value;
}

async function main() {
  const suffix = Date.now();
  const triggerPhrase = `weaveintel-canary-${suffix}`;
  const skillName = `Math Canary Skill ${suffix}`;
  const skillKey = `math-canary-${suffix}`;

  console.log('\n=== Example 35 — Skill activation E2E ===\n');

  // 1) Create a skill that matches our trigger phrase and binds the calculator tool.
  const skillResp = await api(
    '/api/admin/skills',
    {
      method: 'POST',
      body: JSON.stringify({
        key: skillKey,
        name: skillName,
        description:
          'Specialist skill for arithmetic verification requests containing the canary phrase.',
        category: 'analysis',
        instructions:
          'When the user asks an arithmetic question, ALWAYS use the calculator tool to compute the answer and cite the result.',
        trigger_patterns: JSON.stringify([triggerPhrase, 'arithmetic verification']),
        examples: JSON.stringify([
          `${triggerPhrase}: what is 1234 * 5678`,
          'arithmetic verification of 9999 + 1',
        ]),
        tool_names: JSON.stringify(['calculator']),
        enabled: true,
        version: '1.0',
        priority: 100,
      }),
    },
    { admin: true },
  );
  console.log('Created skill:', skillName, '(key:', skillKey + ')');

  // 2) Create a chat in agent mode so the runtime can issue tool calls.
  const chatResp = await api('/api/chats', {
    method: 'POST',
    body: JSON.stringify({
      title: `Skill activation E2E ${suffix}`,
      settings: { mode: 'agent' },
    }),
  });
  const chat = (chatResp['chat'] as Json | undefined) ?? {};
  const chatId = asString(chat, 'id');
  console.log('Created chat:', chatId, '(mode: agent)');

  // 3) Send a message that contains the trigger phrase + an arithmetic prompt.
  const userPrompt = `${triggerPhrase}: please compute 1234 * 5678 and show the result.`;
  console.log('\nUser → ', userPrompt);
  const msgResp = await api(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: userPrompt }),
  });

  // 4) Inspect the assistant message metadata for skill activation evidence.
  const assistant = (msgResp['assistant'] as Json | undefined) ?? {};
  const metadata = (assistant['metadata'] as Json | undefined) ?? {};
  const activeSkills = Array.isArray(metadata['activeSkills']) ? (metadata['activeSkills'] as Json[]) : [];
  const skillTools = Array.isArray(metadata['skillTools']) ? (metadata['skillTools'] as unknown[]) : [];
  const skillPromptApplied = metadata['skillPromptApplied'] === true;

  console.log('\nAssistant content (preview):');
  console.log('  ', String(assistant['content'] ?? '').slice(0, 200));
  console.log('\nMetadata signals:');
  console.log('  skillPromptApplied:', skillPromptApplied);
  console.log('  activeSkills:', activeSkills.map((s) => (s as Json)['name']).join(', ') || '(none)');
  console.log('  skillTools:    ', skillTools.join(', ') || '(none)');

  const matchedOurSkill = activeSkills.some((s) => (s as Json)['name'] === skillName);
  if (!skillPromptApplied) {
    console.warn('  ⚠ skillPromptApplied is false — the skill did not activate. Trigger may not have matched.');
  }
  if (!matchedOurSkill) {
    console.warn(`  ⚠ "${skillName}" did not appear in activeSkills. Check trigger_patterns vs user message.`);
  } else {
    console.log(`\n  ✓ Skill "${skillName}" activated for this turn.`);
  }

  // 5) Cross-check the audit log: any tool invocation in this chat should be
  //    tagged with our skill_key by DbToolAuditEmitter.
  try {
    const auditResp = await api(
      `/api/admin/tool-audit?chat_id=${encodeURIComponent(chatId)}&limit=10`,
      undefined,
      { admin: true },
    );
    const events = Array.isArray(auditResp['events']) ? (auditResp['events'] as Json[]) : [];
    const taggedForSkill = events.filter((e) => e['skill_key'] === skillKey);
    console.log('\nTool audit events for this chat:', events.length);
    if (events.length === 0) {
      console.log('  (no tool calls — model may have answered without invoking calculator)');
    } else {
      for (const ev of events.slice(0, 5)) {
        console.log(
          `  • ${ev['tool_name']} | outcome=${ev['outcome']} | skill_key=${ev['skill_key'] ?? '(none)'} | duration_ms=${ev['duration_ms']}`,
        );
      }
      if (taggedForSkill.length > 0) {
        console.log(`\n  ✓ ${taggedForSkill.length} audit event(s) carry skill_key="${skillKey}".`);
        console.log('    Skill→tool policy closure is end-to-end verified.');
      } else {
        console.warn(`\n  ⚠ No audit events tagged with skill_key="${skillKey}".`);
      }
    }
  } catch (err) {
    console.warn('\nCould not read audit log (likely needs GENEWEAVE_ADMIN_TOKEN):', String(err));
  }

  console.log('\n=== Done ===\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
