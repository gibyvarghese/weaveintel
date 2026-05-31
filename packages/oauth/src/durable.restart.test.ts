/**
 * Phase 4 — OAuth flow state must survive a process restart so a callback
 * arriving after a deploy can still verify its `state` + `code_verifier`.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { weaveRuntime } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { createDurableOAuthStateStore } from './durable.js';

describe('oauth — durable flow state survives restart', () => {
  it('state stored on runtime A is readable on runtime B', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wv-oauth-restart-'));
    const path = join(dir, 'oauth.db');

    try {
      const rtA = weaveRuntime({ persistence: weaveSqlitePersistence({ path }) });
      const storeA = createDurableOAuthStateStore({ runtime: rtA });

      await storeA.set('state-abc', {
        codeVerifier: 'verifier-xyz',
        expiresAt: Date.now() + 5 * 60_000,
        provider: 'github',
        redirectUri: 'https://app.example/callback',
      });

      // Process restart simulation
      const rtB = weaveRuntime({ persistence: weaveSqlitePersistence({ path }) });
      const storeB = createDurableOAuthStateStore({ runtime: rtB });

      const restored = await storeB.get('state-abc');
      expect(restored).not.toBeNull();
      expect(restored?.codeVerifier).toBe('verifier-xyz');
      expect(restored?.provider).toBe('github');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expired state is dropped on read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wv-oauth-expired-'));
    const path = join(dir, 'oauth.db');
    try {
      const rt = weaveRuntime({ persistence: weaveSqlitePersistence({ path }) });
      const store = createDurableOAuthStateStore({ runtime: rt });

      await store.set('expired-state', {
        codeVerifier: 'v',
        expiresAt: Date.now() - 1_000,
        provider: 'google',
        redirectUri: 'https://app/cb',
      });
      expect(await store.get('expired-state')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
