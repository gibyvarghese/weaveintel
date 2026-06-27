// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the SYSTEM TEMPLATES (weaveNotes Phase 6).
 *
 * A new note shouldn't start as a blank page. weaveNotes ships a set of ready-made starting points
 * matching the proven note-taking methods — Cornell, meeting minutes, a study/revision sheet, an
 * active-recall planner, an outline, a mind-map, a comparison sheet, a Zettelkasten "smart note",
 * a "start messy" action board, a daily planner, a project brief, and a blank page. This module is
 * the SINGLE SOURCE OF TRUTH for them, as plain data: each template is just a `doc_json`
 * (ProseMirror/Tiptap) document built from the SAME blocks the editor renders, so the app's seed
 * migration, the template gallery, and the AI's `new_from_template` tool all share one definition
 * and can never drift.
 *
 * --- For someone new to this ---
 * A "template" here is a pre-filled note: pick "Meeting minutes" and you get a page already laid
 * out with an objective, attendees, an agenda, and an action-items checklist — you just fill in
 * the blanks. The action items are a real to-do list, so they flow into your tasks automatically.
 *
 * Pure data + pure helpers (no DOM, no framework). Zero-dependency.
 */

/** A ProseMirror inline/block node (the shape stored in `doc_json`). */
export interface PMNode { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> }
export interface PMDoc { type: 'doc'; content: PMNode[] }

export type TemplateCategory = 'Blank' | 'Study' | 'Meetings' | 'Planning' | 'Thinking';

/** One system template: its stable key, label, icon, category, one-line description + the doc. */
export interface NoteTemplate {
  key: string;
  title: string;
  icon: string;
  category: TemplateCategory;
  description: string;
  doc: PMDoc;
}

// ─── tiny ProseMirror builders (keep the template docs readable) ────────────────────────────────
const t = (text: string, marks?: PMNode['marks']): PMNode => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const bold = (text: string): PMNode => t(text, [{ type: 'bold' }]);
const p = (...inline: Array<PMNode | string>): PMNode => ({ type: 'paragraph', content: inline.map((x) => (typeof x === 'string' ? t(x) : x)) });
const empty = (): PMNode => ({ type: 'paragraph' });
const h = (level: number, text: string): PMNode => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const bullets = (...items: string[]): PMNode => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [p(i)] })) });
const ordered = (...items: string[]): PMNode => ({ type: 'orderedList', content: items.map((i) => ({ type: 'listItem', content: [p(i)] })) });
const todos = (...items: string[]): PMNode => ({ type: 'taskList', content: items.map((i) => ({ type: 'taskItem', attrs: { checked: false }, content: [p(i)] })) });
const callout = (tone: string, ...inline: Array<PMNode | string>): PMNode => ({ type: 'callout', attrs: { tone }, content: [p(...inline)] });
const toggle = (summary: string, ...body: PMNode[]): PMNode => ({ type: 'toggle', attrs: { summary, open: true }, content: body.length ? body : [empty()] });
const quote = (text: string): PMNode => ({ type: 'blockquote', content: [p(text)] });
const code = (text: string): PMNode => ({ type: 'codeBlock', content: [t(text)] });
const hr = (): PMNode => ({ type: 'horizontalRule' });
const doc = (...content: PMNode[]): PMDoc => ({ type: 'doc', content });

// ─── The templates ──────────────────────────────────────────────────────────────────────────────
export const SYSTEM_TEMPLATES: readonly NoteTemplate[] = [
  {
    key: 'blank', title: 'Blank note', icon: '📄', category: 'Blank',
    description: 'A clean page — start however you like.',
    doc: doc(h(1, 'Untitled'), empty()),
  },
  {
    key: 'cornell', title: 'Cornell notes', icon: '📓', category: 'Study',
    description: 'The classic cue / notes / summary layout for lectures + study.',
    doc: doc(
      h(1, 'Cornell notes'),
      p(bold('Topic: '), '…', t('   ·   '), bold('Date: '), '…'),
      callout('tip', 'Take notes on the right while you read or listen. Afterwards, write CUE questions on the left, and a short SUMMARY at the bottom — then quiz yourself with the cues covered.'),
      h(2, 'Cues / questions'),
      bullets('What is …?', 'Why does … matter?', 'How does … work?'),
      h(2, 'Notes'),
      bullets('Key point …', 'Detail …', 'Example …'),
      h(2, 'Summary'),
      callout('note', 'In one or two sentences, what is the main idea?'),
    ),
  },
  {
    key: 'meeting-minutes', title: 'Meeting minutes', icon: '🗒️', category: 'Meetings',
    description: 'Objective, attendees, agenda, discussion + an action-items checklist that feeds your tasks.',
    doc: doc(
      h(1, 'Meeting minutes'),
      p(bold('Objective: '), '…'),
      p(bold('Date / time: '), '…', t('   ·   '), bold('Location: '), '…'),
      h(2, 'Attendees'),
      bullets('You', 'Name — role', 'Name — role'),
      h(2, 'Agenda'),
      ordered('Item one', 'Item two', 'Item three'),
      h(2, 'Discussion'),
      bullets('Point discussed …', 'Decision made …'),
      h(2, 'Action items'),
      callout('tip', 'Tick these off as to-dos — they become tasks you can track.'),
      todos('Owner — do … by <date>', 'Owner — do … by <date>'),
      h(2, 'Parking lot'),
      bullets('Idea to revisit later …'),
      h(2, 'Next meeting'),
      p(bold('When: '), '…', t('   ·   '), bold('Agenda: '), '…'),
    ),
  },
  {
    key: 'study-sheet', title: 'Study / revision sheet', icon: '📚', category: 'Study',
    description: 'Definitions, key concepts, important questions + formulas — built for revision.',
    doc: doc(
      h(1, 'Study sheet — <topic>'),
      callout('note', 'Definition: …'),
      h(2, 'Key concepts'),
      ordered('Concept one — …', 'Concept two — …', 'Concept three — …'),
      h(2, 'Important questions'),
      bullets('Q: … ?', 'Q: … ?'),
      h(2, 'Formulas / facts'),
      code('formula = …'),
      callout('tip', 'When this is ready, open Study (flashcards) to quiz yourself with spaced repetition.'),
    ),
  },
  {
    key: 'active-recall', title: 'Active-recall planner', icon: '🧠', category: 'Study',
    description: 'A spaced-repetition schedule + recall checklist that turns into flashcards.',
    doc: doc(
      h(1, 'Active-recall planner — <topic>'),
      h(2, 'Spaced-repetition schedule'),
      callout('tip', 'Review on a widening schedule so it sticks with the least effort.'),
      todos('Day 1 — first review', 'Day 3 — second review', 'Day 7 — third review', 'Day 14 — fourth review'),
      h(2, 'Recall checklist'),
      todos('Can I explain … from memory?', 'Can I give an example of …?', 'Can I answer the tricky question about …?'),
      callout('note', 'Use Study → Make flashcards to generate a deck from your notes and review it here.'),
    ),
  },
  {
    key: 'outline', title: 'Outline', icon: '🪜', category: 'Thinking',
    description: 'A clean hierarchical outline for structured writing or lectures.',
    doc: doc(
      h(1, 'Outline'),
      { type: 'bulletList', content: [
        { type: 'listItem', content: [p('Main point I'), { type: 'bulletList', content: [
          { type: 'listItem', content: [p('Supporting detail')] },
          { type: 'listItem', content: [p('Example')] },
        ] }] },
        { type: 'listItem', content: [p('Main point II'), { type: 'bulletList', content: [
          { type: 'listItem', content: [p('Supporting detail')] },
        ] }] },
        { type: 'listItem', content: [p('Main point III')] },
      ] },
    ),
  },
  {
    key: 'mind-map', title: 'Mind-map', icon: '🕸️', category: 'Thinking',
    description: 'A central idea with branches — and a tip to turn it into a real diagram.',
    doc: doc(
      h(1, '<central idea>'),
      callout('tip', 'Select this and use ✦ Visualize → diagram (mind-map) to draw it as a real, colour-coded map.'),
      h(2, 'Branch 1'),
      bullets('sub-idea', 'sub-idea'),
      h(2, 'Branch 2'),
      bullets('sub-idea', 'sub-idea'),
      h(2, 'Branch 3'),
      bullets('sub-idea'),
    ),
  },
  {
    key: 'comparison', title: 'Comparison / charting', icon: '📊', category: 'Thinking',
    description: 'Compare options side by side — or spin up a real table with Databases.',
    doc: doc(
      h(1, 'Comparison — A vs B'),
      callout('tip', 'For a sortable table with typed columns, use 🗃 Databases. This page is the quick version.'),
      h(2, 'Option A'),
      bullets('Pro: …', 'Pro: …', 'Con: …'),
      h(2, 'Option B'),
      bullets('Pro: …', 'Con: …', 'Con: …'),
      h(2, 'Verdict'),
      callout('success', 'Recommendation: …'),
    ),
  },
  {
    key: 'zettelkasten', title: 'Zettelkasten / smart note', icon: '🗃️', category: 'Thinking',
    description: 'A single linked idea — fleeting/permanent/literature/project — with retrieval cues.',
    doc: doc(
      h(1, '<one idea, in your own words>'),
      callout('note', 'Note type: fleeting · permanent · literature · project   (delete the rest)'),
      h(2, 'The idea'),
      p('State ONE idea clearly and atomically — small enough to link, big enough to matter.'),
      h(2, 'Links'),
      bullets('Builds on [[another note]]', 'Contrasts with [[another note]]', 'Leads to [[a new question]]'),
      h(2, 'Source'),
      p(bold('Reference: '), '…'),
      h(2, 'Retrieval cues'),
      bullets('Keyword …', 'When would I reach for this? …'),
    ),
  },
  {
    key: 'action-board', title: 'Action board (start messy)', icon: '🚀', category: 'Planning',
    description: 'Pick one idea → smallest version → ship → adjust → repeat. Beat the blank page.',
    doc: doc(
      h(1, 'Action board'),
      callout('tip', 'Momentum beats perfection. Pick ONE idea, ship the smallest version, then adjust.'),
      toggle('1 · Pick one idea', bullets('Idea …', 'Idea …'), p('→ The one I’ll do now: …')),
      toggle('2 · Smallest version', todos('The tiniest shippable step', 'And the next tiny step')),
      toggle('3 · Ship', p('What “done for now” looks like: …')),
      toggle('4 · Adjust', p('What I learned · what changes next round: …')),
      hr(),
      quote('Repeat. Done is better than perfect.'),
    ),
  },
  {
    key: 'daily-planner', title: 'Daily planner', icon: '📅', category: 'Planning',
    description: 'Top priorities, schedule, and notes for the day.',
    doc: doc(
      h(1, 'Daily plan — <date>'),
      h(2, 'Top 3 priorities'),
      todos('Most important thing', 'Second', 'Third'),
      h(2, 'Schedule'),
      bullets('09:00 — …', '11:00 — …', '14:00 — …'),
      h(2, 'To-dos'),
      todos('…', '…'),
      h(2, 'Notes'),
      empty(),
    ),
  },
  {
    key: 'project-brief', title: 'Project brief', icon: '📋', category: 'Planning',
    description: 'Objective, scope, milestones, risks + stakeholders for a new project.',
    doc: doc(
      h(1, 'Project brief — <name>'),
      callout('note', 'One-line summary: …'),
      h(2, 'Objective'),
      p('What success looks like: …'),
      h(2, 'Scope'),
      bullets('In scope: …', 'Out of scope: …'),
      h(2, 'Milestones'),
      todos('Milestone 1 — <date>', 'Milestone 2 — <date>'),
      h(2, 'Risks'),
      bullets('Risk … → mitigation …'),
      h(2, 'Stakeholders'),
      bullets('Owner — …', 'Reviewer — …'),
    ),
  },
] as const;

const BY_KEY = new Map(SYSTEM_TEMPLATES.map((tpl) => [tpl.key, tpl]));

/** Look up a system template by its stable key. */
export function templateByKey(key: string): NoteTemplate | undefined { return BY_KEY.get(key); }

/** All template categories, in display order, each non-empty. */
export function templateCategories(): TemplateCategory[] {
  const order: TemplateCategory[] = ['Blank', 'Study', 'Meetings', 'Planning', 'Thinking'];
  return order.filter((c) => SYSTEM_TEMPLATES.some((t2) => t2.category === c));
}

/** The full template list (optionally filtered to a category). */
export function listSystemTemplates(category?: TemplateCategory): NoteTemplate[] {
  return SYSTEM_TEMPLATES.filter((tpl) => !category || tpl.category === category);
}

/** The set of ProseMirror node types a template doc may use (must all be editor-renderable). */
export const TEMPLATE_NODE_TYPES = new Set([
  'doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem',
  'taskList', 'taskItem', 'blockquote', 'codeBlock', 'horizontalRule', 'callout', 'toggle',
]);
