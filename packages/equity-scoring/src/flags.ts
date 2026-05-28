/**
 * Boolean flag detection across the full InputBundle.
 * Runs AFTER factor computation so factor notes can also feed flag logic.
 */

import type { InputBundle, RedFlag, GreenFlag } from './types.js';

export function detectFlags(bundle: InputBundle): { redFlags: RedFlag[]; greenFlags: GreenFlag[] } {
  const redFlags: RedFlag[] = [];
  const greenFlags: GreenFlag[] = [];
  const f = bundle.fundamentals;
  const annual = bundle.annual;

  // ALTMAN_Z_DISTRESS — non-financial sector
  const nonFinancialSectors = ['Information Technology', 'Health Care', 'Energy', 'Materials', 'Industrials', 'Consumer Discretionary', 'Consumer Staples', 'Real Estate', 'Utilities'];
  const isNonFinancial = nonFinancialSectors.includes(bundle.profile.sector ?? '');
  if (isNonFinancial && f.altmanZScore !== null && f.altmanZScore < 1.8) {
    redFlags.push({ code: 'ALTMAN_Z_DISTRESS', severity: 'high', evidence: `Altman Z-Score ${f.altmanZScore.toFixed(2)} < 1.8 (distress zone)` });
  }

  // BENEISH_M_HIGH
  if (f.beneishMScore !== null && f.beneishMScore > -1.78) {
    redFlags.push({ code: 'BENEISH_M_HIGH', severity: 'high', evidence: `Beneish M-Score ${f.beneishMScore.toFixed(2)} > -1.78 (possible manipulation)` });
  }

  // NEGATIVE_CFO_POSITIVE_NI
  const lastYear = annual[0];
  if (lastYear && (lastYear.cfo ?? 1) < 0 && (lastYear.netIncome ?? -1) > 0) {
    redFlags.push({ code: 'NEGATIVE_CFO_POSITIVE_NI', severity: 'high', evidence: `CFO negative (${lastYear.cfo?.toLocaleString()}) while net income positive (${lastYear.netIncome?.toLocaleString()})` });
  }

  // GROWTH_VIA_DILUTION (5y)
  const shareFirst = annual[4]?.sharesDilutedAvg ?? null;
  const shareLast  = annual[0]?.sharesDilutedAvg ?? null;
  const revFirst   = annual[4]?.revenue ?? null;
  const revLast    = annual[0]?.revenue ?? null;
  if (shareFirst && shareLast && revFirst && revLast && shareFirst > 0 && revFirst > 0) {
    const shareGrowth = (shareLast / shareFirst) ** (1/4) - 1;
    const revGrowth   = (revLast  / revFirst)   ** (1/4) - 1;
    if (shareGrowth > revGrowth + 0.02) {
      redFlags.push({ code: 'GROWTH_VIA_DILUTION', severity: 'medium', evidence: `5y share CAGR ${(shareGrowth*100).toFixed(1)}% > revenue CAGR ${(revGrowth*100).toFixed(1)}%` });
    }
  }

  // CROWDED_TRADE
  const totalHeld = bundle.institutions.reduce((s, h) => s + h.shares, 0);
  const instPct   = (bundle.profile.sharesOutstanding ?? 0) > 0 ? totalHeld / bundle.profile.sharesOutstanding! : 0;
  if (instPct > 0.90) {
    redFlags.push({ code: 'CROWDED_TRADE', severity: 'medium', evidence: `${(instPct*100).toFixed(0)}% institutional ownership of float` });
  }

  // HIGH_SHORT_AND_WEAK_FUNDAMENTALS
  const shortPct = bundle.shortInterest?.shortPctFloat ?? 0;
  if (shortPct > 0.15 && (f.piotroskiFScore ?? 5) < 5) {
    redFlags.push({ code: 'HIGH_SHORT_AND_WEAK_FUNDAMENTALS', severity: 'medium', evidence: `Short ${(shortPct*100).toFixed(1)}% of float and Piotroski F-score ${f.piotroskiFScore}` });
  }

  // INSIDER_CLUSTER_SELL
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0,10);
  const clusterSellers = new Set(bundle.insiders.filter(t => t.transactionCode === 'S' && t.transactionDate >= thirtyDaysAgo).map(t => t.insiderName));
  if (clusterSellers.size >= 3) {
    redFlags.push({ code: 'INSIDER_CLUSTER_SELL', severity: 'medium', evidence: `${clusterSellers.size} distinct insiders sold in last 30d` });
  }

  // BUYBACK_AT_PEAK
  const prices52w = bundle.ohlcv.slice(-252).map(b => b.adjustedClose);
  const high52w   = prices52w.length > 0 ? Math.max(...prices52w) : bundle.quote.price;
  if ((lastYear?.buybacksDollar ?? 0) > 0 && bundle.quote.price > high52w * 0.95 && (f.buybackYield ?? 0) > 0.03) {
    redFlags.push({ code: 'BUYBACK_AT_PEAK', severity: 'low', evidence: `Buyback yield ${((f.buybackYield!)*100).toFixed(1)}% with price within 5% of 52w high` });
  }

  // ── Green flags ─────────────────────────────────────────────────────────────

  // INSIDER_CLUSTER_BUY
  const clusterBuyers = new Set(bundle.insiders.filter(t => t.transactionCode === 'P' && t.transactionDate >= thirtyDaysAgo).map(t => t.insiderName));
  if (clusterBuyers.size >= 3) {
    greenFlags.push({ code: 'INSIDER_CLUSTER_BUY', evidence: `${clusterBuyers.size} distinct insiders bought in last 30d` });
  }

  // POTENTIAL_SHORT_SQUEEZE
  if (shortPct > 0.15 && (f.piotroskiFScore ?? 0) >= 7) {
    greenFlags.push({ code: 'POTENTIAL_SHORT_SQUEEZE', evidence: `High short ${(shortPct*100).toFixed(1)}% + strong Piotroski F-score ${f.piotroskiFScore}` });
  }

  // COMPOUNDER
  const roics = annual.slice(0,5).map(a => a.roicReported).filter((v): v is number => v !== null);
  const allPosFcf = annual.slice(0,5).every(a => (a.fcf ?? -1) > 0);
  if (roics.length >= 5 && roics.every(r => r >= 0.15) && (f.debtToEquity ?? 999) < 1 && allPosFcf) {
    greenFlags.push({ code: 'COMPOUNDER', evidence: `5y ROIC consistently ≥ 15%, positive FCF every year, D/E < 1` });
  }

  // IMPROVING_QUALITY (ROIC and margin trend both positive)
  const roicSlopes = annual.slice(0,3).map(a => a.roicReported).filter((v): v is number => v !== null);
  if (roicSlopes.length >= 3 && roicSlopes[0]! > roicSlopes[roicSlopes.length - 1]!) {
    greenFlags.push({ code: 'IMPROVING_QUALITY', evidence: `ROIC improved from ${(roicSlopes[roicSlopes.length-1]!*100).toFixed(1)}% to ${(roicSlopes[0]!*100).toFixed(1)}% over 3y` });
  }

  // RERATING_CANDIDATE
  const revUp30d = bundle.analyst?.epsRevisions30d?.up ?? 0;
  const revDn30d = bundle.analyst?.epsRevisions30d?.down ?? 0;
  const revisionPositive = revUp30d > revDn30d;
  const valueZ = f.peRatio !== null && f.peRatio > 0 ? f.peRatio : 999;
  if (revisionPositive && valueZ < 25) {
    greenFlags.push({ code: 'RERATING_CANDIDATE', evidence: `Positive EPS revisions (${revUp30d} up vs ${revDn30d} down) and attractive valuation (P/E ${valueZ.toFixed(1)})` });
  }

  return { redFlags, greenFlags };
}
