// SPDX-License-Identifier: MIT
// Test-only builders (left out of the published files).

import type { EngineClass } from './constants.js';
import type { DeviceState } from './probe.js';
import { sealTicket, type ChainStep, type RoutingTicket, type TicketBody } from './ticket.js';

export const NOW = Date.parse('2026-11-14T00:00:00.000Z');

export function step(
  position: number,
  engineClass: EngineClass,
  modelKey = engineClass === 'tenant-hosted' || engineClass === 'platform-hosted' ? '' : 'model-a',
  over: Partial<ChainStep> = {},
): ChainStep {
  return {
    position,
    engineClass,
    modelKey,
    timeoutMs: 1000,
    minConfidence: 0,
    maxDownloadMb: 0,
    offlineOk: false,
    files: [],
    ...over,
  };
}

export function body(over: Partial<TicketBody> = {}): TicketBody {
  return {
    ticketId: 'tkt-1',
    tenantId: 'tenant-a',
    person: 'person-1',
    task: 'text.language',
    record: { table: 'incident', id: 'INC0001' },
    fields: ['short_description', 'description'],
    steps: [step(1, 'stub'), step(2, 'tenant-hosted')],
    policyVersion: 3,
    expiresAt: new Date(NOW + 120_000).toISOString(),
    ...over,
  };
}

export function ticket(over: Partial<TicketBody> = {}): Promise<RoutingTicket> {
  return sealTicket(body(over));
}

export const WEB: DeviceState = { shell: 'web', online: true };
