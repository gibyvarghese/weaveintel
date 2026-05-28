/**
 * Value factor — cheap-is-good (INVERTED z-score).
 * Lower P/E, P/B, EV/EBITDA → higher score.
 */

import type { InputBundle, FactorScore } from '../types.js';
import { crossSectionalZ, squash, clip } from '../math.js';

export function computeValue(self: InputBundle, peers: InputBundle[]): FactorScore {
  const f = self.fundamentals;
  const notes: string[] = [];
  const rawInputs: Record<string, number | null> = {};

  // Metrics where lower = cheaper = better → we INVERT the z-score
  type Metric = { key: string; selfVal: number | null; peerVals: Array<number | null> };
  const metrics: Metric[] = [
    { key: 'peRatio',        selfVal: f.peRatio,        peerVals: peers.map(p => p.fundamentals.peRatio) },
    { key: 'pbRatio',        selfVal: f.pbRatio,        peerVals: peers.map(p => p.fundamentals.pbRatio) },
    { key: 'psRatio',        selfVal: f.psRatio,        peerVals: peers.map(p => p.fundamentals.psRatio) },
    { key: 'evToEbitda',     selfVal: f.evToEbitda,     peerVals: peers.map(p => p.fundamentals.evToEbitda) },
    { key: 'evToSales',      selfVal: f.evToSales,      peerVals: peers.map(p => p.fundamentals.evToSales) },
    // Higher = cheaper/more attractive → NOT inverted
    { key: 'fcfYield',       selfVal: f.fcfYield ? -f.fcfYield : null,   peerVals: peers.map(p => p.fundamentals.fcfYield ? -p.fundamentals.fcfYield! : null) },
    { key: 'earningsYield',  selfVal: f.earningsYield ? -f.earningsYield : null, peerVals: peers.map(p => p.fundamentals.earningsYield ? -p.fundamentals.earningsYield! : null) },
    { key: 'shareholderYield', selfVal: f.shareholderYield ? -f.shareholderYield : null, peerVals: peers.map(p => p.fundamentals.shareholderYield ? -p.fundamentals.shareholderYield! : null) },
  ];

  // Trim negative P/E (negative earnings make P/E meaningless)
  if (f.peRatio !== null && f.peRatio < 0) metrics[0]!.selfVal = null;
  if (f.evToEbitda !== null && f.evToEbitda < 0) metrics[3]!.selfVal = null;

  let totalZ = 0, totalWeight = 0;
  for (const m of metrics) {
    rawInputs[m.key] = m.selfVal;
    const { z, coverage } = crossSectionalZ(m.selfVal, m.peerVals);
    const invertedZ = -z;  // lower ratio → higher z → higher score
    const w = coverage;
    totalZ += invertedZ * w;
    totalWeight += w;
    if (coverage < 1) notes.push(`${m.key} imputed from peer median`);
  }

  const avgZ = totalWeight > 0 ? totalZ / totalWeight : 0;
  const coverage = metrics.filter(m => m.selfVal !== null).length / metrics.length;

  return {
    category: 'value',
    zScore: clip(avgZ, -3, 3),
    score: squash(avgZ),
    rawInputs,
    coverage,
    notes,
  };
}
