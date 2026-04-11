/**
 * Retrieval diagnostics — tracks retrieval quality metrics
 */

export interface RetrievalDiagnostics {
  queryCount: number;
  avgResultCount: number;
  avgLatencyMs: number;
  avgTopScore: number;
  emptyResultRate: number;
  queries: Array<{
    query: string;
    resultCount: number;
    topScore: number;
    latencyMs: number;
    timestamp: number;
  }>;
}

export function weaveRetrievalDiagnostics() {
  const logs: RetrievalDiagnostics['queries'] = [];

  return {
    record(query: string, resultCount: number, topScore: number, latencyMs: number) {
      logs.push({ query, resultCount, topScore, latencyMs, timestamp: Date.now() });
    },

    getStats(): RetrievalDiagnostics {
      const n = logs.length;
      if (n === 0) {
        return { queryCount: 0, avgResultCount: 0, avgLatencyMs: 0, avgTopScore: 0, emptyResultRate: 0, queries: [] };
      }
      const totalResults = logs.reduce((s, l) => s + l.resultCount, 0);
      const totalLatency = logs.reduce((s, l) => s + l.latencyMs, 0);
      const totalScore = logs.reduce((s, l) => s + l.topScore, 0);
      const emptyCount = logs.filter(l => l.resultCount === 0).length;

      return {
        queryCount: n,
        avgResultCount: totalResults / n,
        avgLatencyMs: totalLatency / n,
        avgTopScore: totalScore / n,
        emptyResultRate: emptyCount / n,
        queries: logs.slice(-100), // keep last 100
      };
    },

    reset() {
      logs.length = 0;
    },
  };
}

export type RetrievalDiagnosticsTracker = ReturnType<typeof weaveRetrievalDiagnostics>;
