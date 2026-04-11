/**
 * @weaveintel/contracts — Contract definitions
 *
 * Builder-pattern API for creating task contracts with acceptance criteria.
 */

import type { TaskContract, AcceptanceCriteria } from '@weaveintel/core';
import { randomUUID } from 'node:crypto';

export interface CreateContractInput {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  acceptanceCriteria?: AcceptanceCriteria[];
  maxAttempts?: number;
  timeoutMs?: number;
}

export function createContract(input: CreateContractInput): TaskContract {
  return {
    id: randomUUID(),
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema ?? {},
    outputSchema: input.outputSchema ?? {},
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    maxAttempts: input.maxAttempts,
    timeoutMs: input.timeoutMs,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Fluent builder for TaskContract.
 */
export class ContractBuilder {
  private name = '';
  private description?: string;
  private inputSchema: Record<string, unknown> = {};
  private outputSchema: Record<string, unknown> = {};
  private criteria: AcceptanceCriteria[] = [];
  private maxAttempts?: number;
  private timeoutMs?: number;

  setName(name: string): this { this.name = name; return this; }
  setDescription(desc: string): this { this.description = desc; return this; }
  setInputSchema(schema: Record<string, unknown>): this { this.inputSchema = schema; return this; }
  setOutputSchema(schema: Record<string, unknown>): this { this.outputSchema = schema; return this; }
  setMaxAttempts(n: number): this { this.maxAttempts = n; return this; }
  setTimeout(ms: number): this { this.timeoutMs = ms; return this; }

  addCriteria(criteria: Omit<AcceptanceCriteria, 'id'>): this {
    this.criteria.push({ ...criteria, id: randomUUID() });
    return this;
  }

  addRequiredCriteria(description: string, type: AcceptanceCriteria['type'], config?: Record<string, unknown>): this {
    return this.addCriteria({ description, type, required: true, config });
  }

  addOptionalCriteria(description: string, type: AcceptanceCriteria['type'], weight?: number): this {
    return this.addCriteria({ description, type, required: false, weight });
  }

  build(): TaskContract {
    if (!this.name) throw new Error('Contract name is required');
    return createContract({
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      acceptanceCriteria: this.criteria,
      maxAttempts: this.maxAttempts,
      timeoutMs: this.timeoutMs,
    });
  }
}

export function defineContract(name?: string): ContractBuilder {
  const b = new ContractBuilder();
  if (name) b.setName(name);
  return b;
}
