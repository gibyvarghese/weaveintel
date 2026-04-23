/**
 * Example 49 - live-agents Phase 11 external event routing
 *
 * Run: npx tsx examples/49-live-agents-phase11.ts
 */

import { weaveContext } from '@weaveintel/core';
import {
  createExternalEventHandler,
  type EventRoute,
  weaveInMemoryStateStore,
} from '@weaveintel/live-agents';

async function main() {
  const store = weaveInMemoryStateStore();
  const handler = createExternalEventHandler({ stateStore: store });
  const now = new Date().toISOString();

  const route: EventRoute = {
    id: 'route-phase11-1',
    meshId: 'mesh-phase11',
    accountId: 'account-phase11-gmail',
    matchDescriptionProse: 'Route customer issue emails to support agent.',
    matchExpr: '{"sourceType":"email.received","summaryIncludes":"customer"}',
    targetType: 'AGENT',
    targetId: 'agent-support-1',
    targetTopic: 'customer-support',
    priorityOverride: 'HIGH',
    enabled: true,
    createdAt: now,
  };
  await store.saveEventRoute(route);

  const result = await handler.process(
    {
      id: 'evt-phase11-1',
      accountId: 'account-phase11-gmail',
      sourceType: 'email.received',
      sourceRef: 'gmail-msg-101',
      receivedAt: now,
      payloadSummary: 'Customer reported a billing issue and needs urgent help',
      payloadContextRef: 'mcp://gmail/messages/gmail-msg-101',
      processedAt: null,
      producedMessageIds: [],
      processingStatus: 'RECEIVED',
      error: null,
    },
    weaveContext({ userId: 'human:ops-admin-1' }),
  );

  const inbox = await store.listMessagesForRecipient('AGENT', 'agent-support-1');
  const savedEvent = await store.findExternalEvent('account-phase11-gmail', 'email.received', 'gmail-msg-101');

  console.log('Live-agents Phase 11 external event routing is wired and running.');
  console.log(`Routed message count: ${result.routedMessageCount}`);
  console.log(`Inbox size for support agent: ${inbox.length}`);
  console.log(`Saved event status: ${savedEvent?.processingStatus ?? 'n/a'}`);
  console.log(`Saved event producedMessageIds: ${JSON.stringify(savedEvent?.producedMessageIds ?? [])}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
