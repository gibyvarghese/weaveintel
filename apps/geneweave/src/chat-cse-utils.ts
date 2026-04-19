import type { AgentResult } from '@weaveintel/core';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractWorkerToolTrace(value: string): unknown[] | null {
  const traceIdx = value.indexOf('[WorkerToolTrace]');
  if (traceIdx < 0) {
    return null;
  }

  const traceJson = value.slice(traceIdx + '[WorkerToolTrace]\n'.length).trim();
  const parsed = safeParseJson(traceJson);
  if (Array.isArray(parsed)) {
    return parsed;
  }

  const rec = asRecord(parsed);
  const executions = rec?.['executions'];
  return Array.isArray(executions) ? executions : null;
}

function isSuccessfulCseToolResult(value: unknown): boolean {
  const parsed = typeof value === 'string' ? safeParseJson(value) : value;
  const record = asRecord(parsed);
  return record?.['status'] === 'success';
}

function scanForSuccessfulCseExecution(value: unknown, seen: WeakSet<object>): boolean {
  if (value == null) return false;

  if (typeof value === 'string') {
    const workerTrace = extractWorkerToolTrace(value);
    if (workerTrace && scanForSuccessfulCseExecution(workerTrace, seen)) {
      return true;
    }
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => scanForSuccessfulCseExecution(entry, seen));
  }

  if (typeof value !== 'object') {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const toolCall = asRecord(record['toolCall']);
  if (toolCall && toolCall['name'] === 'cse_run_code' && isSuccessfulCseToolResult(toolCall['result'])) {
    return true;
  }

  if (record['name'] === 'cse_run_code' && isSuccessfulCseToolResult(record['result'])) {
    return true;
  }

  for (const nested of Object.values(record)) {
    if (scanForSuccessfulCseExecution(nested, seen)) {
      return true;
    }
  }

  return false;
}

export function hasSuccessfulCseExecution(result: AgentResult): boolean {
  return scanForSuccessfulCseExecution(result, new WeakSet<object>());
}

export function hasCodeExecutorDelegation(result: AgentResult): boolean {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;

    const delegationWorker = String(step.delegation?.worker ?? step.delegation?.workerName ?? '').trim().toLowerCase();
    if (delegationWorker === 'code_executor') return true;

    const toolName = String(step.toolCall?.name ?? '').trim();
    if (toolName !== 'delegate_to_worker') continue;

    const argsRec = asRecord(step.toolCall?.arguments);
    const argWorker = String(argsRec?.['worker'] ?? '').trim().toLowerCase();
    if (argWorker === 'code_executor') return true;
  }

  return false;
}

export function isSuccessfulToolResult(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (
      lower.includes('tool error')
      || lower.includes('"status":"error"')
      || lower.includes('"status": "error"')
    ) {
      return false;
    }
  }
  const parsed = typeof value === 'string' ? safeParseJson(value) : value;
  const record = asRecord(parsed);
  if (!record) return true;
  if (record['isError'] === true) return false;
  const status = record['status'];
  if (status === 'error' || status === 'failed') return false;
  if (record['error']) return false;
  return true;
}
