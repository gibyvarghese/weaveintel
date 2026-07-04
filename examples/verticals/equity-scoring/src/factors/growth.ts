/**
 * Growth factor.
 * Penalizes growth achieved via share dilution.
 */

import type { InputBundle, FactorScore, RedFlag } from '../types.js';
import { crossSectionalZ, squash, clip, cagr } from '../math.js';

function computeCagr(annual: InputBundle['annual'], field: 'revenue' | 'netIncome' | 'fcf', years: number): number | null {
  if (annual.length < years + 1) return null;
  const first = annual[years]?.[field] ?? null;
  const last  = annual[0]?.[field] ?? null;
  return cagr(first, last, years);
}

export function computeGrowth(self: InputBundle, peers: InputBundle[]): { factor: FactorScore; flags: RedFlag[] } {
  const f = self.fundamentals;
  const annual = self.annual;
  const flags: RedFlag[] = [];
  const notes: string[] = [];
  const rawInputs: Record<string, number | null> = {};

  const revCagr3  = computeCagr(annual, 'revenue', 3);
  const revCagr5  = computeCagr(annual, 'revenue', 5);
  const niCagr3   = computeCagr(annual, 'netIncome', 3);
  const niCagr5   = computeCagr(annual, 'netIncome', 5);
  const fcfCagr3  = computeCagr(annual, 'fcf', 3);
  const revYoy    = f.revenueGrowthYoy;
  const epsYoy    = f.epsGrowthYoy;
  const ltGrowth  = self.analyst?.longTermGrowthEstimate ?? null;

  // Dilution check
  const shareFirst = annual[4]?.sharesDilutedAvg ?? null;
  const shareLast  = annual[0]?.sharesDilutedAvg ?? null;
  const shareGrowth5 = cagr(shareFirst, shareLast, 4);
  if (shareGrowth5 !== null && revCagr5 !== null && shareGrowth5 > revCagr5 + 0.02) {
    flags.push({ code: 'GROWTH_VIA_DILUTION', severity: 'medium', evidence: `5y share CAGR ${(shareGrowth5 * 100).toFixed(1)}% > revenue CAGR ${(revCagr5 * 100).toFixed(1)}%` });
    notes.push('Growth penalized: driven partly by share issuance');
  }

  const metrics = [
    { key: 'revCagr3',  val: revCagr3,  peerVals: peers.map(p => computeCagr(p.annual, 'revenue', 3)) },
    { key: 'revCagr5',  val: revCagr5,  peerVals: peers.map(p => computeCagr(p.annual, 'revenue', 5)) },
    { key: 'niCagr3',   val: niCagr3,   peerVals: peers.map(p => computeCagr(p.annual, 'netIncome', 3)) },
    { key: 'niCagr5',   val: niCagr5,   peerVals: peers.map(p => computeCagr(p.annual, 'netIncome', 5)) },
    { key: 'fcfCagr3',  val: fcfCagr3,  peerVals: peers.map(p => computeCagr(p.annual, 'fcf', 3)) },
    { key: 'revYoy',    val: revYoy,    peerVals: peers.map(p => p.fundamentals.revenueGrowthYoy) },
    { key: 'epsYoy',    val: epsYoy,    peerVals: peers.map(p => p.fundamentals.epsGrowthYoy) },
    { key: 'ltGrowth',  val: ltGrowth,  peerVals: peers.map(p => p.analyst?.longTermGrowthEstimate ?? null) },
  ];

  for (const m of metrics) rawInputs[m.key] = m.val;

  let totalZ = 0, totalWeight = 0;
  for (const m of metrics) {
    const { z, coverage } = crossSectionalZ(m.val, m.peerVals);
    const w = coverage;
    totalZ += z * w;
    totalWeight += w;
    if (coverage < 1) notes.push(`${m.key} imputed`);
  }

  let avgZ = totalWeight > 0 ? totalZ / totalWeight : 0;
  // Apply dilution penalty
  if (flags.some(f => f.code === 'GROWTH_VIA_DILUTION')) avgZ *= 0.5;

  const coverage = metrics.filter(m => m.val !== null).length / metrics.length;

  return {
    factor: {
      category: 'growth', zScore: clip(avgZ, -3, 3), score: squash(avgZ),
      rawInputs, coverage, notes,
    },
    flags,
  };
}
