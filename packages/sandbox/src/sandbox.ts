/**
 * @weaveintel/sandbox — Main sandbox execution environment
 */

import type { Sandbox, SandboxPolicy, SandboxResult } from '@weaveintel/core';
import { randomUUID } from 'node:crypto';
import { validatePolicy } from './policy.js';
import { enforceLimits } from './limits.js';
import { createSuccessResult, createErrorResult } from './result.js';

interface ExecutionEntry {
  id: string;
  code: string;
  policy: SandboxPolicy;
  startedAt: number;
  abortController: AbortController;
}

export function createSandbox(): Sandbox {
  const executions = new Map<string, ExecutionEntry>();

  async function execute(code: string, policy: SandboxPolicy): Promise<SandboxResult> {
    const executionId = randomUUID();
    const startedAt = Date.now();

    if (!policy.enabled) {
      return createErrorResult(executionId, 'Policy is disabled', { cpuMs: 0, memoryMb: 0, durationMs: 0 });
    }

    const validation = validatePolicy(policy);
    if (!validation.valid) {
      return createErrorResult(executionId, `Invalid policy: ${validation.errors.join('; ')}`, {
        cpuMs: 0,
        memoryMb: 0,
        durationMs: 0,
      });
    }

    // Check denied modules
    if (policy.deniedModules && policy.deniedModules.length > 0) {
      for (const mod of policy.deniedModules) {
        const importPattern = new RegExp(`(?:import|require)\\s*\\(?\\s*['"\`]${escapeRegex(mod)}['"\`]`);
        if (importPattern.test(code)) {
          return createErrorResult(executionId, `Denied module referenced: ${mod}`, {
            cpuMs: 0,
            memoryMb: 0,
            durationMs: Date.now() - startedAt,
          });
        }
      }
    }

    // Check allowed modules — if specified, only those modules are permitted
    if (policy.allowedModules && policy.allowedModules.length > 0) {
      const modulePattern = /(?:import|require)\s*\(?\s*['"`]([^'"`]+)['"`]/g;
      let match: RegExpExecArray | null;
      while ((match = modulePattern.exec(code)) !== null) {
        const mod = match[1]!;
        // Skip relative imports
        if (mod.startsWith('.') || mod.startsWith('/')) continue;
        const pkgName = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0]!;
        if (!policy.allowedModules.includes(pkgName)) {
          return createErrorResult(executionId, `Module not allowed: ${pkgName}`, {
            cpuMs: 0,
            memoryMb: 0,
            durationMs: Date.now() - startedAt,
          });
        }
      }
    }

    const abortController = new AbortController();
    const entry: ExecutionEntry = { id: executionId, code, policy, startedAt, abortController };
    executions.set(executionId, entry);

    try {
      const result = await runWithTimeout(executionId, code, policy, abortController.signal, startedAt);
      return result;
    } finally {
      executions.delete(executionId);
    }
  }

  async function terminate(executionId: string): Promise<void> {
    const entry = executions.get(executionId);
    if (entry) {
      entry.abortController.abort();
      executions.delete(executionId);
    }
  }

  return { execute, terminate };
}

async function runWithTimeout(
  executionId: string,
  code: string,
  policy: SandboxPolicy,
  signal: AbortSignal,
  startedAt: number,
): Promise<SandboxResult> {
  return new Promise<SandboxResult>((resolve) => {
    const timer = setTimeout(() => {
      const durationMs = Date.now() - startedAt;
      resolve({
        executionId,
        status: 'timeout',
        error: `Execution timed out after ${policy.limits.maxDurationMs}ms`,
        artifacts: [],
        resourceUsage: { cpuMs: durationMs, memoryMb: 0, durationMs },
      });
    }, policy.limits.maxDurationMs);

    const onAbort = () => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      resolve({
        executionId,
        status: 'killed',
        error: 'Execution was terminated',
        artifacts: [],
        resourceUsage: { cpuMs: durationMs, memoryMb: 0, durationMs },
      });
    };

    if (signal.aborted) {
      clearTimeout(timer);
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    // Simulate execution with resource tracking
    simulateExecution(code)
      .then((simResult) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        const durationMs = Date.now() - startedAt;
        const usage = { cpuMs: simResult.cpuMs, memoryMb: simResult.memoryMb, durationMs };

        const enforcement = enforceLimits(policy.limits, usage);
        if (enforcement.exceeded) {
          resolve(createErrorResult(executionId, `Limits exceeded: ${enforcement.violations.join('; ')}`, usage));
        } else {
          resolve(createSuccessResult(executionId, simResult.output, usage));
        }
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        const durationMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        resolve(createErrorResult(executionId, message, { cpuMs: durationMs, memoryMb: 0, durationMs }));
      });
  });
}

async function simulateExecution(code: string): Promise<{ output: unknown; cpuMs: number; memoryMb: number }> {
  // Simulate a lightweight execution: estimate resource usage from code size
  const codeLen = code.length;
  const cpuMs = Math.max(1, Math.round(codeLen * 0.01));
  const memoryMb = Math.max(1, Math.round(codeLen * 0.001));

  // Simulate async work
  await new Promise((r) => setTimeout(r, Math.min(cpuMs, 50)));

  return {
    output: { evaluated: true, codeLength: codeLen },
    cpuMs,
    memoryMb,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
