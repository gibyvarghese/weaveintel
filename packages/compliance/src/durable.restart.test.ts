/**
 * Phase 4 — durable compliance managers must survive a process restart
 * (regulated-deployment requirement). One runtime writes, a fresh runtime
 * reads back via the same SQLite file.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { weaveRuntime } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import {
  createDurableLegalHoldManager,
  createDurableConsentManager,
  createDurableDeletionManager,
} from './durable.js';

describe('compliance — durable variants survive restart', () => {
  it('legal hold + consent + deletion request all persist across runtime restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wv-compliance-restart-'));
    const path = join(dir, 'compliance.db');

    try {
      // Runtime A: write each store.
      const rtA = weaveRuntime({ persistence: weaveSqlitePersistence({ path }) });
      const hA = createDurableLegalHoldManager({ runtime: rtA });
      const cA = createDurableConsentManager({ runtime: rtA });
      const dA = createDurableDeletionManager({ runtime: rtA });

      const hold = await hA.create({
        id: 'lh-1',
        name: 'Smith v Acme',
        description: 'Active litigation hold',
        subjectIds: ['user-42'],
        dataCategories: ['*'],
        issuedBy: 'legal@acme',
        expiresAt: null,
      });
      expect(hold.status).toBe('active');

      await cA.grant('user-42', 'analytics', 'web-form');
      const del = await dA.create('user-42', 'gdpr-officer', 'GDPR Article 17 request', ['profile']);
      expect(del.status).toBe('pending');

      // Drop runtime A. Runtime B comes up on the same SQLite path.
      const rtB = weaveRuntime({ persistence: weaveSqlitePersistence({ path }) });
      const hB = createDurableLegalHoldManager({ runtime: rtB });
      const cB = createDurableConsentManager({ runtime: rtB });
      const dB = createDurableDeletionManager({ runtime: rtB });

      const restoredHold = await hB.get('lh-1');
      expect(restoredHold?.name).toBe('Smith v Acme');
      expect(await hB.isHeld('user-42', 'profile')).toBe(true);

      expect(await cB.isGranted('user-42', 'analytics')).toBe(true);

      const allDel = await dB.list();
      expect(allDel.length).toBe(1);
      expect(allDel[0]?.subjectId).toBe('user-42');
      expect(allDel[0]?.status).toBe('pending');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
