/**
 * Remaining factors: low_volatility, size, yield, sentiment, insider,
 * institutional, short_signal, options_signal, analyst, earnings_quality,
 * capital_allocation, macro_fit, alt_signals.
 */

import type { InputBundle, FactorScore, RedFlag, GreenFlag } from '../types.js';
import { crossSectionalZ, squash, clip, annualizedVol, maxDrawdown, slope } from '../math.js';

// ── Low volatility (INVERTED) ────────────────────────────────────────────────

export function computeLowVolatility(self: InputBundle, peers: InputBundle[]): FactorScore {
  const prices = [...self.ohlcv].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-252).map(b => b.adjustedClose);
  const selfVol = annualizedVol(prices);
  const selfDD  = maxDrawdown(prices);
  const peerVols = peers.map(p => { const pp = [...p.ohlcv].sort((a,b) => a.ts.localeCompare(b.ts)).slice(-252).map(b => b.adjustedClose); return annualizedVol(pp); });
  const peerDDs  = peers.map(p => { const pp = [...p.ohlcv].sort((a,b) => a.ts.localeCompare(b.ts)).slice(-252).map(b => b.adjustedClose); return maxDrawdown(pp); });

  const { z: zVol } = crossSectionalZ(-selfVol, peerVols.map(v => -v));  // invert: lower vol = higher score
  const { z: zDD  } = crossSectionalZ(-selfDD,  peerDDs.map(v => -v));

  const avgZ = (zVol + zDD) / 2;
  return { category: 'low_volatility', zScore: clip(avgZ,-3,3), score: squash(avgZ), rawInputs: { vol252: selfVol, maxDrawdown: selfDD }, coverage: prices.length > 50 ? 1 : 0.5, notes: [] };
}

// ── Size (INVERTED log market cap) ───────────────────────────────────────────

export function computeSize(self: InputBundle, peers: InputBundle[]): FactorScore {
  const selfMc  = self.fundamentals.marketCap;
  const peerMcs = peers.map(p => p.fundamentals.marketCap);
  const { z } = crossSectionalZ(selfMc !== null ? -Math.log(selfMc) : null, peerMcs.map(v => v !== null ? -Math.log(v) : null));
  const coverage = selfMc !== null ? 1 : 0;
  return { category: 'size', zScore: clip(z,-3,3), score: squash(z), rawInputs: { marketCap: selfMc }, coverage, notes: [] };
}

// ── Yield ────────────────────────────────────────────────────────────────────

export function computeYield(self: InputBundle, peers: InputBundle[]): FactorScore {
  const f = self.fundamentals;
  const rawYield = f.shareholderYield ?? ((f.dividendYield ?? 0) + (f.buybackYield ?? 0));
  // Penalize payout ratio > 0.9
  const effectiveYield = rawYield * (f.payoutRatio !== null && f.payoutRatio > 0.9 ? 0.5 : 1);
  const peerYields = peers.map(p => {
    const pf = p.fundamentals;
    const py = pf.shareholderYield ?? ((pf.dividendYield ?? 0) + (pf.buybackYield ?? 0));
    return py * (pf.payoutRatio !== null && pf.payoutRatio > 0.9 ? 0.5 : 1);
  });
  const { z } = crossSectionalZ(effectiveYield, peerYields);
  const coverage = rawYield !== 0 ? 1 : 0;
  return { category: 'yield', zScore: clip(z,-3,3), score: squash(z), rawInputs: { rawYield, effectiveYield, payoutRatio: f.payoutRatio }, coverage, notes: [] };
}

// ── Sentiment (news-based) ───────────────────────────────────────────────────

const POSITIVE_WORDS = ['beat', 'record', 'surge', 'strong', 'growth', 'raised', 'profit', 'wins', 'expands', 'upgrade', 'buy'];
const NEGATIVE_WORDS = ['miss', 'loss', 'cut', 'decline', 'warn', 'fail', 'concern', 'probe', 'downgrade', 'sell', 'fraud'];

function keywordSentiment(text: string): number {
  const t = text.toLowerCase();
  const pos = POSITIVE_WORDS.filter(w => t.includes(w)).length;
  const neg = NEGATIVE_WORDS.filter(w => t.includes(w)).length;
  return clip((pos - neg) * 0.2, -1, 1);
}

export function computeSentiment(self: InputBundle, peers: InputBundle[]): FactorScore {
  const now = Date.now();
  const halfLifeDays = 7;
  const news = self.news;

  let weightedScore = 0, totalWeight = 0;
  const usingFallback = news.every(a => a.sentimentScore === null);
  const notes: string[] = [];
  if (usingFallback) notes.push('sentimentScore null — using keyword fallback classifier');

  for (const a of news) {
    const ageMs = now - new Date(a.publishedAt).getTime();
    const ageDays = ageMs / 86_400_000;
    const decayWeight = Math.exp(-ageDays * Math.log(2) / halfLifeDays);
    const relWeight = (a.relevanceScore ?? 0.5);
    const w = decayWeight * relWeight;
    const score = usingFallback ? keywordSentiment(a.title + ' ' + (a.summary ?? '')) : (a.sentimentScore ?? 0);
    weightedScore += score * w;
    totalWeight += w;
  }

  const selfSentiment = totalWeight > 0 ? weightedScore / totalWeight : 0;
  const peerSentiments = peers.map(p => {
    let ws = 0, tw = 0;
    for (const a of p.news) {
      const ageDays = (now - new Date(a.publishedAt).getTime()) / 86_400_000;
      const w = Math.exp(-ageDays * Math.log(2) / halfLifeDays) * (a.relevanceScore ?? 0.5);
      ws += (a.sentimentScore ?? keywordSentiment(a.title)) * w;
      tw += w;
    }
    return tw > 0 ? ws / tw : 0;
  });

  const { z } = crossSectionalZ(selfSentiment, peerSentiments);
  const coverage = news.length > 0 ? 1 : 0;

  return { category: 'sentiment', zScore: clip(z,-3,3), score: squash(z), rawInputs: { weightedSentiment: selfSentiment, articleCount: news.length }, coverage, notes };
}

// ── Insider ──────────────────────────────────────────────────────────────────

export function computeInsider(self: InputBundle, peers: InputBundle[]): { factor: FactorScore; flags: Array<RedFlag | GreenFlag> } {
  const flags: Array<RedFlag | GreenFlag> = [];
  const mc = self.fundamentals.marketCap ?? 1;
  const txns = self.insiders;

  let netValueUsd = 0;
  const buys = txns.filter(t => t.transactionCode === 'P');
  const sells = txns.filter(t => t.transactionCode === 'S');
  for (const b of buys) netValueUsd += b.valueUsd ?? 0;
  for (const s of sells) netValueUsd -= s.valueUsd ?? 0;
  const normalizedNet = netValueUsd / mc;

  // Cluster checks
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0,10);
  const clusterBuyers  = new Set(buys.filter(b => b.transactionDate >= thirtyDaysAgo).map(b => b.insiderName));
  const clusterSellers = new Set(sells.filter(s => s.transactionDate >= thirtyDaysAgo).map(s => s.insiderName));

  if (clusterBuyers.size >= 3) {
    flags.push({ code: 'INSIDER_CLUSTER_BUY', evidence: `${clusterBuyers.size} distinct insiders bought in last 30d` } as GreenFlag);
  }
  if (clusterSellers.size >= 3) {
    flags.push({ code: 'INSIDER_CLUSTER_SELL', severity: 'medium', evidence: `${clusterSellers.size} distinct insiders sold in last 30d` } as RedFlag);
  }

  const peerNets = peers.map(p => {
    const pmc = p.fundamentals.marketCap ?? 1;
    let net = 0;
    for (const b of p.insiders.filter(t => t.transactionCode === 'P')) net += b.valueUsd ?? 0;
    for (const s of p.insiders.filter(t => t.transactionCode === 'S')) net -= s.valueUsd ?? 0;
    return net / pmc;
  });

  let { z } = crossSectionalZ(normalizedNet, peerNets);
  if (clusterBuyers.size >= 3) z = clip(z + 0.3, -3, 3);
  if (clusterSellers.size >= 3) z = clip(z - 0.3, -3, 3);

  const coverage = txns.length > 0 ? 1 : 0;
  return {
    factor: { category: 'insider', zScore: clip(z,-3,3), score: squash(z), rawInputs: { netValueUsd, normalizedNet, buyCount: buys.length, sellCount: sells.length }, coverage, notes: [] },
    flags,
  };
}

// ── Institutional ────────────────────────────────────────────────────────────

export function computeInstitutional(self: InputBundle, peers: InputBundle[]): { factor: FactorScore; flags: Array<RedFlag | GreenFlag> } {
  const flags: Array<RedFlag | GreenFlag> = [];
  const shares = self.profile.sharesOutstanding ?? 1e9;
  const holdings = self.institutions;

  const totalHeld = holdings.reduce((s, h) => s + h.shares, 0);
  const instPct = totalHeld / shares;
  const netChangeQoq = holdings.reduce((s, h) => s + (h.shareChangeQoq ?? 0), 0);
  const netChangePct = netChangeQoq / shares;

  // Hedge fund sub-signal (weight 2×)
  const hfChangeQoq = holdings.filter(h => h.filerType === 'hedge_fund').reduce((s, h) => s + (h.shareChangeQoq ?? 0), 0);
  const blendedChange = (netChangePct + 2 * (hfChangeQoq / shares)) / 3;

  if (instPct > 0.9) {
    flags.push({ code: 'CROWDED_TRADE', severity: 'medium', evidence: `Institutional ownership ${(instPct * 100).toFixed(0)}% of shares outstanding` } as RedFlag);
  }

  const peerBlended = peers.map(p => {
    const ps = p.profile.sharesOutstanding ?? 1e9;
    const pnc = p.institutions.reduce((s, h) => s + (h.shareChangeQoq ?? 0), 0) / ps;
    const phf = p.institutions.filter(h => h.filerType === 'hedge_fund').reduce((s, h) => s + (h.shareChangeQoq ?? 0), 0) / ps;
    return (pnc + 2 * phf) / 3;
  });

  const { z } = crossSectionalZ(blendedChange, peerBlended);
  const coverage = holdings.length > 0 ? 1 : 0;

  return {
    factor: { category: 'institutional', zScore: clip(z,-3,3), score: squash(z), rawInputs: { instPct, netChangePct, hfChangeQoq }, coverage, notes: [] },
    flags,
  };
}

// ── Short signal (INVERTED) ──────────────────────────────────────────────────

export function computeShortSignal(self: InputBundle, peers: InputBundle[]): { factor: FactorScore; flags: Array<RedFlag | GreenFlag> } {
  const flags: Array<RedFlag | GreenFlag> = [];
  const si = self.shortInterest;
  const selfShortPct = si?.shortPctFloat ?? null;

  const peerShortPcts = peers.map(p => p.shortInterest?.shortPctFloat ?? null);
  const { z } = crossSectionalZ(selfShortPct !== null ? -selfShortPct : null, peerShortPcts.map(v => v !== null ? -v : null));

  // Short squeeze candidate: high short + improving fundamentals + positive momentum
  const qualZ = 0; // populated by caller if needed
  if (selfShortPct !== null && selfShortPct > 0.15) {
    const highShortF = self.fundamentals;
    if (highShortF.piotroskiFScore !== null && highShortF.piotroskiFScore >= 7) {
      flags.push({ code: 'POTENTIAL_SHORT_SQUEEZE', evidence: `Short ${(selfShortPct*100).toFixed(1)}% with strong Piotroski F-score ${highShortF.piotroskiFScore}` } as GreenFlag);
    } else {
      flags.push({ code: 'HIGH_SHORT_AND_WEAK_FUNDAMENTALS', severity: 'medium', evidence: `Short ${(selfShortPct*100).toFixed(1)}% of float` } as RedFlag);
    }
  }

  const coverage = si !== null ? 1 : 0;
  return {
    factor: { category: 'short_signal', zScore: clip(z,-3,3), score: squash(z), rawInputs: { shortPctFloat: selfShortPct, daysToCover: si?.daysToCover ?? null }, coverage, notes: [] },
    flags,
  };
}

// ── Options signal (INVERTED) ─────────────────────────────────────────────────

export function computeOptionsSignal(self: InputBundle, peers: InputBundle[]): FactorScore {
  const opt = self.options;
  if (!opt) return { category: 'options_signal', zScore: 0, score: 0, rawInputs: {}, coverage: 0, notes: ['No options data'] };

  const peerOpts = peers.map(p => p.options);
  const { z: zPC  } = crossSectionalZ(opt.putCallRatioOI !== null ? -opt.putCallRatioOI : null,    peerOpts.map(o => o?.putCallRatioOI !== null && o?.putCallRatioOI !== undefined ? -o.putCallRatioOI : null));
  const { z: zIVR } = crossSectionalZ(opt.ivRank !== null ? -opt.ivRank : null,          peerOpts.map(o => o?.ivRank !== null && o?.ivRank !== undefined ? -o.ivRank : null));
  const { z: zSkew} = crossSectionalZ(opt.skew25Delta !== null ? -opt.skew25Delta : null, peerOpts.map(o => o?.skew25Delta !== null && o?.skew25Delta !== undefined ? -o.skew25Delta : null));

  const avgZ = (zPC + zIVR + zSkew) / 3;
  const coverage = [opt.putCallRatioOI, opt.ivRank, opt.skew25Delta].filter(v => v !== null).length / 3;

  return { category: 'options_signal', zScore: clip(avgZ,-3,3), score: squash(avgZ), rawInputs: { putCallRatioOI: opt.putCallRatioOI, ivRank: opt.ivRank, skew25Delta: opt.skew25Delta }, coverage, notes: [] };
}

// ── Analyst ──────────────────────────────────────────────────────────────────

export function computeAnalyst(self: InputBundle, peers: InputBundle[]): FactorScore {
  const cons = self.analyst;
  const notes: string[] = [];
  if (!cons) return { category: 'analyst', zScore: 0, score: 0, rawInputs: {}, coverage: 0, notes: ['No analyst consensus'] };

  const total = cons.buyCount + cons.holdCount + cons.sellCount;
  const buyRatio = total > 0 ? cons.buyCount / total : null;
  const revScore30d = cons.epsRevisions30d ? (cons.epsRevisions30d.up - cons.epsRevisions30d.down) / Math.max(1, cons.epsRevisions30d.up + cons.epsRevisions30d.down) : null;
  const price = self.quote.price;
  const impliedUpside = cons.meanTargetPrice !== null ? clip((cons.meanTargetPrice - price) / price, -0.5, 1.0) : null;

  const peerBuyRatios = peers.map(p => { const pc = p.analyst; if (!pc) return null; const t = pc.buyCount + pc.holdCount + pc.sellCount; return t > 0 ? pc.buyCount / t : null; });
  const peerRevScores = peers.map(p => { const pr = p.analyst?.epsRevisions30d; return pr ? (pr.up - pr.down) / Math.max(1, pr.up + pr.down) : null; });
  const peerUpsides   = peers.map(p => { const pp = p.analyst; return pp?.meanTargetPrice !== null && pp?.meanTargetPrice !== undefined ? clip((pp.meanTargetPrice - p.quote.price) / p.quote.price, -0.5, 1.0) : null; });

  const { z: z1 } = crossSectionalZ(buyRatio, peerBuyRatios);
  const { z: z2 } = crossSectionalZ(revScore30d, peerRevScores);
  const { z: z3 } = crossSectionalZ(impliedUpside, peerUpsides);
  const avgZ = (z1 + z2 + z3) / 3;
  const coverage = [buyRatio, revScore30d, impliedUpside].filter(v => v !== null).length / 3;

  return { category: 'analyst', zScore: clip(avgZ,-3,3), score: squash(avgZ), rawInputs: { buyRatio, revScore30d, impliedUpside }, coverage, notes };
}

// ── Earnings quality ─────────────────────────────────────────────────────────

export function computeEarningsQuality(self: InputBundle, peers: InputBundle[]): { factor: FactorScore; flags: Array<RedFlag | GreenFlag> } {
  const flags: Array<RedFlag | GreenFlag> = [];
  const f = self.fundamentals;
  const notes: string[] = [];

  // Accruals ratio (lower = better → invert)
  const { z: z1 } = crossSectionalZ(f.accrualsRatio !== null ? -f.accrualsRatio : null, peers.map(p => p.fundamentals.accrualsRatio !== null ? -p.fundamentals.accrualsRatio! : null));
  // CFO/NI (higher = better)
  const { z: z2 } = crossSectionalZ(f.cfoToNetIncome, peers.map(p => p.fundamentals.cfoToNetIncome));
  // Beneish M-score (lower/more negative = better → invert)
  const { z: z3 } = crossSectionalZ(f.beneishMScore !== null ? -f.beneishMScore : null, peers.map(p => p.fundamentals.beneishMScore !== null ? -p.fundamentals.beneishMScore! : null));
  // EPS surprise beat rate over last 8 quarters
  const earnings = self.earnings.slice(0,8);
  const beatRate = earnings.length > 0 ? earnings.filter(e => (e.surprisePct ?? 0) > 0).length / earnings.length : null;
  const peerBeatRates = peers.map(p => { const pe = p.earnings.slice(0,8); return pe.length > 0 ? pe.filter(e => (e.surprisePct ?? 0) > 0).length / pe.length : null; });
  const { z: z4 } = crossSectionalZ(beatRate, peerBeatRates);

  if (f.beneishMScore !== null && f.beneishMScore > -1.78) {
    flags.push({ code: 'BENEISH_M_HIGH', severity: 'high', evidence: `Beneish M-score ${f.beneishMScore.toFixed(2)} > -1.78 (manipulation risk)` } as RedFlag);
  }

  // EARNINGS_QUALITY_DETERIORATING: accruals worsened YoY AND CFO < 0.7 × NI
  const prevAccruals = self.annual[1] && self.annual[0] ? (((self.annual[0].netIncome ?? 0) - (self.annual[0].cfo ?? 0)) / (self.annual[0].totalAssets ?? 1)) : null;
  const curAccruals  = f.accrualsRatio;
  if (curAccruals !== null && prevAccruals !== null && curAccruals > prevAccruals && f.cfoToNetIncome !== null && f.cfoToNetIncome < 0.7) {
    flags.push({ code: 'EARNINGS_QUALITY_DETERIORATING', severity: 'high', evidence: `Accruals ratio worsened YoY (${prevAccruals.toFixed(3)} → ${curAccruals.toFixed(3)}) and CFO/NI ${f.cfoToNetIncome.toFixed(2)} < 0.7` } as RedFlag);
    notes.push('Earnings quality deteriorating');
  }

  const ann = self.annual[0];
  if (ann && (ann.cfo ?? 0) < 0 && (ann.netIncome ?? 0) > 0) {
    flags.push({ code: 'NEGATIVE_CFO_POSITIVE_NI', severity: 'high', evidence: `CFO ${(ann.cfo ?? 0).toLocaleString()} < 0 while net income > 0` } as RedFlag);
  }

  const avgZ = (z1 + z2 + z3 + z4) / 4;
  const coverage = [f.accrualsRatio, f.cfoToNetIncome, f.beneishMScore, beatRate].filter(v => v !== null).length / 4;

  return {
    factor: { category: 'earnings_quality', zScore: clip(avgZ,-3,3), score: squash(avgZ), rawInputs: { accrualsRatio: f.accrualsRatio, cfoToNetIncome: f.cfoToNetIncome, beneishMScore: f.beneishMScore, beatRate }, coverage, notes },
    flags,
  };
}

// ── Capital allocation ────────────────────────────────────────────────────────

export function computeCapitalAllocation(self: InputBundle, peers: InputBundle[]): { factor: FactorScore; flags: Array<RedFlag | GreenFlag> } {
  const flags: Array<RedFlag | GreenFlag> = [];
  const annual = self.annual;
  const f = self.fundamentals;

  // ROIC trend (slope over 5y)
  const roicHistory = annual.slice(0,5).map(a => a.roicReported).filter((v): v is number => v !== null);
  const roicSlope_5y = slope(roicHistory.reverse());
  const peerRoicSlopes = peers.map(p => slope(p.annual.slice(0,5).map(a => a.roicReported).filter((v): v is number => v !== null).reverse()));
  const { z: z1 } = crossSectionalZ(roicSlope_5y, peerRoicSlopes);

  // BUYBACK_AT_PEAK: last year buybacks > 0, price near 52w high, buybackYield > 3%
  const prices52w = self.ohlcv.slice(-252).map(b => b.adjustedClose);
  const high52w   = prices52w.length > 0 ? Math.max(...prices52w) : self.quote.price;
  const nearHigh  = self.quote.price > high52w * 0.95;
  const lastBuyback = annual[0]?.buybacksDollar ?? 0;
  if ((lastBuyback ?? 0) > 0 && nearHigh && (f.buybackYield ?? 0) > 0.03) {
    flags.push({ code: 'BUYBACK_AT_PEAK', severity: 'low', evidence: `Buyback at ${(f.buybackYield! * 100).toFixed(1)}% yield while price is within 5% of 52w high` } as RedFlag);
  }

  // COMPOUNDER green flag
  const roics = annual.slice(0,5).map(a => a.roicReported).filter((v): v is number => v !== null);
  const allPositiveFCF = annual.slice(0,5).every(a => (a.fcf ?? -1) > 0);
  if (roics.length >= 5 && roics.every(r => r >= 0.15) && roicSlope_5y >= 0 && (f.debtToEquity ?? 999) < 1 && allPositiveFCF) {
    flags.push({ code: 'COMPOUNDER', evidence: `5y ROIC ≥ 15% (min ${(Math.min(...roics)*100).toFixed(1)}%), positive FCF every year, low debt` } as GreenFlag);
  }

  // IMPROVING_QUALITY
  if (roicSlope_5y > 0 && roicHistory.length >= 3) {
    flags.push({ code: 'IMPROVING_QUALITY', evidence: `ROIC trend positive over 5y (slope ${roicSlope_5y.toFixed(4)})` } as GreenFlag);
  }

  const avgZ = z1;
  const coverage = roicHistory.length >= 3 ? 1 : roicHistory.length / 5;

  return {
    factor: { category: 'capital_allocation', zScore: clip(avgZ,-3,3), score: squash(avgZ), rawInputs: { roicSlope_5y, buybackAtPeak: nearHigh ? 1 : 0, lastBuybackDollar: lastBuyback }, coverage, notes: [] },
    flags,
  };
}

// ── Macro fit ─────────────────────────────────────────────────────────────────

type Regime = 'rising_rates' | 'falling_rates' | 'stagflation' | 'goldilocks' | 'recession';

function classifyRegime(macro: InputBundle['macro']): Regime {
  const rate = macro.policyRate ?? 3;
  const cpi  = macro.cpiYoy ?? 0.03;
  const gdp  = macro.gdpGrowthYoy ?? 0.02;
  const vix  = macro.vix ?? 20;

  if (gdp < 0 || vix > 35) return 'recession';
  if (cpi > 0.05) return 'stagflation';
  if (rate > 4 && gdp > 0.02) return 'rising_rates';
  if (rate < 3 && gdp > 0.025) return 'goldilocks';
  return 'falling_rates';
}

const REGIME_AFFINITY: Record<string, Partial<Record<Regime, number>>> = {
  'Information Technology': { goldilocks: 1, falling_rates: 0.5, rising_rates: -0.3 },
  'Communication Services': { goldilocks: 0.8, falling_rates: 0.3, rising_rates: -0.2 },
  'Health Care':            { recession: 0.8, stagflation: 0.5, goldilocks: 0.3 },
  'Consumer Staples':       { recession: 0.9, stagflation: 0.6, goldilocks: 0.0 },
  'Energy':                 { stagflation: 0.9, rising_rates: 0.5, recession: -0.4 },
  'Financials':             { rising_rates: 0.8, goldilocks: 0.5, recession: -0.8 },
  'Utilities':              { falling_rates: 0.8, recession: 0.4, rising_rates: -0.6 },
  'Real Estate':            { falling_rates: 0.9, rising_rates: -0.9 },
  'Industrials':            { goldilocks: 0.7, recession: -0.5 },
  'Materials':              { stagflation: 0.6, goldilocks: 0.3 },
  'Consumer Discretionary': { goldilocks: 0.8, recession: -0.7 },
};

export function computeMacroFit(self: InputBundle, peers: InputBundle[]): FactorScore {
  const regime = classifyRegime(self.macro);
  const sector = self.profile.sector ?? 'Other';
  const affinity = REGIME_AFFINITY[sector]?.[regime] ?? 0;
  const peerAffinities = peers.map(p => REGIME_AFFINITY[p.profile.sector ?? 'Other']?.[regime] ?? 0);
  const { z } = crossSectionalZ(affinity, peerAffinities);

  return { category: 'macro_fit', zScore: clip(z,-3,3), score: squash(z), rawInputs: { regime: regime as unknown as number, affinity }, coverage: 1, notes: [`Regime: ${regime}, sector affinity: ${affinity}`] };
}

// ── Alt signals ───────────────────────────────────────────────────────────────

export function computeAltSignals(self: InputBundle, peers: InputBundle[]): FactorScore {
  const notes: string[] = [];
  const rawInputs: Record<string, number | null> = {};

  // Trends: 4-week slope
  const trends = self.altData?.trends;
  const esg = self.altData?.esg;

  if (!trends && !esg) {
    notes.push('alt-data unavailable — weight this factor at 0');
    return { category: 'alt_signals', zScore: 0, score: 0, rawInputs, coverage: 0, notes };
  }

  let totalZ = 0, count = 0;

  if (trends && trends.length >= 4) {
    const recentSlope = slope(trends.slice(-4).map(t => t.index));
    const peerSlopes = peers.map(p => {
      const pt = p.altData?.trends;
      return pt && pt.length >= 4 ? slope(pt.slice(-4).map(t => t.index)) : null;
    });
    const { z } = crossSectionalZ(recentSlope, peerSlopes);
    totalZ += z; count++;
    rawInputs['trendsSlope4w'] = recentSlope;
  }

  if (esg) {
    const esgScore = esg.composite ?? null;
    const peerEsgs = peers.map(p => p.altData?.esg?.composite ?? null);
    const { z } = crossSectionalZ(esgScore, peerEsgs);
    totalZ += z; count++;
    rawInputs['esgComposite'] = esgScore;
    notes.push('ESG treated as neutral by default — opt-in via strategy weights');
  }

  const avgZ = count > 0 ? totalZ / count : 0;
  return { category: 'alt_signals', zScore: clip(avgZ,-3,3), score: squash(avgZ), rawInputs, coverage: count > 0 ? 1 : 0, notes };
}
