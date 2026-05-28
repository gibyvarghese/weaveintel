/**
 * Momentum factor — 12-1 (skip last month).
 * Also computes 6-1 and 3-1 sub-signals. Asness consistency boost.
 */

import type { InputBundle, FactorScore } from '../types.js';
import { crossSectionalZ, squash, clip } from '../math.js';

function priceReturn(ohlcv: InputBundle['ohlcv'], daysBack: number, skipDays: number = 21): number | null {
  if (ohlcv.length < daysBack) return null;
  const sorted = [...ohlcv].sort((a, b) => a.ts.localeCompare(b.ts));
  const endIdx   = sorted.length - 1 - skipDays;
  const startIdx = sorted.length - 1 - daysBack;
  if (startIdx < 0 || endIdx <= startIdx) return null;
  const pStart = sorted[startIdx]?.adjustedClose;
  const pEnd   = sorted[endIdx]?.adjustedClose;
  if (!pStart || !pEnd || pStart === 0) return null;
  return (pEnd - pStart) / pStart;
}

function getMomentum(bundle: InputBundle) {
  return {
    mom12_1: priceReturn(bundle.ohlcv, 252, 21),
    mom6_1:  priceReturn(bundle.ohlcv, 126, 21),
    mom3_1:  priceReturn(bundle.ohlcv, 63,  21),
  };
}

export function computeMomentum(self: InputBundle, peers: InputBundle[]): FactorScore {
  const selfMom = getMomentum(self);
  const peerMoms = peers.map(getMomentum);
  const notes: string[] = [];

  const metrics = [
    { key: 'mom12_1', val: selfMom.mom12_1, peerVals: peerMoms.map(p => p.mom12_1) },
    { key: 'mom6_1',  val: selfMom.mom6_1,  peerVals: peerMoms.map(p => p.mom6_1) },
    { key: 'mom3_1',  val: selfMom.mom3_1,  peerVals: peerMoms.map(p => p.mom3_1) },
  ];

  let totalZ = 0, totalWeight = 0;
  for (const m of metrics) {
    const { z, coverage } = crossSectionalZ(m.val, m.peerVals);
    totalZ += z * coverage;
    totalWeight += coverage;
    if (coverage < 1) notes.push(`${m.key} imputed`);
  }

  let avgZ = totalWeight > 0 ? totalZ / totalWeight : 0;

  // Asness-style consistency boost: all three horizons agree in sign
  const signs = [selfMom.mom12_1, selfMom.mom6_1, selfMom.mom3_1].filter(v => v !== null).map(v => Math.sign(v!));
  if (signs.length === 3 && signs.every(s => s === signs[0])) {
    const boost = 1.1;
    avgZ *= boost;
    notes.push(`Consistency boost ×${boost}: all three momentum horizons agree`);
  }

  const rawInputs = { mom12_1: selfMom.mom12_1, mom6_1: selfMom.mom6_1, mom3_1: selfMom.mom3_1 };
  const coverage = metrics.filter(m => m.val !== null).length / metrics.length;

  return {
    category: 'momentum', zScore: clip(avgZ, -3, 3), score: squash(avgZ),
    rawInputs, coverage, notes,
  };
}
