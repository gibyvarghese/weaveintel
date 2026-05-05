import { describe, it, expect } from 'vitest';
import { createTokenBucket } from './token-bucket.js';

describe('TokenBucket', () => {
  it('starts full and decrements on tryAcquire', () => {
    const b = createTokenBucket({ capacity: 3, refillPerSec: 10 });
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
  });

  it('refills over time', async () => {
    const b = createTokenBucket({ capacity: 1, refillPerSec: 50 }); // 1 token / 20ms
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(b.tryAcquire()).toBe(true);
  });

  it('pauseFor blocks tryAcquire even when tokens are available', async () => {
    const b = createTokenBucket({ capacity: 5, refillPerSec: 10 });
    b.pauseFor(50);
    expect(b.tryAcquire()).toBe(false);
    await new Promise((r) => setTimeout(r, 70));
    expect(b.tryAcquire()).toBe(true);
  });

  it('acquire waits until token available', async () => {
    const b = createTokenBucket({ capacity: 1, refillPerSec: 100 });
    b.tryAcquire(); // empty bucket
    const start = Date.now();
    await b.acquire(200);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(5);
    expect(elapsed).toBeLessThan(200);
  });
});
