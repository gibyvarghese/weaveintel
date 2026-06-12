/**
 * Example 140 — Action-item + reminder lifecycle
 *
 * Demonstrates the full action-item / reminder workflow using
 * @weaveintel/human-tasks and @weaveintel/triggers in-process:
 *
 *  1. Create an action-item task with provenance
 *  2. Create a one-shot reminder trigger linked to the same sourceRunId
 *  3. Fire the ReminderBusTargetAdapter manually to emit `reminder.due`
 *  4. Assert the bus event is emitted and the trigger is auto-disabled
 *  5. Complete the action-item via completeActionItem
 *  6. Assert task.completed bus event emitted
 *
 * No DB, no LLM, no external services.
 */

import assert from 'node:assert/strict';
import { createActionItem, completeActionItem } from '@weaveintel/human-tasks';
import { InMemoryHumanTaskRepository } from '@weaveintel/human-tasks';
import {
  InMemoryTriggerStore,
  createReminderTrigger,
  ReminderBusTargetAdapter,
} from '@weaveintel/triggers';

// ---------------------------------------------------------------------------
// Minimal bus stub
// ---------------------------------------------------------------------------

interface BusEvent { type: string; timestamp: number; data: Record<string, unknown>; tenantId?: string }

function buildBus() {
  const emitted: BusEvent[] = [];
  return {
    emit(event: BusEvent) { emitted.push(event); },
    emitted,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const repo = new InMemoryHumanTaskRepository();
  const triggerStore = new InMemoryTriggerStore();
  const bus = buildBus();

  // ── Step 1: create action-item ──────────────────────────────────────────

  const task = createActionItem({
    title: 'Review the weekly report',
    priority: 'high',
    provenance: { createdBy: 'agent', sourceRunId: 'run-weekly-42', sourceRef: 'weekly-report-tool' },
  });
  await repo.save(task);
  assert.equal(task.type, 'action-item', 'task type is action-item');
  assert.equal(task.blocking, false, 'action-items never block');
  console.log('  created action-item:', task.id);

  // ── Step 2: create a one-shot reminder trigger ──────────────────────────

  const fireAt = new Date(Date.now() + 60_000).toISOString();  // 1 min from now
  const reminder = createReminderTrigger({
    ownerPrincipalId: 'user-1',
    label: 'Review reminder',
    fireAt,
    provenance: { sourceRunId: 'run-weekly-42', sourceRef: 'action-item-created' },
  });
  await triggerStore.save(reminder);

  assert.equal(reminder.target.kind, 'reminder_bus', 'target kind is reminder_bus');
  assert.equal(reminder.source.kind, 'cron', 'source kind is cron');
  assert.equal(reminder.metadata?.['oneShot'], true, 'one-shot flag set');
  assert.equal(reminder.enabled, true, 'reminder enabled initially');
  console.log('  created reminder:', reminder.id, 'fires at:', fireAt);

  // ── Step 3: manually fire the adapter ──────────────────────────────────

  const adapter = new ReminderBusTargetAdapter(bus, triggerStore);
  await adapter.dispatch(
    reminder.target,
    { fireAt, triggerId: reminder.id },
    { triggerId: reminder.id, triggerKey: reminder.key, firedAt: Date.now() },
  );

  // ── Step 4: assert bus event + auto-disabled ────────────────────────────

  const reminderDueEvent = bus.emitted.find((e) => e.type === 'reminder.due');
  assert.ok(reminderDueEvent, 'reminder.due event emitted');
  assert.equal(
    (reminderDueEvent!.data as Record<string, unknown>)['label'],
    'Review reminder',
    'event carries reminder label',
  );

  const afterFire = await triggerStore.get(reminder.id);
  assert.equal(afterFire?.enabled, false, 'one-shot trigger auto-disabled after firing');
  console.log('  reminder.due fired and trigger disabled');

  // ── Step 5: complete the action-item ───────────────────────────────────

  const completed = await completeActionItem(task.id, { repository: repo, bus, tenantId: 'tenant-a' });
  assert.equal(completed.status, 'completed', 'task status is completed');
  assert.ok(completed.completedAt, 'completedAt set');

  // ── Step 6: assert task.completed event ────────────────────────────────

  const completedEvent = bus.emitted.find((e) => e.type === 'task.completed');
  assert.ok(completedEvent, 'task.completed event emitted');
  assert.equal(completedEvent!.tenantId, 'tenant-a', 'event carries tenantId');
  console.log('  task completed, task.completed event emitted');

  console.log('\nexample-140 passed — action-item + reminder lifecycle');
  console.log('  bus events:', bus.emitted.map((e) => e.type));
}

main().catch((err) => { console.error(err); process.exit(1); });
