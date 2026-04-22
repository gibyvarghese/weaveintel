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
    const prompt = await db.getPromptByKey('sgap.tech_lunch.post_brief');
    const skill = await db.getSkill('0533eb6b-c030-44c9-bba2-79fca66ae213');
    const worker = await db.getWorkerAgent('4af84061-f85c-4f6f-9979-2a5a6eb7dbd7');
    const workflow = await db.getWorkflowDef('4c1f9b5f-8f89-4f9f-bb8f-65248a4f131d');

    expect(brands.some((b) => b['slug'] === 'tech-lunch')).toBe(true);
    expect(channels.length).toBeGreaterThanOrEqual(3);
    expect(queue.length).toBeGreaterThanOrEqual(1);
    expect(prompt?.key).toBe('sgap.tech_lunch.post_brief');
    expect(skill?.name).toBe('SGAP Tech Lunch Growth Loop');
    expect(worker?.name).toBe('sg-content-operator');
    expect(workflow?.name).toBe('SGAP Tech Lunch Weekly Loop');
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
});
