import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SQLiteAdapter } from './db-sqlite.js';

function makeTempDbPath(): string {
  return `/tmp/geneweave-sgap-test-${Date.now()}-${randomUUID()}.db`;
}

describe('SQLite SGAP CRUD and seed data', () => {
  it('seeds the tech-lunch SGAP baseline', async () => {
    const db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
    await db.seedDefaultData();

    const brands = await db.listSgapTableRows('sg_brands');
    const channels = await db.listSgapTableRows('sg_channels');
    const queue = await db.listSgapTableRows('sg_content_queue');
    const agents = await db.listSgapTableRows('sg_agent_profiles');
    const bindings = await db.listSgapTableRows('sg_tool_bindings');
    const prompt = await db.getPromptByKey('sgap.tech_lunch.post_brief');
    const skill = await db.getSkill('0533eb6b-c030-44c9-bba2-79fca66ae213');
    const worker = await db.getWorkerAgent('4af84061-f85c-4f6f-9979-2a5a6eb7dbd7');
    const workflow = await db.getWorkflowDef('4c1f9b5f-8f89-4f9f-bb8f-65248a4f131d');
    const phase2Configs = await db.listSgapPhase2Configs('a80c1586-f133-4626-b2af-2a945b854f22', '675d4a3d-7c6f-4b4b-95c4-2eeb3d0b43f1');

    expect(brands.some((b) => b['slug'] === 'tech-lunch')).toBe(true);
    expect(channels.length).toBeGreaterThanOrEqual(6);
    expect(queue.length).toBeGreaterThanOrEqual(3);
    expect(agents.some((a) => a['name'] === 'sg-audience-critic')).toBe(true);
    expect(agents.some((a) => a['name'] === 'sg-brand-guardian')).toBe(true);
    expect(agents.some((a) => a['name'] === 'sg-hook-optimizer')).toBe(true);
    expect(agents.some((a) => a['name'] === 'sg-distribution-optimizer')).toBe(true);
    expect(agents.some((a) => a['name'] === 'sg-experiment-designer')).toBe(true);
    expect(bindings.some((b) => b['tool_name'] === 'social_insights_read')).toBe(true);
    expect(bindings.some((b) => b['tool_name'] === 'social_comments_read')).toBe(true);
    expect(bindings.some((b) => b['tool_name'] === 'social_post')).toBe(true);
    expect(prompt?.key).toBe('sgap.tech_lunch.post_brief');
    expect(skill?.name).toBe('SGAP Tech Lunch Growth Loop');
    expect(worker?.name).toBe('sg-content-operator');
    expect(workflow?.name).toBe('SGAP Tech Lunch Weekly Loop');
    expect(phase2Configs.length).toBeGreaterThanOrEqual(1);
    expect(phase2Configs[0]?.writer_agent_id).toBe('c092da65-e39b-4ef8-9db5-c2f76666d5ce');
  });

  it('supports generic CRUD for SGAP tables', async () => {
    const db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();

    const brandId = `sg-brand-${randomUUID().slice(0, 8)}`;
    await db.createSgapTableRow('sg_brands', {
      id: brandId,
      name: 'Test Brand',
      slug: `test-brand-${randomUUID().slice(0, 6)}`,
      description: 'SGAP test brand',
      enabled: 1,
    });

    const created = await db.getSgapTableRow('sg_brands', brandId);
    expect(created).not.toBeNull();
    expect(created?.['name']).toBe('Test Brand');

    await db.updateSgapTableRow('sg_brands', brandId, {
      name: 'Updated Brand',
      voice: 'Friendly and tactical',
    });

    const updated = await db.getSgapTableRow('sg_brands', brandId);
    expect(updated?.['name']).toBe('Updated Brand');
    expect(updated?.['voice']).toBe('Friendly and tactical');

    await db.deleteSgapTableRow('sg_brands', brandId);
    const deleted = await db.getSgapTableRow('sg_brands', brandId);
    expect(deleted).toBeNull();
  });

  it('supports SGAP Phase 2 config and revision APIs', async () => {
    const db = new SQLiteAdapter(makeTempDbPath());
    await db.initialize();
    await db.seedDefaultData();

    const configId = randomUUID();
    const brandId = `test-brand-${randomUUID().slice(0, 8)}`;
    const workflowTemplateId = `test-workflow-${randomUUID().slice(0, 8)}`;

    await db.createSgapTableRow('sg_brands', {
      id: brandId,
      name: 'Test SGAP Brand',
      slug: `test-sgap-${randomUUID().slice(0, 6)}`,
      description: 'Phase 2 config test brand',
      enabled: 1,
    });

    await db.createSgapTableRow('sg_workflow_templates', {
      id: workflowTemplateId,
      brand_id: brandId,
      name: 'Test Phase 2 Workflow',
      description: 'Workflow for SGAP phase 2 config tests',
      step_graph_json: JSON.stringify({ steps: [] }),
      trigger_type: 'manual',
      enabled: 1,
    });

    await db.createSgapPhase2Config({
      id: configId,
      application_scope: 'sgap',
      brand_id: brandId,
      workflow_template_id: workflowTemplateId,
      writer_agent_id: 'c092da65-e39b-4ef8-9db5-c2f76666d5ce',
      researcher_agent_id: '0f30f5be-72d7-44c4-b96e-98cc95f6d4f8',
      editor_agent_id: 'e9e4c8e9-05db-40dd-a660-70d2be7a6d6f',
      max_feedback_rounds: 3,
      min_research_confidence: 0.8,
      require_research_citations: 1,
      auto_escalate_to_compliance: 1,
      output_format: 'markdown',
      enabled: 1,
    });

    const config = await db.getSgapPhase2Config(configId);
    expect(config).not.toBeNull();
    expect(config?.max_feedback_rounds).toBe(3);

    await db.updateSgapPhase2Config(configId, { min_research_confidence: 0.76, enabled: 0 });
    const updated = await db.getSgapPhase2Config(configId);
    expect(updated?.min_research_confidence).toBe(0.76);
    expect(updated?.enabled).toBe(0);

    const revisionId = randomUUID();
    const runId = randomUUID();
    await db.createSgapWorkflowRun({
      id: runId,
      application_scope: 'sgap',
      brand_id: brandId,
      workflow_template_id: workflowTemplateId,
      status: 'running',
      current_stage: 'phase2-content-creation',
      current_agent_id: 'c092da65-e39b-4ef8-9db5-c2f76666d5ce',
      input_json: JSON.stringify({ test: true }),
      state_json: JSON.stringify({}),
      error_message: undefined,
      completed_at: undefined,
    });

    await db.createSgapTableRow('sg_content_queue', {
      id: '8f0f0df9-a916-4e6f-b2fd-1d9cf964f97e',
      brand_id: brandId,
      campaign_id: null,
      channel_id: null,
      title: 'Test queue item',
      brief: 'Queue item for revision test',
      format: 'text',
      status: 'draft',
      enabled: 1,
    });

    await db.createSgapContentRevision({
      id: revisionId,
      application_scope: 'sgap',
      workflow_run_id: runId,
      content_item_id: '8f0f0df9-a916-4e6f-b2fd-1d9cf964f97e',
      agent_id: 'c092da65-e39b-4ef8-9db5-c2f76666d5ce',
      stage: 'writer',
      revision_index: 1,
      content_text: 'Initial draft for testing',
      notes_json: JSON.stringify({ source: 'test' }),
    });

    const revisions = await db.listSgapContentRevisions(runId);
    expect(revisions.length).toBe(1);
    expect(revisions[0]?.id).toBe(revisionId);
  });
});
