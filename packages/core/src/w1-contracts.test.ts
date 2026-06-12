/**
 * @weaveintel/core — W1 platform contracts unit tests
 *
 * Verifies the shape, required fields, and structural invariants of the new
 * RunHandle, NotificationMessage, SurfaceCatalog, WidgetPayload extensions,
 * and HumanTask extensions added in W1.
 *
 * No LLM, no DB, no network — pure type + structural assertions.
 */

import { describe, it, expect } from 'vitest';
import type {
  RunHandle,
  RunEventCursor,
  RunStatus,
  RunOrigin,
  NotificationMessage,
  NotificationChannel,
  ChannelTarget,
  NotificationDelivery,
  SurfaceCatalog,
  CatalogEntry,
  SurfaceCatalogRequest,
  WidgetPayload,
  WidgetFallback,
  HumanTask,
  TaskProvenance,
} from './index.js';

// ─── RunHandle ────────────────────────────────────────────────────────────────

describe('RunHandle contract', () => {
  const handle: RunHandle = {
    runId: '018f-abc',
    tenantId: 'tenant-1',
    principalId: 'user-1',
    origin: 'interactive',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSequence: 0,
  };

  it('satisfies the RunHandle shape', () => {
    expect(handle.runId).toBe('018f-abc');
    expect(handle.origin).toBe('interactive');
    expect(handle.status).toBe('running');
    expect(handle.progress).toBeUndefined();
    expect(handle.error).toBeUndefined();
  });

  it('terminal handle with error', () => {
    const failed: RunHandle = {
      ...handle,
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: { code: 'TIMEOUT', message: 'Run timed out' },
    };
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('TIMEOUT');
  });

  it('RunEventCursor links runId to afterSequence', () => {
    const cursor: RunEventCursor = { runId: handle.runId, afterSequence: 5 };
    expect(cursor.afterSequence).toBe(5);
  });

  it('all RunOrigin values accepted', () => {
    const origins: RunOrigin[] = ['interactive', 'trigger', 'workflow', 'system'];
    for (const origin of origins) {
      const h: RunHandle = { ...handle, origin };
      expect(h.origin).toBe(origin);
    }
  });

  it('all RunStatus values accepted', () => {
    const statuses: RunStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled'];
    for (const status of statuses) {
      const h: RunHandle = { ...handle, status };
      expect(h.status).toBe(status);
    }
  });
});

// ─── NotificationMessage ──────────────────────────────────────────────────────

describe('NotificationMessage contract', () => {
  const msg: NotificationMessage = {
    id: 'notif-1',
    tenantId: 'tenant-1',
    principalId: 'user-1',
    category: 'run',
    title: 'Run completed',
  };

  it('satisfies minimal shape', () => {
    expect(msg.category).toBe('run');
    expect(msg.title).toBe('Run completed');
    expect(msg.body).toBeUndefined();
    expect(msg.deepLink).toBeUndefined();
    expect(msg.priority).toBeUndefined();
  });

  it('full shape with actions and data', () => {
    const full: NotificationMessage = {
      ...msg,
      body: 'Your analysis run is complete',
      deepLink: 'geneweave://run/018f-abc',
      actions: [
        { id: 'view', label: 'View Results' },
        { id: 'dismiss', label: 'Dismiss' },
      ],
      data: { runId: '018f-abc' },
      collapseKey: 'run:018f-abc',
      priority: 'high',
    };
    expect(full.actions).toHaveLength(2);
    expect(full.priority).toBe('high');
  });
});

// ─── ChannelTarget ────────────────────────────────────────────────────────────

describe('ChannelTarget', () => {
  it('tenantId and principalId must NOT appear in address (documentation invariant)', () => {
    const target: ChannelTarget = {
      kind: 'web-push',
      address: 'https://fcm.googleapis.com/fcm/send/TOKEN',
    };
    // The address does not contain tenant or principal ids — this is enforced
    // by convention and code review; here we verify the shape is opaque.
    expect(target.kind).toBe('web-push');
    expect(target.address).not.toContain('tenant-1');
    expect(target.address).not.toContain('user-1');
  });
});

// ─── SurfaceCatalog ───────────────────────────────────────────────────────────

describe('SurfaceCatalog contract', () => {
  const req: SurfaceCatalogRequest = { surfaceId: 'mobile' };

  const catalog: SurfaceCatalog = {
    surfaceId: 'mobile',
    entries: [
      { id: 'entry-1', kind: 'mode', label: 'Assistant', default: true },
      { id: 'entry-2', kind: 'agent', label: 'Research Agent' },
      { id: 'entry-3', kind: 'model', label: 'GPT-4o' },
    ],
    resolvedAt: new Date().toISOString(),
  };

  it('satisfies catalog shape', () => {
    expect(catalog.surfaceId).toBe('mobile');
    expect(catalog.entries).toHaveLength(3);
    expect(catalog.entries[0]?.default).toBe(true);
  });

  it('all CatalogEntry kinds accepted', () => {
    const kinds: CatalogEntry['kind'][] = ['mode', 'agent', 'model', 'skill', 'tool', 'custom'];
    for (const kind of kinds) {
      const entry: CatalogEntry = { id: `e-${kind}`, kind, label: kind };
      expect(entry.kind).toBe(kind);
    }
  });

  it('request has surfaceId', () => {
    expect(req.surfaceId).toBe('mobile');
  });
});

// ─── WidgetPayload extensions ─────────────────────────────────────────────────

describe('WidgetPayload W1 extensions', () => {
  const fallback: WidgetFallback = { kind: 'text', text: 'Table: 3 rows, 2 columns' };

  const widget: WidgetPayload = {
    id: 'w-1',
    type: 'table',
    data: { columns: ['A', 'B'], rows: [[1, 2], [3, 4], [5, 6]] },
    interactive: false,
    a11ySummary: 'Table with 3 rows and 2 columns showing data A and B',
    fallback,
    schemaVersion: 1,
  };

  it('accepts new optional fields', () => {
    expect(widget.a11ySummary).toContain('3 rows');
    expect(widget.fallback?.kind).toBe('text');
    expect(widget.schemaVersion).toBe(1);
  });

  it('existing widgets without new fields still satisfy the interface', () => {
    const bare: WidgetPayload = { id: 'w-2', type: 'chart', data: {}, interactive: false };
    expect(bare.a11ySummary).toBeUndefined();
    expect(bare.fallback).toBeUndefined();
    expect(bare.schemaVersion).toBeUndefined();
  });

  it('fallback link kind has href', () => {
    const linkFallback: WidgetFallback = { kind: 'link', text: 'View data', href: '/data/123' };
    expect(linkFallback.href).toBe('/data/123');
  });
});

// ─── HumanTask extensions ─────────────────────────────────────────────────────

describe('HumanTask W1 extensions', () => {
  const provenance: TaskProvenance = {
    sourceRunId: 'run-123',
    sourceRef: 'step-4',
    createdBy: 'agent',
  };

  it('action-item task has blocking:false and dueAt', () => {
    const task: HumanTask = {
      id: 'task-1',
      type: 'action-item',
      title: 'Review analysis output',
      status: 'pending',
      priority: 'normal',
      createdAt: new Date().toISOString(),
      blocking: false,
      provenance,
      dueAt: '2026-12-31T00:00:00.000Z',
    };
    expect(task.type).toBe('action-item');
    expect(task.blocking).toBe(false);
    expect(task.provenance?.createdBy).toBe('agent');
    expect(task.dueAt).toBeTruthy();
  });

  it('existing approval task without new fields is still valid', () => {
    const task: HumanTask = {
      id: 'task-2',
      type: 'approval',
      title: 'Approve deploy',
      status: 'pending',
      priority: 'high',
      createdAt: new Date().toISOString(),
    };
    expect(task.blocking).toBeUndefined();
    expect(task.provenance).toBeUndefined();
    expect(task.dueAt).toBeUndefined();
  });

  it('provenance system creator', () => {
    const p: TaskProvenance = { createdBy: 'system' };
    expect(p.createdBy).toBe('system');
    expect(p.sourceRunId).toBeUndefined();
  });
});
