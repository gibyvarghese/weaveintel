import { describe, it, expect } from 'vitest';
import {
  validateManifest,
  PackValidationError,
  installPack,
  uninstallPack,
  resolveActivePackVersion,
  compareSemver,
  type CapabilityPack,
  type PackInstallAdapter,
  type PackVersionRow,
} from './index.js';

const validPack: CapabilityPack = {
  manifestVersion: '1',
  key: 'demo.echo',
  version: '1.0.0',
  name: 'Echo Demo',
  description: 'Trivial echo workflow capability',
  preconditions: { requiredHandlerKinds: ['noop'] },
  contents: {
    workflows: [{ id: 'wf-echo', name: 'Echo' }],
    workflowSteps: [
      { id: 'step-1', workflow_id: 'wf-echo', handler: 'noop' },
      { id: 'step-2', workflow_id: 'wf-echo', handler: 'noop' },
    ],
  },
};

describe('validateManifest', () => {
  it('accepts a valid pack', () => {
    const r = validateManifest(validPack);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('rejects bad semver', () => {
    const r = validateManifest({ ...validPack, version: 'one.zero.zero' });
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.path === 'version')).toBeTruthy();
  });

  it('rejects bad key', () => {
    const r = validateManifest({ ...validPack, key: 'Demo Pack!' });
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.path === 'key')).toBeTruthy();
  });

  it('rejects missing name', () => {
    const r = validateManifest({ ...validPack, name: '' });
    expect(r.ok).toBe(false);
  });

  it('rejects rows without a string id', () => {
    const r = validateManifest({
      ...validPack,
      contents: { workflows: [{ name: 'no-id' } as Record<string, unknown>] },
    });
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.path.endsWith('.id'))).toBeTruthy();
  });

  it('rejects duplicate ids within a bucket', () => {
    const r = validateManifest({
      ...validPack,
      contents: {
        workflows: [
          { id: 'wf-1', name: 'A' },
          { id: 'wf-1', name: 'B' },
        ],
      },
    });
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.message.includes('duplicate'))).toBeTruthy();
  });

  it('rejects bad dependencies', () => {
    const r = validateManifest({
      ...validPack,
      dependencies: [{ packKey: 'Bad Key', versionRange: '' }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThanOrEqual(2);
  });
});

class StubAdapter implements PackInstallAdapter {
  rows = new Map<string, Map<string, Record<string, unknown>>>();
  presentHandlerKinds = new Set<string>();
  presentToolKeys = new Set<string>();
  txCount = 0;
  upsertCalls: Array<[string, string[]]> = [];
  deleteCalls: Array<[string, string[]]> = [];

  async checkPreconditions(pre: {
    requiredHandlerKinds?: string[];
    requiredToolKeys?: string[];
  }): Promise<string[]> {
    const missing: string[] = [];
    for (const k of pre.requiredHandlerKinds ?? []) {
      if (!this.presentHandlerKinds.has(k)) missing.push(`handler_kind:${k}`);
    }
    for (const k of pre.requiredToolKeys ?? []) {
      if (!this.presentToolKeys.has(k)) missing.push(`tool_key:${k}`);
    }
    return missing;
  }

  async upsertRows(kind: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<string[]> {
    if (!this.rows.has(kind)) this.rows.set(kind, new Map());
    const bucket = this.rows.get(kind)!;
    const ids: string[] = [];
    for (const row of rows) {
      const id = row['id'] as string;
      bucket.set(id, row);
      ids.push(id);
    }
    this.upsertCalls.push([kind, ids]);
    return ids;
  }

  async deleteRows(kind: string, rowIds: ReadonlyArray<string>): Promise<void> {
    const bucket = this.rows.get(kind);
    if (!bucket) return;
    for (const id of rowIds) bucket.delete(id);
    this.deleteCalls.push([kind, rowIds.slice()]);
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this.txCount += 1;
    return fn();
  }
}

describe('installPack', () => {
  it('installs all rows when preconditions are met', async () => {
    const adapter = new StubAdapter();
    adapter.presentHandlerKinds.add('noop');
    const { ledger, unmetPreconditions } = await installPack(validPack, adapter);
    expect(unmetPreconditions).toEqual([]);
    expect(ledger.packKey).toBe('demo.echo');
    expect(ledger.rowsByKind['workflows']).toEqual(['wf-echo']);
    expect(ledger.rowsByKind['workflowSteps']).toEqual(['step-1', 'step-2']);
    expect(adapter.txCount).toBe(1);
  });

  it('throws when preconditions are not met', async () => {
    const adapter = new StubAdapter();
    await expect(installPack(validPack, adapter)).rejects.toThrow(/preconditions not met/);
  });

  it('honours installOrder', async () => {
    const adapter = new StubAdapter();
    adapter.presentHandlerKinds.add('noop');
    await installPack(validPack, adapter, { installOrder: ['workflowSteps', 'workflows'] });
    expect(adapter.upsertCalls.map(([k]) => k)).toEqual(['workflowSteps', 'workflows']);
  });

  it('throws PackValidationError on a bad manifest', async () => {
    const adapter = new StubAdapter();
    await expect(
      installPack({ ...validPack, version: 'bad' }, adapter, { skipPreconditions: true }),
    ).rejects.toBeInstanceOf(PackValidationError);
  });

  it('skipPreconditions bypasses the check', async () => {
    const adapter = new StubAdapter();
    const { ledger } = await installPack(validPack, adapter, { skipPreconditions: true });
    expect(ledger.rowsByKind['workflows']).toBeDefined();
  });
});

describe('uninstallPack', () => {
  it('removes ledger rows in reverse order', async () => {
    const adapter = new StubAdapter();
    adapter.presentHandlerKinds.add('noop');
    const { ledger } = await installPack(validPack, adapter);
    await uninstallPack(ledger, adapter);
    expect(adapter.deleteCalls.map(([k]) => k)).toEqual(['workflowSteps', 'workflows']);
    expect(adapter.rows.get('workflows')!.size).toBe(0);
  });
});

describe('resolveActivePackVersion', () => {
  const rows: PackVersionRow[] = [
    { packKey: 'p.a', version: '1.0.0', status: 'published' },
    { packKey: 'p.a', version: '1.2.0', status: 'published' },
    { packKey: 'p.a', version: '1.1.0', status: 'published' },
    { packKey: 'p.a', version: '2.0.0', status: 'draft' },
    { packKey: 'p.b', version: '0.1.0', status: 'draft' },
  ];

  it('returns highest published when no override', () => {
    expect(resolveActivePackVersion(rows, 'p.a')!.version).toBe('1.2.0');
  });

  it('returns override exact version', () => {
    expect(resolveActivePackVersion(rows, 'p.a', { versionOverride: '2.0.0' })!.version).toBe(
      '2.0.0',
    );
  });

  it('falls back to draft when no published', () => {
    expect(resolveActivePackVersion(rows, 'p.b')!.version).toBe('0.1.0');
  });

  it('returns null when key absent', () => {
    expect(resolveActivePackVersion(rows, 'p.missing')).toBeNull();
  });
});

describe('compareSemver', () => {
  it('orders correctly', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });
});
