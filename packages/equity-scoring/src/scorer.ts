/**
 * Main scoring engine — pure functions, no LLM.
 */

import type {
  InputBundle, FactorCategory, FactorScore, SymbolScore,
  ScoringStrategy, PeerSet, RedFlag, GreenFlag,
} from './types.js';
import { computeValue } from './factors/value.js';
import { computeGrowth } from './factors/growth.js';
import { computeQuality, computeProfitability } from './factors/quality.js';
import { computeMomentum } from './factors/momentum.js';
import {
  computeLowVolatility, computeSize, computeYield, computeSentiment,
  computeInsider, computeInstitutional, computeShortSignal, computeOptionsSignal,
  computeAnalyst, computeEarningsQuality, computeCapitalAllocation,
  computeMacroFit, computeAltSignals,
} from './factors/misc.js';
import { detectFlags } from './flags.js';
import { clip } from './math.js';

export function buildPeerSet(target: InputBundle['profile'], universe: InputBundle['profile'][], mode: ScoringStrategy['peerSetMode']): PeerSet {
  if (mode === 'industry') {
    const key = target.industry ?? target.sector ?? 'unknown';
    const peers = universe.filter(p => p.symbol !== target.symbol && (p.industry ?? p.sector) === key);
    return { type: 'industry', key, size: peers.length };
  }
  if (mode === 'sector') {
    const key = target.sector ?? 'unknown';
    const peers = universe.filter(p => p.symbol !== target.symbol && p.sector === key);
    return { type: 'sector', key, size: peers.length };
  }
  return { type: 'custom', key: 'all', size: universe.length - 1 };
}

function getPeers(self: InputBundle, universe: InputBundle[], mode: ScoringStrategy['peerSetMode']): InputBundle[] {
  if (mode === 'industry') {
    const key = self.profile.industry ?? self.profile.sector;
    return universe.filter(b => b.profile.symbol !== self.profile.symbol && (b.profile.industry ?? b.profile.sector) === key);
  }
  if (mode === 'sector') {
    return universe.filter(b => b.profile.symbol !== self.profile.symbol && b.profile.sector === self.profile.sector);
  }
  return universe.filter(b => b.profile.symbol !== self.profile.symbol);
}

export function computeFactor(category: FactorCategory, self: InputBundle, peers: InputBundle[]): FactorScore {
  switch (category) {
    case 'value':             return computeValue(self, peers);
    case 'growth':            return computeGrowth(self, peers).factor;
    case 'quality':           return computeQuality(self, peers);
    case 'profitability':     return computeProfitability(self, peers);
    case 'momentum':          return computeMomentum(self, peers);
    case 'low_volatility':    return computeLowVolatility(self, peers);
    case 'size':              return computeSize(self, peers);
    case 'yield':             return computeYield(self, peers);
    case 'sentiment':         return computeSentiment(self, peers);
    case 'insider':           return computeInsider(self, peers).factor;
    case 'institutional':     return computeInstitutional(self, peers).factor;
    case 'short_signal':      return computeShortSignal(self, peers).factor;
    case 'options_signal':    return computeOptionsSignal(self, peers);
    case 'analyst':           return computeAnalyst(self, peers);
    case 'earnings_quality':  return computeEarningsQuality(self, peers).factor;
    case 'capital_allocation':return computeCapitalAllocation(self, peers).factor;
    case 'macro_fit':         return computeMacroFit(self, peers);
    case 'alt_signals':       return computeAltSignals(self, peers);
  }
}

export function scoreSymbol(self: InputBundle, peers: InputBundle[], strategy: ScoringStrategy): SymbolScore {
  const peerSet = buildPeerSet(self.profile, [self.profile, ...peers.map(p => p.profile)], strategy.peerSetMode);

  const allFactorCategories: FactorCategory[] = [
    'value', 'growth', 'quality', 'profitability', 'momentum', 'low_volatility', 'size', 'yield',
    'sentiment', 'insider', 'institutional', 'short_signal', 'options_signal', 'analyst',
    'earnings_quality', 'capital_allocation', 'macro_fit', 'alt_signals',
  ];

  // Gather per-factor flags
  const growthResult  = computeGrowth(self, peers);
  const insiderResult = computeInsider(self, peers);
  const instResult    = computeInstitutional(self, peers);
  const shortResult   = computeShortSignal(self, peers);
  const eqResult      = computeEarningsQuality(self, peers);
  const capResult     = computeCapitalAllocation(self, peers);

  const factorFlags: Array<RedFlag | GreenFlag> = [
    ...growthResult.flags, ...insiderResult.flags, ...instResult.flags,
    ...shortResult.flags, ...eqResult.flags, ...capResult.flags,
  ];

  // Build factor map
  const factorMap: Record<string, FactorScore> = {};
  for (const cat of allFactorCategories) {
    switch (cat) {
      case 'growth':             factorMap[cat] = growthResult.factor; break;
      case 'insider':            factorMap[cat] = insiderResult.factor; break;
      case 'institutional':      factorMap[cat] = instResult.factor; break;
      case 'short_signal':       factorMap[cat] = shortResult.factor; break;
      case 'earnings_quality':   factorMap[cat] = eqResult.factor; break;
      case 'capital_allocation': factorMap[cat] = capResult.factor; break;
      default:                   factorMap[cat] = computeFactor(cat, self, peers);
    }
  }

  // Weighted composite
  let composite = 0, totalWeight = 0;
  for (const [cat, weight] of Object.entries(strategy.weights)) {
    if (!weight || weight <= 0) continue;
    const factor = factorMap[cat];
    if (!factor) continue;
    // momentum-with-quality-gate: quality z < -0.3 → veto
    if (strategy.id === 'momentum-with-quality-gate' && cat === 'momentum' && (factorMap['quality']?.zScore ?? 0) < -0.3) continue;
    composite += factor.score * weight;
    totalWeight += weight;
  }
  composite = totalWeight > 0 ? clip(composite / totalWeight, -1, 1) : 0;

  // Detect global flags
  const { redFlags: bundleRedFlags, greenFlags: bundleGreenFlags } = detectFlags(self);

  // Deduplicate flags
  const allRedFlags = deduplicateRedFlags([...bundleRedFlags, ...factorFlags.filter(isRedFlag)]);
  const allGreenFlags = deduplicateGreenFlags([...bundleGreenFlags, ...factorFlags.filter(isGreenFlag)]);

  // Veto check
  const vetoTriggered = strategy.vetoRedFlags?.some(code => allRedFlags.some(f => f.code === code));
  if (vetoTriggered) composite = -1;

  // Coverage + confidence
  const activeFactors = Object.keys(strategy.weights).filter(k => (strategy.weights as Record<string, number>)[k]! > 0);
  const avgCoverage   = activeFactors.reduce((s, k) => s + (factorMap[k]?.coverage ?? 0), 0) / Math.max(1, activeFactors.length);
  const peerPenalty   = peerSet.size < 5 ? 0.7 : peerSet.size < 10 ? 0.85 : 1.0;
  const confidence    = clip(avgCoverage * peerPenalty, 0, 1);

  return {
    symbol: self.profile.symbol,
    asOf: new Date().toISOString().slice(0, 10),
    peerSet,
    factors: factorMap as Record<FactorCategory, FactorScore>,
    composite,
    decile: 5, // set by scoreUniverse after ranking
    confidence,
    redFlags: allRedFlags,
    greenFlags: allGreenFlags,
  };
}

export function scoreUniverse(bundles: InputBundle[], strategy: ScoringStrategy): SymbolScore[] {
  const scores = bundles.map(b => {
    const peers = bundles.filter(p => p.profile.symbol !== b.profile.symbol);
    return scoreSymbol(b, peers, strategy);
  });

  // Sort descending by composite
  scores.sort((a, b) => b.composite - a.composite);

  // Assign deciles
  const n = scores.length;
  scores.forEach((s, i) => {
    s.decile = Math.ceil(((n - i) / n) * 10);
  });

  return scores;
}

export function explainScore(score: SymbolScore): string {
  const lines: string[] = [];
  lines.push(`# Equity Score — ${score.symbol}`);
  lines.push(`**Composite**: ${score.composite.toFixed(3)} | **Decile**: ${score.decile}/10 | **Confidence**: ${(score.confidence * 100).toFixed(0)}%`);
  lines.push(`**Peer Set**: ${score.peerSet.type} "${score.peerSet.key}" (n=${score.peerSet.size})`);
  lines.push('');

  // Top 3 positive factors
  const sorted = Object.entries(score.factors)
    .map(([cat, f]) => ({ cat, f }))
    .sort((a, b) => b.f.score - a.f.score);
  lines.push('## Top Positive Factors');
  for (const { cat, f } of sorted.slice(0, 3)) {
    lines.push(`- **${cat}**: score=${f.score.toFixed(3)}, z=${f.zScore.toFixed(2)}, coverage=${(f.coverage * 100).toFixed(0)}%`);
    if (f.notes.length > 0) lines.push(`  - ${f.notes.slice(0, 2).join('; ')}`);
  }
  lines.push('');
  lines.push('## Bottom Negative Factors');
  for (const { cat, f } of sorted.slice(-2)) {
    lines.push(`- **${cat}**: score=${f.score.toFixed(3)}, z=${f.zScore.toFixed(2)}, coverage=${(f.coverage * 100).toFixed(0)}%`);
  }
  lines.push('');

  if (score.greenFlags.length > 0) {
    lines.push('## Green Flags');
    for (const g of score.greenFlags) lines.push(`- ✅ **${g.code}**: ${g.evidence}`);
    lines.push('');
  }
  if (score.redFlags.length > 0) {
    lines.push('## Red Flags');
    for (const r of score.redFlags) lines.push(`- 🚩 [${r.severity.toUpperCase()}] **${r.code}**: ${r.evidence}`);
  }

  return lines.join('\n');
}

function isRedFlag(f: RedFlag | GreenFlag): f is RedFlag {
  return 'severity' in f;
}
function isGreenFlag(f: RedFlag | GreenFlag): f is GreenFlag {
  return !('severity' in f);
}
function deduplicateRedFlags(flags: RedFlag[]): RedFlag[] {
  const seen = new Map<string, RedFlag>();
  for (const f of flags) { if (!seen.has(f.code)) seen.set(f.code, f); }
  return [...seen.values()];
}
function deduplicateGreenFlags(flags: GreenFlag[]): GreenFlag[] {
  const seen = new Map<string, GreenFlag>();
  for (const f of flags) { if (!seen.has(f.code)) seen.set(f.code, f); }
  return [...seen.values()];
}
