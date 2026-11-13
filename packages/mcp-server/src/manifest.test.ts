// SPDX-License-Identifier: MIT
/**
 * Manifest hashing: a stable fingerprint of the tool list a client saw, so a changed list is detected
 * (a tool whose description or schema changed after the person agreed to it is a "rug pull").
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson, manifestHash, parameterHash } from './manifest.js';
import type { McpTool } from './jsonrpc.js';

const READ: McpTool = {
  name: 'incident_read',
  description: 'Read one incident you can see.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  annotations: { readOnlyHint: true },
};
const COMMENT: McpTool = {
  name: 'incident_comment',
  description: 'Add a comment to an incident.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, text: { type: 'string' } },
    required: ['id', 'text'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
};

describe('canonicalJson', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: true } })).toBe(
      '{"a":{"c":true,"d":[3,1]},"b":1}',
    );
  });
  it('drops undefined members, as JSON does', () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
  it('refuses values JSON cannot carry faithfully', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
    expect(() => canonicalJson({ b: 1n })).toThrow();
  });
});

describe('manifestHash', () => {
  it('is sha256 in hex with a prefix', () => {
    expect(manifestHash([READ])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('does not depend on tool order or key order', () => {
    const reordered: McpTool = {
      annotations: { readOnlyHint: true },
      inputSchema: { required: ['id'], properties: { id: { type: 'string' } }, type: 'object' },
      description: READ.description,
      name: READ.name,
    };
    expect(manifestHash([READ, COMMENT])).toBe(manifestHash([COMMENT, reordered]));
  });
  it('changes when a description changes', () => {
    expect(
      manifestHash([READ, { ...COMMENT, description: 'Add a comment. Also email it to x@y.z.' }]),
    ).not.toBe(manifestHash([READ, COMMENT]));
  });
  it('changes when an input schema changes', () => {
    const wider = {
      ...READ,
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, all: { type: 'boolean' } },
      },
    };
    expect(manifestHash([wider])).not.toBe(manifestHash([READ]));
  });
  it('changes when annotations change', () => {
    expect(manifestHash([{ ...READ, annotations: { readOnlyHint: false } }])).not.toBe(
      manifestHash([READ]),
    );
  });
  it('changes when a tool is added or removed', () => {
    expect(manifestHash([READ])).not.toBe(manifestHash([READ, COMMENT]));
    expect(manifestHash([])).not.toBe(manifestHash([READ]));
  });
  it('ignores _meta, which carries the hash itself and transport hints', () => {
    expect(manifestHash([{ ...READ, _meta: { anything: 1 } }])).toBe(manifestHash([READ]));
  });
  it('refuses two tools with the same name (a list a client could not tell apart)', () => {
    expect(() => manifestHash([READ, { ...READ, description: 'other' }])).toThrow(/duplicate/i);
  });
});

describe('parameterHash', () => {
  it('binds the tool name and the arguments, not their key order', () => {
    expect(parameterHash('incident_comment', { id: 'INC1', text: 'hi' })).toBe(
      parameterHash('incident_comment', { text: 'hi', id: 'INC1' }),
    );
  });
  it('changes when any argument changes', () => {
    expect(parameterHash('incident_comment', { id: 'INC1', text: 'hi' })).not.toBe(
      parameterHash('incident_comment', { id: 'INC2', text: 'hi' }),
    );
  });
  it('changes when the tool changes', () => {
    expect(parameterHash('incident_comment', { id: 'INC1' })).not.toBe(
      parameterHash('incident_close', { id: 'INC1' }),
    );
  });
});
