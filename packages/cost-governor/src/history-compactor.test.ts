import { describe, it, expect, vi } from 'vitest';
import {
  decideCompaction,
  weaveHistoryCompactor,
  type HistorySummarizer,
} from './history-compactor.js';
import type { HistoryItem } from './governor.js';
import type { HistoryCompactionConfig } from './policy.js';

const mk = (role: string, content: string): HistoryItem => ({ role, content });

const mkHistory = (n: number, withSystem = true): HistoryItem[] => {
  const arr: HistoryItem[] = withSystem ? [mk('system', 'sys')] : [];
  for (let i = 0; i < n; i++) {
    arr.push(mk(i % 2 === 0 ? 'user' : 'assistant', `msg-${i}`));
  }
  return arr;
};

describe('decideCompaction (pure)', () => {
  it('passes through when config is null', async () => {
    const h = mkHistory(50);
    const r = await decideCompaction(h, null, {});
    expect(r.messages).toBe(h);
    expect(r.dropped).toEqual([]);
    expect(r.reason).toBe('no-config');
  });

  it('passes through with strategy=none', async () => {
    const h = mkHistory(50);
    const r = await decideCompaction(h, { strategy: 'none' }, {});
    expect(r.messages).toBe(h);
  });

  it('passes through with strategy=hierarchical (reserved)', async () => {
    const h = mkHistory(50);
    const r = await decideCompaction(h, { strategy: 'hierarchical' }, {});
    expect(r.messages).toBe(h);
    expect(r.reason).toMatch(/reserved/);
  });

  it('passes through when history fits in window', async () => {
    const h = mkHistory(5); // 1 system + 5 = 6 total
    const cfg: HistoryCompactionConfig = { strategy: 'sliding', windowTurns: 12 };
    const r = await decideCompaction(h, cfg, {});
    expect(r.messages).toBe(h);
    expect(r.reason).toMatch(/under-window/);
  });

  it('sliding strategy drops middle, keeps system + tail window', async () => {
    const h = mkHistory(20); // 1 system + 20 = 21
    const cfg: HistoryCompactionConfig = { strategy: 'sliding', windowTurns: 5 };
    const r = await decideCompaction(h, cfg, {});
    expect(r.messages.length).toBe(1 + 5); // system + window
    expect(r.messages[0]?.role).toBe('system');
    expect(r.dropped.length).toBe(20 - 5); // 15 dropped
    expect(r.messages[r.messages.length - 1]).toBe(h[h.length - 1]);
    expect(r.messages[r.messages.length - 2]).toBe(h[h.length - 2]);
  });

  it('preserves last 2 turns even when windowTurns=0', async () => {
    const h = mkHistory(10);
    const cfg: HistoryCompactionConfig = { strategy: 'sliding', windowTurns: 0 };
    const r = await decideCompaction(h, cfg, {});
    // system + 2 (tail floor)
    expect(r.messages.length).toBe(3);
    expect(r.messages[0]?.role).toBe('system');
    expect(r.messages[r.messages.length - 1]).toBe(h[h.length - 1]);
    expect(r.messages[r.messages.length - 2]).toBe(h[h.length - 2]);
  });

  it('works without a leading system message', async () => {
    const h = mkHistory(10, /* withSystem */ false);
    const cfg: HistoryCompactionConfig = { strategy: 'sliding', windowTurns: 3 };
    const r = await decideCompaction(h, cfg, {});
    expect(r.messages.length).toBe(3);
    expect(r.dropped.length).toBe(7);
  });

  it('summary strategy without summariser falls back to sliding', async () => {
    const h = mkHistory(20);
    const cfg: HistoryCompactionConfig = { strategy: 'summary', windowTurns: 5 };
    const r = await decideCompaction(h, cfg, {});
    expect(r.messages.length).toBe(1 + 5);
    expect(r.summary).toBeUndefined();
    expect(r.reason).toMatch(/no summariser/);
  });

  it('summary strategy invokes summariser and prepends summary item', async () => {
    const h = mkHistory(20);
    const cfg: HistoryCompactionConfig = { strategy: 'summary', windowTurns: 5 };
    const summarizer: HistorySummarizer = vi.fn(async (dropped) => `recap of ${dropped.length} turns`);
    const r = await decideCompaction(h, cfg, {}, summarizer);
    // system + summary + 5 tail
    expect(r.messages.length).toBe(1 + 1 + 5);
    expect(r.messages[1]?.role).toBe('system');
    expect((r.messages[1]?.content as string)).toMatch(/history-summary/);
    expect(r.summary).toBe('recap of 15 turns');
    expect(summarizer).toHaveBeenCalledOnce();
  });

  it('summary strategy with throwing summariser falls back to sliding (no throw)', async () => {
    const h = mkHistory(20);
    const cfg: HistoryCompactionConfig = { strategy: 'summary', windowTurns: 5 };
    const summarizer: HistorySummarizer = async () => {
      throw new Error('llm timeout');
    };
    const r = await decideCompaction(h, cfg, {}, summarizer);
    expect(r.messages.length).toBe(1 + 5);
    expect(r.summary).toBeUndefined();
    expect(r.reason).toMatch(/threw/);
  });

  it('summary strategy with empty summariser output falls back to sliding', async () => {
    const h = mkHistory(20);
    const cfg: HistoryCompactionConfig = { strategy: 'summary', windowTurns: 5 };
    const r = await decideCompaction(h, cfg, {}, async () => '');
    expect(r.messages.length).toBe(1 + 5);
    expect(r.summary).toBeUndefined();
    expect(r.reason).toMatch(/empty/);
  });

  it('passes through on invalid windowTurns', async () => {
    const h = mkHistory(10);
    const cfg = { strategy: 'sliding', windowTurns: -3 } as HistoryCompactionConfig;
    const r = await decideCompaction(h, cfg, {});
    expect(r.messages).toBe(h);
    expect(r.reason).toBe('invalid-windowTurns');
  });
});

describe('weaveHistoryCompactor factory', () => {
  it('returns a function that compacts according to the config', async () => {
    const cfg: HistoryCompactionConfig = { strategy: 'sliding', windowTurns: 4 };
    const compactor = weaveHistoryCompactor(cfg);
    const h = mkHistory(20);
    const out = await compactor(h, {});
    expect(out.length).toBe(1 + 4);
  });
});
