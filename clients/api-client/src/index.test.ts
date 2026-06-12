import { describe, it, expect } from 'vitest';
import {
  API_CLIENT_SCHEMA_VERSION,
  HostConfigSchema,
  __sseTransportRef,
} from './index.js';

describe('@geneweave/api-client scaffold (M0)', () => {
  it('exports a stable schema version', () => {
    expect(API_CLIENT_SCHEMA_VERSION).toBe(1);
  });

  it('validates a well-formed host config via zod', () => {
    const parsed = HostConfigSchema.parse({ host: 'https://api.example.com' });
    expect(parsed.host).toBe('https://api.example.com');
  });

  it('rejects a malformed host (proves zod dependency is wired)', () => {
    expect(() => HostConfigSchema.parse({ host: 'not-a-url' })).toThrow();
  });

  it('resolves the @weaveintel/client transport dependency', () => {
    expect(typeof __sseTransportRef).toBe('function');
  });
});
