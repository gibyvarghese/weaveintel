/**
 * @weaveintel/contracts — Unit tests
 */
import { describe, it, expect } from 'vitest';
import {
  createContract,
  ContractBuilder,
  defineContract,
  DefaultCompletionValidator,
  createEvidence,
  createCompletionReport,
  createEvidenceBundle,
  evidence,
  createTaskOutcome,
  createFailureReason,
  failures,
} from '../index.js';

// ─── createContract ──────────────────────────────────────────

describe('createContract', () => {
  it('creates a contract with defaults', () => {
    const c = createContract({ name: 'Test' });
    expect(c.id).toBeDefined();
    expect(c.name).toBe('Test');
    expect(c.inputSchema).toEqual({});
    expect(c.outputSchema).toEqual({});
    expect(c.acceptanceCriteria).toEqual([]);
    expect(c.createdAt).toBeDefined();
  });

  it('sets all fields', () => {
    const c = createContract({
      name: 'Full',
      description: 'desc',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      acceptanceCriteria: [{ id: 'c1', description: 'check', type: 'schema', required: true }],
      maxAttempts: 3,
      timeoutMs: 5000,
    });
    expect(c.description).toBe('desc');
    expect(c.maxAttempts).toBe(3);
    expect(c.timeoutMs).toBe(5000);
    expect(c.acceptanceCriteria).toHaveLength(1);
  });
});

// ─── ContractBuilder ─────────────────────────────────────────

describe('ContractBuilder', () => {
  it('builds a contract via fluent API', () => {
    const c = new ContractBuilder()
      .setName('Builder Test')
      .setDescription('Built via builder')
      .setInputSchema({ type: 'object' })
      .setOutputSchema({ type: 'string' })
      .setMaxAttempts(5)
      .setTimeout(10_000)
      .addRequiredCriteria('Has output', 'schema', { requiredKeys: ['result'] })
      .addOptionalCriteria('Good quality', 'model-graded', 0.5)
      .build();

    expect(c.name).toBe('Builder Test');
    expect(c.description).toBe('Built via builder');
    expect(c.maxAttempts).toBe(5);
    expect(c.timeoutMs).toBe(10_000);
    expect(c.acceptanceCriteria).toHaveLength(2);
    expect(c.acceptanceCriteria[0]!.required).toBe(true);
    expect(c.acceptanceCriteria[1]!.required).toBe(false);
  });

  it('throws when name is missing', () => {
    expect(() => new ContractBuilder().build()).toThrow('Contract name is required');
  });
});

describe('defineContract', () => {
  it('returns a ContractBuilder with optional name', () => {
    const b = defineContract('Quick');
    const c = b.build();
    expect(c.name).toBe('Quick');
  });
});

// ─── DefaultCompletionValidator ──────────────────────────────

describe('DefaultCompletionValidator', () => {
  it('validates schema criteria — all keys present', async () => {
    const contract = createContract({
      name: 'Schema Test',
      acceptanceCriteria: [{
        id: 'c1', description: 'Has keys', type: 'schema', required: true,
        config: { requiredKeys: ['name', 'value'] },
      }],
    });

    const validator = new DefaultCompletionValidator();
    const report = await validator.validate({ name: 'foo', value: 42 }, contract);
    expect(report.status).toBe('fulfilled');
    expect(report.confidence).toBe(1);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.passed).toBe(true);
  });

  it('validates schema criteria — missing keys', async () => {
    const contract = createContract({
      name: 'Schema Fail',
      acceptanceCriteria: [{
        id: 'c1', description: 'Has keys', type: 'schema', required: true,
        config: { requiredKeys: ['name', 'value'] },
      }],
    });

    const validator = new DefaultCompletionValidator();
    const report = await validator.validate({ name: 'foo' }, contract);
    expect(report.status).toBe('failed');
    expect(report.results[0]!.passed).toBe(false);
  });

  it('validates assertion criteria — exists', async () => {
    const contract = createContract({
      name: 'Assert Exists',
      acceptanceCriteria: [{
        id: 'c1', description: 'Output exists', type: 'assertion', required: true,
        config: { field: 'result', operator: 'exists' },
      }],
    });
    const validator = new DefaultCompletionValidator();
    const report = await validator.validate({ result: 'hello' }, contract);
    expect(report.status).toBe('fulfilled');
  });

  it('validates assertion criteria — equals', async () => {
    const contract = createContract({
      name: 'Assert Equals',
      acceptanceCriteria: [{
        id: 'c1', description: 'Status is ok', type: 'assertion', required: true,
        config: { field: 'status', operator: 'equals', expected: 'ok' },
      }],
    });
    const validator = new DefaultCompletionValidator();
    const pass = await validator.validate({ status: 'ok' }, contract);
    expect(pass.status).toBe('fulfilled');
    const fail = await validator.validate({ status: 'error' }, contract);
    expect(fail.status).toBe('failed');
  });

  it('validates assertion criteria — contains', async () => {
    const contract = createContract({
      name: 'Assert Contains',
      acceptanceCriteria: [{
        id: 'c1', description: 'Has keyword', type: 'assertion', required: true,
        config: { field: 'text', operator: 'contains', expected: 'hello' },
      }],
    });
    const validator = new DefaultCompletionValidator();
    const report = await validator.validate({ text: 'say hello world' }, contract);
    expect(report.status).toBe('fulfilled');
  });

  it('validates assertion criteria — gt / gte', async () => {
    const contract = createContract({
      name: 'Assert GT',
      acceptanceCriteria: [
        { id: 'c1', description: 'Score > 0.5', type: 'assertion', required: true, config: { field: 'score', operator: 'gt', expected: 0.5 } },
        { id: 'c2', description: 'Score >= 0.8', type: 'assertion', required: false, config: { field: 'score', operator: 'gte', expected: 0.8 } },
      ],
    });
    const validator = new DefaultCompletionValidator();
    const report = await validator.validate({ score: 0.7 }, contract);
    expect(report.status).toBe('partial'); // c1 passes, c2 fails
    expect(report.results[0]!.passed).toBe(true);
    expect(report.results[1]!.passed).toBe(false);
  });

  it('handles custom / model-graded / human-review as auto-pass', async () => {
    const contract = createContract({
      name: 'Custom',
      acceptanceCriteria: [
        { id: 'c1', description: 'Custom check', type: 'custom', required: true },
        { id: 'c2', description: 'Model graded', type: 'model-graded', required: false },
        { id: 'c3', description: 'Human review', type: 'human-review', required: false },
      ],
    });
    const validator = new DefaultCompletionValidator();
    const report = await validator.validate({}, contract);
    expect(report.status).toBe('fulfilled');
    expect(report.confidence).toBe(1);
  });

  it('registerChecker overrides built-in', async () => {
    const contract = createContract({
      name: 'Override',
      acceptanceCriteria: [{
        id: 'c1', description: 'Custom assertion', type: 'custom', required: true,
      }],
    });
    const validator = new DefaultCompletionValidator();
    validator.registerChecker('custom', () => ({
      criteriaId: 'c1', passed: false, score: 0, explanation: 'Always fails',
    }));
    const report = await validator.validate({}, contract);
    expect(report.status).toBe('failed');
  });

  it('reports unknown checker type as failed', async () => {
    const contract = createContract({
      name: 'Unknown',
      acceptanceCriteria: [{
        id: 'c1', description: 'Unknown type', type: 'magic' as any, required: true,
      }],
    });
    const validator = new DefaultCompletionValidator();
    const report = await validator.validate({}, contract);
    expect(report.status).toBe('failed');
    expect(report.results[0]!.explanation).toContain('No checker registered');
  });
});

// ─── createEvidence ──────────────────────────────────────────

describe('createEvidence', () => {
  it('creates an evidence bundle', () => {
    const bundle = createEvidence(
      { type: 'text', label: 'note', value: 'all good' },
      { type: 'metric', label: 'score', value: 0.95 },
    );
    expect(bundle.items).toHaveLength(2);
  });
});

// ─── createCompletionReport ──────────────────────────────────

describe('createCompletionReport', () => {
  it('creates a fulfilled report', () => {
    const report = createCompletionReport('tc-1', [
      { criteriaId: 'c1', passed: true, score: 1, explanation: 'ok' },
    ]);
    expect(report.taskContractId).toBe('tc-1');
    expect(report.status).toBe('fulfilled');
    expect(report.confidence).toBe(1);
    expect(report.completedAt).toBeDefined();
  });

  it('creates a partial report', () => {
    const report = createCompletionReport('tc-2', [
      { criteriaId: 'c1', passed: true, score: 1 },
      { criteriaId: 'c2', passed: false, score: 0 },
    ]);
    expect(report.status).toBe('partial');
    expect(report.confidence).toBe(0.5);
  });

  it('creates a failed report', () => {
    const report = createCompletionReport('tc-3', [
      { criteriaId: 'c1', passed: false, score: 0 },
    ]);
    expect(report.status).toBe('failed');
    expect(report.confidence).toBe(0);
  });
});

// ─── createEvidenceBundle ────────────────────────────────────

describe('createEvidenceBundle', () => {
  it('creates a bundle from items', () => {
    const b = createEvidenceBundle(
      evidence.text('note', 'test'),
      evidence.metric('score', 0.9),
    );
    expect(b.items).toHaveLength(2);
  });
});

// ─── evidence helpers ────────────────────────────────────────

describe('evidence helpers', () => {
  it('text', () => expect(evidence.text('a', 'b')).toEqual({ type: 'text', label: 'a', value: 'b' }));
  it('metric', () => expect(evidence.metric('x', 42)).toEqual({ type: 'metric', label: 'x', value: 42 }));
  it('url', () => expect(evidence.url('link', 'https://a.com')).toEqual({ type: 'url', label: 'link', value: 'https://a.com' }));
  it('file', () => expect(evidence.file('doc', '/path/file')).toEqual({ type: 'file', label: 'doc', value: '/path/file' }));
  it('trace', () => expect(evidence.trace('t', 'trace-id')).toEqual({ type: 'trace', label: 't', value: 'trace-id' }));
});

// ─── createTaskOutcome ───────────────────────────────────────

describe('createTaskOutcome', () => {
  it('maps fulfilled report to success', () => {
    const report = createCompletionReport('tc-1', [
      { criteriaId: 'c1', passed: true, score: 1 },
    ]);
    const outcome = createTaskOutcome('tc-1', report, { result: 'done' });
    expect(outcome.status).toBe('success');
    expect(outcome.output).toEqual({ result: 'done' });
    expect(outcome.failureReason).toBeUndefined();
  });

  it('maps partial report to partial-success', () => {
    const report = createCompletionReport('tc-2', [
      { criteriaId: 'c1', passed: true, score: 1 },
      { criteriaId: 'c2', passed: false, score: 0 },
    ]);
    const outcome = createTaskOutcome('tc-2', report);
    expect(outcome.status).toBe('partial-success');
  });

  it('maps failed report to failure with reason', () => {
    const report = createCompletionReport('tc-3', [
      { criteriaId: 'c1', passed: false, score: 0 },
    ]);
    const outcome = createTaskOutcome('tc-3', report);
    expect(outcome.status).toBe('failure');
    expect(outcome.failureReason).toBeDefined();
    expect(outcome.failureReason?.code).toBe('VALIDATION_FAILED');
  });
});

// ─── createFailureReason ─────────────────────────────────────

describe('createFailureReason', () => {
  it('creates a failure reason', () => {
    const r = createFailureReason('ERR', 'Something broke', 'model-error', true, { detail: 'x' });
    expect(r.code).toBe('ERR');
    expect(r.message).toBe('Something broke');
    expect(r.category).toBe('model-error');
    expect(r.recoverable).toBe(true);
    expect(r.details).toEqual({ detail: 'x' });
  });
});

// ─── failures presets ────────────────────────────────────────

describe('failures presets', () => {
  it('timeout', () => {
    const f = failures.timeout();
    expect(f.code).toBe('TIMEOUT');
    expect(f.category).toBe('timeout');
    expect(f.recoverable).toBe(true);
  });

  it('cancelled', () => {
    const f = failures.cancelled();
    expect(f.code).toBe('CANCELLED');
    expect(f.recoverable).toBe(false);
  });

  it('permissionDenied', () => {
    const f = failures.permissionDenied();
    expect(f.code).toBe('PERMISSION_DENIED');
    expect(f.category).toBe('permission');
  });

  it('modelError', () => {
    const f = failures.modelError('GPU OOM');
    expect(f.message).toBe('GPU OOM');
    expect(f.category).toBe('model-error');
  });

  it('validationFailed', () => {
    const f = failures.validationFailed();
    expect(f.code).toBe('VALIDATION_FAILED');
    expect(f.category).toBe('validation');
  });
});
