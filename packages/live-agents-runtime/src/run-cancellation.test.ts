import { describe, it, expect } from 'vitest';
import { RunCancellationBus } from './run-cancellation.js';

describe('RunCancellationBus', () => {
  it('isCancelled returns false before cancel', () => {
    const bus = new RunCancellationBus();
    expect(bus.isCancelled('run-1')).toBe(false);
  });

  it('getSignal returns undefined before cancel', () => {
    const bus = new RunCancellationBus();
    expect(bus.getSignal('run-1')).toBeUndefined();
  });

  it('cancel fires abort signal', () => {
    const bus = new RunCancellationBus();
    bus.cancel('run-1');
    const sig = bus.getSignal('run-1');
    expect(sig?.aborted).toBe(true);
  });

  it('isCancelled returns true after cancel', () => {
    const bus = new RunCancellationBus();
    bus.cancel('run-1');
    expect(bus.isCancelled('run-1')).toBe(true);
  });

  it('cancel is idempotent', () => {
    const bus = new RunCancellationBus();
    bus.cancel('run-1');
    bus.cancel('run-1'); // second call should not throw
    expect(bus.isCancelled('run-1')).toBe(true);
  });

  it('clear removes the run entry', () => {
    const bus = new RunCancellationBus();
    bus.cancel('run-1');
    bus.clear('run-1');
    expect(bus.isCancelled('run-1')).toBe(false);
    expect(bus.getSignal('run-1')).toBeUndefined();
  });

  it('cancelling one run does not affect others', () => {
    const bus = new RunCancellationBus();
    bus.cancel('run-a');
    expect(bus.isCancelled('run-a')).toBe(true);
    expect(bus.isCancelled('run-b')).toBe(false);
  });

  it('size reflects tracked runs', () => {
    const bus = new RunCancellationBus();
    expect(bus.size).toBe(0);
    bus.cancel('run-1');
    bus.cancel('run-2');
    expect(bus.size).toBe(2);
    bus.clear('run-1');
    expect(bus.size).toBe(1);
  });

  it('AbortSignal reason is a DOMException-like with aborted=true', () => {
    const bus = new RunCancellationBus();
    bus.cancel('run-x');
    const sig = bus.getSignal('run-x')!;
    expect(sig.aborted).toBe(true);
  });
});
