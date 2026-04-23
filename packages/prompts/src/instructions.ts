/**
 * @weaveintel/prompts — Instruction bundle builder
 *
 * Compose system, task, formatting, guardrail, and example instructions
 * into a single system prompt string. Enables layered prompt construction.
 */

import type { InstructionBundle } from '@weaveintel/core';

export const STANDARD_V1_ATTENTION_POLICY_REF = 'standard-v1';

// ─── Builder ─────────────────────────────────────────────────

export class InstructionBundleBuilder {
  private bundle: InstructionBundle;

  constructor(id: string, name: string) {
    this.bundle = { id, name, system: '' };
  }

  system(text: string): this {
    this.bundle.system = text;
    return this;
  }

  task(text: string): this {
    this.bundle.task = text;
    return this;
  }

  formatting(text: string): this {
    this.bundle.formatting = text;
    return this;
  }

  guardrails(text: string): this {
    this.bundle.guardrails = text;
    return this;
  }

  examples(...examples: string[]): this {
    this.bundle.examples = [...(this.bundle.examples ?? []), ...examples];
    return this;
  }

  build(): InstructionBundle {
    return { ...this.bundle };
  }
}

// ─── Compose ─────────────────────────────────────────────────

/**
 * Compose an InstructionBundle into a single system prompt string.
 * Sections are separated by blank lines.
 */
export function composeInstructions(bundle: InstructionBundle): string {
  const parts: string[] = [bundle.system];
  if (bundle.task) parts.push(`## Task\n${bundle.task}`);
  if (bundle.formatting) parts.push(`## Formatting\n${bundle.formatting}`);
  if (bundle.guardrails) parts.push(`## Guardrails\n${bundle.guardrails}`);
  if (bundle.examples && bundle.examples.length > 0) {
    parts.push(`## Examples\n${bundle.examples.map((e, i) => `${i + 1}. ${e}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

// ─── Factory ─────────────────────────────────────────────────

export function createInstructionBundle(id: string, name: string): InstructionBundleBuilder {
  return new InstructionBundleBuilder(id, name);
}
