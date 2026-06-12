import { describe, it, expect } from 'vitest';
import { TOKENS_SCHEMA_VERSION, SPACING_BASE_UNIT } from './index.js';

describe('@geneweave/tokens scaffold (M0)', () => {
  it('exports a stable schema version', () => {
    expect(TOKENS_SCHEMA_VERSION).toBe(1);
  });

  it('exports the 4-pt spacing base unit', () => {
    expect(SPACING_BASE_UNIT).toBe(4);
  });
});
