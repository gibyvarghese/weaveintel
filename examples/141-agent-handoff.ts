/**
 * Example 141 — Agent handoff / lateral transfer (P3-2)
 *
 * Demonstrates how weaveAgent transfers control to a peer agent mid-task
 * without requiring a supervisor:
 *
 *   handoffs — list of HandoffDefinition entries registered as
 *              transfer_to_<name> tools
 *   HandoffMetadata — result.metadata.handoff describes the transfer
 *
 * Scenarios shown:
 *   1. Triage → specialist: a general agent hands off to a billing agent
 *   2. Escalation chain:    agent hands off to a human-escalation agent
 *   3. No-transfer baseline: same triage agent handles the task directly
 *
 * Usage:
 *   npx ts-node examples/141-agent-handoff.ts
 */

import { weaveContext, weaveRuntime, weaveToolRegistry, weaveTool } from '@weaveintel/core';
import { weaveAgent, type HandoffMetadata } from '@weaveintel/agents';
import { createMockModel } from '@weaveintel/devtools';

const runtime = weaveRuntime({});

function makeCtx() {
  return weaveContext({ executionId: `ex-${Date.now()}`, runtime });
}

// ─── Scenario 1: Triage → specialist handoff ──────────────────

async function scenario1TriageToSpecialist() {
  console.log('\n── Scenario 1: Triage → billing specialist ──');

  // Specialist agent that handles billing questions
  const billingModel = createMockModel([
    { content: 'Your invoice #INV-2024-001 shows a balance of $150. Would you like to pay now?' },
  ]);
  const billingAgent = weaveAgent({
    model: billingModel,
    name: 'billing-agent',
    systemPrompt: 'You are a billing specialist.',
  });

  // Triage agent — will hand off to billing when asked about invoices
  const triageModel = createMockModel([
    { toolCalls: [{ id: 'tc1', name: 'transfer_to_billing', arguments: '{"context":"User is asking about invoice INV-2024-001. They want to know their balance.","reason":"Billing question"}' }] },
  ]);
  const triageAgent = weaveAgent({
    model: triageModel,
    name: 'triage-agent',
    systemPrompt: 'You are a customer service triage agent. Route billing questions to the billing agent.',
    handoffs: [
      {
        name: 'billing',
        description: 'Handles billing, invoices, and payment questions.',
        agent: billingAgent,
      },
    ],
  });

  const result = await triageAgent.run(makeCtx(), {
    goal: 'What is my invoice balance?',
    messages: [{ role: 'user', content: 'What is my invoice balance for INV-2024-001?' }],
  });

  const handoff = result.metadata?.['handoff'] as HandoffMetadata | undefined;
  console.log('Final output:', result.output);
  console.log('Status:', result.status);
  if (handoff) {
    console.log(`Handed off from "${handoff.from}" → "${handoff.to}"`);
    console.log('Transfer context:', handoff.transferInput);
  }
}

// ─── Scenario 2: Escalation chain ────────────────────────────

async function scenario2EscalationChain() {
  console.log('\n── Scenario 2: Escalation chain (support → escalation) ──');

  // Escalation agent handles complex issues
  const escalationModel = createMockModel([
    { content: 'I have escalated your issue to our senior team. A specialist will contact you within 2 hours.' },
  ]);
  const escalationAgent = weaveAgent({
    model: escalationModel,
    name: 'escalation-agent',
    systemPrompt: 'You handle escalated issues that tier-1 support cannot resolve.',
  });

  // Tier-1 support: tries to help, then escalates
  const supportModel = createMockModel([
    { toolCalls: [{ id: 'tc2', name: 'transfer_to_escalation', arguments: '{"context":"User reports complete outage affecting their production system for 3 hours. Tier-1 has no resolution.","reason":"Complex production outage beyond tier-1 scope"}' }] },
  ]);
  const supportAgent = weaveAgent({
    model: supportModel,
    name: 'support-agent',
    systemPrompt: 'You are tier-1 customer support.',
    handoffs: [
      {
        name: 'escalation',
        description: 'Escalate production outages or issues tier-1 cannot resolve.',
        agent: escalationAgent,
      },
    ],
  });

  const result = await supportAgent.run(makeCtx(), {
    goal: 'Production system outage',
    messages: [{ role: 'user', content: 'Our production system has been down for 3 hours!' }],
  });

  const handoff = result.metadata?.['handoff'] as HandoffMetadata | undefined;
  console.log('Final output:', result.output);
  console.log('Status:', result.status);
  if (handoff) {
    console.log(`Escalation: "${handoff.from}" → "${handoff.to}"`);
  }
}

// ─── Scenario 3: No handoff (direct resolution) ───────────────

async function scenario3NoHandoff() {
  console.log('\n── Scenario 3: No handoff (triage resolves directly) ──');

  // Agent that CAN handoff but chooses not to for simple questions
  const directModel = createMockModel([
    { content: 'Our support hours are Monday-Friday, 9 AM to 5 PM EST.' },
  ]);
  const agent = weaveAgent({
    model: directModel,
    name: 'triage-direct',
    systemPrompt: 'You are a customer service agent.',
    handoffs: [
      {
        name: 'billing',
        description: 'Route billing questions here.',
        agent: weaveAgent({ model: createMockModel([{ content: '' }]), name: 'billing' }),
      },
    ],
  });

  const result = await agent.run(makeCtx(), {
    goal: 'Support hours query',
    messages: [{ role: 'user', content: 'What are your support hours?' }],
  });

  console.log('Final output:', result.output);
  console.log('Status:', result.status);
  console.log('Handoff occurred:', result.metadata?.['handoff'] ? 'yes' : 'no');
}

// ─── Run all scenarios ─────────────────────────────────────────

(async () => {
  await scenario1TriageToSpecialist();
  await scenario2EscalationChain();
  await scenario3NoHandoff();
  console.log('\n✓ All handoff scenarios complete.');
})().catch(console.error);
