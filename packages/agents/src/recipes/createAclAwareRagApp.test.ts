/**
 * createAclAwareRagApp is deprecated as unsafe (platform-architecture §7.4 item 5; GAPS G-WI-12):
 * its access list lives only in prompt text.
 */
import { describe, expect, it } from 'vitest';
import { stubTextModel } from '../test-helpers.js';
import { createAclAwareRagApp } from './createAclAwareRagApp.js';

describe('createAclAwareRagApp deprecation', () => {
  it('emits a one-time DeprecationWarning naming the prompt-only ACL', async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on('warning', onWarning);
    try {
      createAclAwareRagApp({ model: stubTextModel('x') });
      createAclAwareRagApp({ model: stubTextModel('x') });
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off('warning', onWarning);
    }
    const ours = warnings.filter((w) => (w as Error & { code?: string }).code === 'WEAVEINTEL_ACL_RAG_PROMPT_ONLY');
    expect(ours).toHaveLength(1);
    expect(ours[0]?.name).toBe('DeprecationWarning');
  });
});
