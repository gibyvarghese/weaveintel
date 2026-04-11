/**
 * @weaveintel/guardrails — confidence-gate.ts
 * Confidence-based action gating
 */
import type { GuardrailDecision, ConfidenceGate as IConfidenceGate, ActionGate as IActionGate } from '@weaveintel/core';

export class DefaultConfidenceGate implements IConfidenceGate {
  threshold: number;
  action: 'block' | 'escalate' | 'warn' | 'log';

  constructor(threshold: number, action: 'block' | 'escalate' | 'warn' | 'log' = 'warn') {
    this.threshold = threshold;
    this.action = action;
  }

  evaluate(confidence: number): GuardrailDecision {
    if (confidence >= this.threshold) return 'allow';
    switch (this.action) {
      case 'block': return 'deny';
      case 'escalate': return 'deny';
      case 'warn': return 'warn';
      case 'log': return 'allow';
    }
  }
}

export class DefaultActionGate implements IActionGate {
  allowedActions: string[];
  deniedActions: string[];

  constructor(allowed: string[] = [], denied: string[] = []) {
    this.allowedActions = allowed;
    this.deniedActions = denied;
  }

  evaluate(action: string): GuardrailDecision {
    const lower = action.toLowerCase();

    if (this.deniedActions.some(d => lower.includes(d.toLowerCase()))) {
      return 'deny';
    }

    if (this.allowedActions.length > 0) {
      if (this.allowedActions.some(a => lower.includes(a.toLowerCase()))) {
        return 'allow';
      }
      return 'deny'; // Not in allowlist
    }

    return 'allow';
  }
}

export function createConfidenceGate(threshold: number, action?: 'block' | 'escalate' | 'warn' | 'log'): DefaultConfidenceGate {
  return new DefaultConfidenceGate(threshold, action);
}

export function createActionGate(allowed?: string[], denied?: string[]): DefaultActionGate {
  return new DefaultActionGate(allowed, denied);
}
