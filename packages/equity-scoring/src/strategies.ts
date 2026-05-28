/**
 * Prebuilt ScoringStrategy profiles.
 * Weights are illustrative starting points — users can override via API.
 */

import type { ScoringStrategy } from './types.js';

export const strategies: Record<string, ScoringStrategy> = {
  'classic-graham-value': {
    id: 'classic-graham-value',
    name: 'Classic Graham Value',
    weights: { value: 0.45, quality: 0.25, yield: 0.15, low_volatility: 0.10, earnings_quality: 0.05 },
    peerSetMode: 'industry',
    regimeAdjust: false,
    minCoverage: 0.4,
    vetoRedFlags: ['ALTMAN_Z_DISTRESS', 'BENEISH_M_HIGH'],
  },
  'compounder-quality': {
    id: 'compounder-quality',
    name: 'Compounder Quality',
    weights: { quality: 0.35, profitability: 0.20, growth: 0.15, capital_allocation: 0.15, momentum: 0.10, earnings_quality: 0.05 },
    peerSetMode: 'industry',
    regimeAdjust: false,
    minCoverage: 0.5,
    vetoRedFlags: ['ALTMAN_Z_DISTRESS', 'NEGATIVE_CFO_POSITIVE_NI'],
  },
  'aqr-multifactor': {
    id: 'aqr-multifactor',
    name: 'AQR Multifactor',
    weights: { value: 0.25, momentum: 0.25, quality: 0.25, low_volatility: 0.15, size: 0.10 },
    peerSetMode: 'sector',
    regimeAdjust: false,
    minCoverage: 0.5,
  },
  'gentlemans-growth': {
    id: 'gentlemans-growth',
    name: "Gentleman's Growth",
    weights: { growth: 0.35, quality: 0.25, momentum: 0.20, analyst: 0.10, sentiment: 0.10 },
    peerSetMode: 'industry',
    regimeAdjust: false,
    minCoverage: 0.4,
    vetoRedFlags: ['ALTMAN_Z_DISTRESS'],
  },
  'contrarian-deep-value': {
    id: 'contrarian-deep-value',
    name: 'Contrarian Deep Value',
    weights: { value: 0.50, earnings_quality: 0.20, insider: 0.15, short_signal: 0.10, capital_allocation: 0.05 },
    peerSetMode: 'sector',
    regimeAdjust: false,
    minCoverage: 0.35,
    vetoRedFlags: ['BENEISH_M_HIGH', 'NEGATIVE_CFO_POSITIVE_NI'],
  },
  'momentum-with-quality-gate': {
    id: 'momentum-with-quality-gate',
    name: 'Momentum with Quality Gate',
    weights: { momentum: 0.50, quality: 0.30, sentiment: 0.10, analyst: 0.10 },
    peerSetMode: 'sector',
    regimeAdjust: false,
    minCoverage: 0.4,
    // quality z < -0.3 acts as a soft veto in scorer
    vetoRedFlags: ['ALTMAN_Z_DISTRESS'],
  },
};
