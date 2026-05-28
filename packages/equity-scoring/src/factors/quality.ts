/**
 * Quality factor — AQR-style: profitability, growth-in-quality, safety, payout.
 * Profitability factor is split out separately but also contributes here.
 */

import type { InputBundle, FactorScore } from '../types.js';
import { crossSectionalZ, squash, clip, slope } from '../math.js';

export function computeQuality(self: InputBundle, peers: InputBundle[]): FactorScore {
  const f = self.fundamentals;
  const notes: string[] = [];
  const rawInputs: Record<string, number | null> = {};

  // Sub-pillar 1: Profitability
  const profitMetrics = [
    { key: 'roe',           val: f.roe,           peerVals: peers.map(p => p.fundamentals.roe) },
    { key: 'roa',           val: f.roa,           peerVals: peers.map(p => p.fundamentals.roa) },
    { key: 'roic',          val: f.roic,          peerVals: peers.map(p => p.fundamentals.roic) },
    { key: 'grossProfitToAssets', val: f.grossProfitToAssets, peerVals: peers.map(p => p.fundamentals.grossProfitToAssets) },
    { key: 'grossMargin',   val: f.grossMargin,   peerVals: peers.map(p => p.fundamentals.grossMargin) },
    { key: 'operatingMargin', val: f.operatingMargin, peerVals: peers.map(p => p.fundamentals.operatingMargin) },
  ];
  for (const m of profitMetrics) rawInputs[m.key] = m.val;

  // Sub-pillar 2: Growth-in-quality (ROIC trend + gross margin trend over 5y annual)
  const roicHistory   = self.annual.slice(0, 5).map(a => a.roicReported).filter((v): v is number => v !== null);
  const marginHistory = self.annual.slice(0, 5).map(a => a.grossProfit !== null && a.revenue !== null && a.revenue > 0 ? a.grossProfit / a.revenue : null).filter((v): v is number => v !== null);
  const roicSlope   = slope(roicHistory.reverse());
  const marginSlope = slope(marginHistory.reverse());
  rawInputs['roicTrend5y']   = roicSlope;
  rawInputs['marginTrend5y'] = marginSlope;

  const peerRoicSlopes   = peers.map(p => { const h = p.annual.slice(0,5).map(a => a.roicReported).filter((v): v is number => v !== null); return slope(h.reverse()); });
  const peerMarginSlopes = peers.map(p => { const h = p.annual.slice(0,5).map(a => a.grossProfit !== null && a.revenue !== null && a.revenue > 0 ? a.grossProfit / a.revenue : null).filter((v): v is number => v !== null); return slope(h.reverse()); });

  // Sub-pillar 3: Safety
  const safetyMetrics = [
    { key: 'debtToEquity',  val: f.debtToEquity !== null ? -f.debtToEquity : null,    peerVals: peers.map(p => p.fundamentals.debtToEquity !== null ? -p.fundamentals.debtToEquity! : null) },
    { key: 'netDebtToEbitda', val: f.netDebtToEbitda !== null ? -f.netDebtToEbitda : null, peerVals: peers.map(p => p.fundamentals.netDebtToEbitda !== null ? -p.fundamentals.netDebtToEbitda! : null) },
    { key: 'interestCoverage', val: f.interestCoverage, peerVals: peers.map(p => p.fundamentals.interestCoverage) },
    { key: 'altmanZ',       val: f.altmanZScore,  peerVals: peers.map(p => p.fundamentals.altmanZScore) },
  ];
  for (const m of safetyMetrics) rawInputs[m.key] = m.val;

  // Aggregate
  const allMetrics = [
    ...profitMetrics.map(m => ({ ...m, peerVals: m.peerVals })),
    { key: 'roicTrend5y',   val: roicSlope,   peerVals: peerRoicSlopes },
    { key: 'marginTrend5y', val: marginSlope,  peerVals: peerMarginSlopes },
    ...safetyMetrics,
    { key: 'shareholderYield', val: f.shareholderYield, peerVals: peers.map(p => p.fundamentals.shareholderYield) },
  ];

  let totalZ = 0, totalWeight = 0;
  for (const m of allMetrics) {
    const { z, coverage } = crossSectionalZ(m.val, m.peerVals);
    const w = coverage;
    totalZ += z * w;
    totalWeight += w;
    if (coverage < 1) notes.push(`${m.key} imputed`);
  }

  const avgZ = totalWeight > 0 ? totalZ / totalWeight : 0;
  const coverage = allMetrics.filter(m => m.val !== null).length / allMetrics.length;

  return {
    category: 'quality', zScore: clip(avgZ, -3, 3), score: squash(avgZ),
    rawInputs, coverage, notes,
  };
}

export function computeProfitability(self: InputBundle, peers: InputBundle[]): FactorScore {
  const f = self.fundamentals;
  const metrics = [
    { key: 'roe',           val: f.roe,           peerVals: peers.map(p => p.fundamentals.roe) },
    { key: 'roa',           val: f.roa,           peerVals: peers.map(p => p.fundamentals.roa) },
    { key: 'roic',          val: f.roic,          peerVals: peers.map(p => p.fundamentals.roic) },
    { key: 'netMargin',     val: f.netMargin,     peerVals: peers.map(p => p.fundamentals.netMargin) },
    { key: 'grossMargin',   val: f.grossMargin,   peerVals: peers.map(p => p.fundamentals.grossMargin) },
  ];

  let totalZ = 0, totalWeight = 0;
  const rawInputs: Record<string, number | null> = {};
  const notes: string[] = [];

  for (const m of metrics) {
    rawInputs[m.key] = m.val;
    const { z, coverage } = crossSectionalZ(m.val, m.peerVals);
    totalZ += z * coverage;
    totalWeight += coverage;
    if (coverage < 1) notes.push(`${m.key} imputed`);
  }

  const avgZ = totalWeight > 0 ? totalZ / totalWeight : 0;
  const coverage = metrics.filter(m => m.val !== null).length / metrics.length;

  return {
    category: 'profitability', zScore: clip(avgZ, -3, 3), score: squash(avgZ),
    rawInputs, coverage, notes,
  };
}
