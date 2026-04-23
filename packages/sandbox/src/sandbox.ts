/**
 * @weaveintel/sandbox — Main sandbox execution environment
 *
 * createSandbox() produces a not-available sandbox by default because the
 * in-process simulator does not provide real isolation. Callers that need
 * a development/test environment should use createSimulatedSandbox() and
 * make that choice explicit in their configuration.
 *
 * For production isolated execution, wire in ContainerExecutor from the
 * container executor package and pass it via SandboxExecutorOptions.
 */

import type { Sandbox, SandboxPolicy, SandboxResult } from '@weaveintel/core';
import { randomUUID } from 'node:crypto';
import { validatePolicy } from './policy.js';
import { enforceLimits } from './limits.js';
import { createSuccessResult, createErrorResult } from './result.js';

// ─── Not-available sandbox ────────────────────────────────────────────────────

/**
 * createSandbox() returns a sandbox that declines all execution requests.
 *
 * Rationale: the former default was an in-process simulator that returned
 * `status: 'success'` without running real code, module deny lists were
 * bypassed by anything not matching a narrow regex, and callers had no way
 * to know execution did not actually occur.
 *
 * To get simulation behavior (dev/test only), call createSimulatedSandbox().
 */
export function createSandbox(): Sandbox {
  return {
    async execute(code: string, policy: SandboxPolicy): Promise<SandboxResult> {
      const executionId = randomUUID();
      void code;
      void policy;
      return {
        executionId,
        status: 'error',
        error:
          'No sandbox executor is configured. ' +
          'For isolated production execution, wire in ContainerExecutor. ' +
          'For development/test simulation, use createSimulatedSandbox() instead.',
        artifacts: [],
        resourceUsage: { cpuMs: 0, memoryMb: 0, durationMs: 0 },
      };
    },
    async terminate(_executionId: string): Promise<void> {
      // No-op — no active executions
    },
  };
}

interface ExecutionEntry {
  id: string;
  code: string;
  policy: SandboxPolicy;
  startedAt: number;
  abortController: AbortController;
}

/**
 * createSimulatedSandbox() provides an in-process simulator for development
 * and testing only. It does NOT provide real isolation — the code is not
 * executed at all; resource usage is estimated from code length. Module
 * deny/allow lists are enforced via static analysis (regex), which can be
 * bypassed by dynamic require patterns.
 *
 * Never use this in production for untrusted code.
 */
export function createSimulatedSandbox(): Sandbox {
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
