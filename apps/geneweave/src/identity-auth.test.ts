/**
 * @weaveintel/geneweave — Identity + persona auth tests
 */

import { describe, expect, it } from 'vitest';
import { canUseTool, normalizePersona, personaPermissions } from './rbac.js';
import { createToolRegistry } from './tools.js';
import { settingsFromRow } from './chat.js';
import type { ChatSettingsRow } from './db.js';

describe('GeneWeave identity/persona auth for agents + tools', () => {
  it('default denies tool use when persona is missing or invalid', () => {
    expect(canUseTool(undefined, 'web_search')).toBe(false);
    expect(canUseTool(null, 'calculator')).toBe(false);
    expect(canUseTool('not_a_real_persona', 'web_search')).toBe(false);
    expect(personaPermissions('not_a_real_persona')).toEqual([]);
  });

  it('allows and denies tools correctly for valid personas', () => {
    expect(canUseTool('tenant_user', 'web_search')).toBe(true);
    expect(canUseTool('tenant_user', 'browser_open')).toBe(false);

    expect(canUseTool('agent_researcher', 'browser_open')).toBe(true);
    expect(canUseTool('tenant_admin', 'browser_open')).toBe(true);
  });

  it('creates an empty registry when actor persona is missing/invalid', () => {
    const noPersona = createToolRegistry(['web_search', 'calculator'], undefined, { actorPersona: undefined });
    expect(noPersona.list().length).toBe(0);

    const invalidPersona = createToolRegistry(['web_search', 'calculator'], undefined, { actorPersona: 'bad_persona' });
    expect(invalidPersona.list().length).toBe(0);
  });

  it('attaches the right tool access when actor persona is valid', () => {
    const tenantUserRegistry = createToolRegistry(
      ['web_search', 'browser_open', 'calculator'],
      undefined,
      { actorPersona: 'tenant_user' },
    );
    const tenantUserNames = tenantUserRegistry.list().map((t) => t.schema.name);

    expect(tenantUserNames).toContain('web_search');
    expect(tenantUserNames).toContain('calculator');
    expect(tenantUserNames).not.toContain('browser_open');

    const researcherRegistry = createToolRegistry(
      ['web_search', 'browser_open', 'calculator'],
      undefined,
      { actorPersona: 'agent_researcher' },
    );
    const researcherNames = researcherRegistry.list().map((t) => t.schema.name);
    expect(researcherNames).toContain('web_search');
    expect(researcherNames).toContain('calculator');
    expect(researcherNames.length).toBeGreaterThanOrEqual(2);
  });

  it('normalizes worker personas and keeps agent identity usable', () => {
    const row: ChatSettingsRow = {
      chat_id: 'chat-1',
      mode: 'supervisor',
      system_prompt: null,
      timezone: null,
      enabled_tools: JSON.stringify(['web_search', 'browser_open']),
      redaction_enabled: 0,
      redaction_patterns: null,
      workers: JSON.stringify([
        { name: 'r1', description: 'Research worker', tools: ['web_search', 'browser_open'], persona: 'bad_persona' },
      ]),
      updated_at: new Date().toISOString(),
    };

    const settings = settingsFromRow(row);
    expect(settings.workers[0]?.persona).toBe('agent_worker');

    const workerPersona = normalizePersona(settings.workers[0]?.persona, 'agent');
    const workerRegistry = createToolRegistry(settings.workers[0]?.tools ?? [], undefined, {
      actorPersona: workerPersona,
    });
    const workerTools = workerRegistry.list().map((t) => t.schema.name);

    // agent_worker can still use normal tools even when incoming persona was invalid
    expect(workerTools).toContain('web_search');
    // but not browser automation tools by default
    expect(workerTools).not.toContain('browser_open');
  });
});
