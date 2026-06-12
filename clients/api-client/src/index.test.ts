import { describe, it, expect } from 'vitest';
import {
  API_CLIENT_SCHEMA_VERSION,
  HostConfigSchema,
} from './index.js';

describe('@geneweave/api-client barrel', () => {
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
});
