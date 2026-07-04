// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the note content-node registry.
 *
 * A note is a structured document made of BLOCKS (paragraphs, headings, lists…) and richer
 * blocks the later phases add (ink, diagrams, callouts, math…). This registry is the shared,
 * framework-free catalogue of those block + mark types and what each one means — most
 * importantly, whether the AI may CREATE it and whether the result stays EDITABLE afterward
 * (spec §4.4 "editable-native is the default; opaque artifacts are the fallback"). The web,
 * desktop, and mobile editors all build their schema from this one list, so a note inked on
 * an iPad and a note edited on the web understand the exact same node types.
 *
 * --- For someone new to this ---
 * This is just a labelled list of the kinds of things that can live on a page — a paragraph, a
 * to-do, a drawing, a diagram, a sticker — and two yes/no facts about each: "can the assistant
 * make this for me?" and "after it does, can I still grab it and change it?".
 */

export type NoteNodeType =
  // text + structure (Phase 1)
  | 'paragraph' | 'heading' | 'bulletList' | 'orderedList' | 'taskList' | 'toggle'
  | 'blockquote' | 'callout' | 'codeBlock' | 'horizontalRule' | 'table' | 'columnLayout'
  // media + creative (Phase 4–6)
  | 'image' | 'sticker' | 'washiDivider' | 'audioBlock'
  // formal/visual (Phase 1/4)
  | 'mathBlock' | 'mermaidBlock' | 'excalidrawBoard' | 'inkCanvas'
  // opaque AI fallback
  | 'artifact';

export type NoteMarkType = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link' | 'textColor' | 'highlight' | 'aiSuggestion';

export interface NoteNodeSpec {
  type: NoteNodeType;
  /** Plain, user-facing label (sentence case). */
  label: string;
  /** Can the AI create this node on the user's behalf (via the note-edit toolset)? */
  aiCreatable: boolean;
  /** After the AI (or a person) makes it, is it still natively editable — or opaque (replace-only)? */
  editableAfter: boolean;
  /** The build phase that introduces it (for the roadmap). */
  phase: number;
}

/** The full node catalogue. Ordering is roughly the order a person meets them. */
export const NOTE_NODE_REGISTRY: readonly NoteNodeSpec[] = [
  { type: 'paragraph', label: 'Paragraph', aiCreatable: true, editableAfter: true, phase: 1 },
  { type: 'heading', label: 'Heading', aiCreatable: true, editableAfter: true, phase: 1 },
  { type: 'bulletList', label: 'Bullet list', aiCreatable: true, editableAfter: true, phase: 1 },
  { type: 'orderedList', label: 'Numbered list', aiCreatable: true, editableAfter: true, phase: 1 },
  { type: 'taskList', label: 'To-do list', aiCreatable: true, editableAfter: true, phase: 1 },
  { type: 'toggle', label: 'Toggle list', aiCreatable: true, editableAfter: true, phase: 1 },
  { type: 'blockquote', label: 'Quote', aiCreatable: true, editableAfter: true, phase: 1 },
  { type: 'callout', label: 'Callout', aiCreatable: true, editableAfter: true, phase: 1 },
  { type: 'codeBlock', label: 'Code block', aiCreatable: true, editableAfter: true, phase: 1 },
  { type: 'horizontalRule', label: 'Divider', aiCreatable: true, editableAfter: true, phase: 1 },
  { type: 'table', label: 'Table', aiCreatable: true, editableAfter: true, phase: 1 },
  { type: 'columnLayout', label: 'Columns', aiCreatable: true, editableAfter: true, phase: 1 },
  { type: 'mathBlock', label: 'Math', aiCreatable: true, editableAfter: true, phase: 1 },
  { type: 'mermaidBlock', label: 'Mermaid diagram', aiCreatable: true, editableAfter: true, phase: 1 },
  { type: 'image', label: 'Image', aiCreatable: true, editableAfter: false, phase: 1 },
  { type: 'sticker', label: 'Sticker', aiCreatable: false, editableAfter: true, phase: 1 },
  { type: 'washiDivider', label: 'Washi divider', aiCreatable: false, editableAfter: true, phase: 1 },
  { type: 'inkCanvas', label: 'Ink', aiCreatable: true, editableAfter: true, phase: 4 },
  { type: 'excalidrawBoard', label: 'Drawing', aiCreatable: true, editableAfter: true, phase: 4 },
  { type: 'audioBlock', label: 'Audio note', aiCreatable: false, editableAfter: true, phase: 5 },
  { type: 'artifact', label: 'Generated artifact', aiCreatable: true, editableAfter: false, phase: 4 },
] as const;

const BY_TYPE = new Map(NOTE_NODE_REGISTRY.map((n) => [n.type, n]));

/** Look up a node spec by type. */
export function noteNodeSpec(type: string): NoteNodeSpec | undefined { return BY_TYPE.get(type as NoteNodeType); }
/** The node types the AI is allowed to create. */
export function aiCreatableNodes(): NoteNodeType[] { return NOTE_NODE_REGISTRY.filter((n) => n.aiCreatable).map((n) => n.type); }
/** The node types that remain natively editable after creation (vs opaque). */
export function editableNodes(): NoteNodeType[] { return NOTE_NODE_REGISTRY.filter((n) => n.editableAfter).map((n) => n.type); }
