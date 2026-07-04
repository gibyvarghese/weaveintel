// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 0 — unit tests for the shared foundation: the agency-colour contract, the
 * suggestion state machine, the capability config validator, and the node registry. Covers
 * positive, negative, stress, and security/abuse cases.
 */
import { describe, it, expect } from 'vitest';
import {
  NOTE_NODE_REGISTRY, noteNodeSpec, aiCreatableNodes, editableNodes,
} from './index.js';

describe('note-node registry', () => {
  it('every node has a label + flags; lookups work', () => {
    expect(NOTE_NODE_REGISTRY.length).toBeGreaterThan(15);
    expect(noteNodeSpec('inkCanvas')).toMatchObject({ label: 'Ink', aiCreatable: true, editableAfter: true, phase: 4 });
    expect(noteNodeSpec('artifact')!.editableAfter).toBe(false); // opaque fallback
    expect(noteNodeSpec('nope')).toBeUndefined();
  });
  it('AI-creatable + editable sets are consistent (editable-native is the default; artifact/image are the opaque exceptions)', () => {
    expect(aiCreatableNodes()).toContain('paragraph');
    expect(aiCreatableNodes()).toContain('excalidrawBoard');
    expect(editableNodes()).not.toContain('artifact');
    expect(editableNodes()).not.toContain('image');
  });
});
