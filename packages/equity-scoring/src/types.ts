/**
 * @weaveintel/equity-scoring — type definitions
 */

import type {
  CompanyProfile, Quote, OHLCVBar, Fundamentals, AnnualFinancials,
  QuarterlyFinancials, EarningsEvent, AnalystConsensus, DividendEvent,
  InsiderTransaction, InstitutionalHolding, ShortInterest, OptionsSummary, MacroSnapshot,
} from '@weaveintel/tools-marketdata';
import type { NewsArticle } from '@weaveintel/tools-news';
import type { TrendsDataPoint, EsgScores, SupplyChainExposure } from '@weaveintel/tools-altdata';

export type FactorCategory =
  | 'value' | 'growth' | 'quality' | 'profitability' | 'momentum'
  | 'low_volatility' | 'size' | 'yield' | 'sentiment'
  | 'insider' | 'institutional' | 'short_signal' | 'options_signal'
  | 'analyst' | 'earnings_quality' | 'capital_allocation' | 'macro_fit' | 'alt_signals';

export interface FactorScore {
  category: FactorCategory;
  zScore: number;       // raw cross-sectional z within peer set
  score: number;        // tanh-squashed to [-1, +1], sign-corrected (higher = more attractive)
  rawInputs: Record<string, number | null>;
  coverage: number;     // 0..1 — fraction of expected inputs present
  notes: string[];
}

export interface PeerSet {
  type: 'industry' | 'sector' | 'custom';
  key: string;
  size: number;
}

export interface SymbolScore {
  symbol: string;
  asOf: string;
  peerSet: PeerSet;
  factors: Record<FactorCategory, FactorScore>;
  composite: number;    // weighted sum of factor scores, [-1, +1]
  decile: number;       // 1..10 within peer set (10 = best)
  confidence: number;   // 0..1 — combines coverage + peer size
  redFlags: RedFlag[];
  greenFlags: GreenFlag[];
}

export interface ScoringStrategy {
  id: string;
  name: string;
  weights: Partial<Record<FactorCategory, number>>;
  peerSetMode: 'industry' | 'sector' | 'custom';
  regimeAdjust: boolean;
  minCoverage: number;
  vetoRedFlags?: string[];   // score returns -1 composite if any of these fire
}

export interface RedFlag {
  code: string;
  severity: 'low' | 'medium' | 'high';
  evidence: string;
}

export interface GreenFlag {
  code: string;
  evidence: string;
}

export interface InputBundle {
  profile: CompanyProfile;
  quote: Quote;
  ohlcv: OHLCVBar[];
  fundamentals: Fundamentals;
  annual: AnnualFinancials[];
  quarterly: QuarterlyFinancials[];
  earnings: EarningsEvent[];
  analyst: AnalystConsensus | null;
  dividends: DividendEvent[];
  insiders: InsiderTransaction[];
  institutions: InstitutionalHolding[];
  shortInterest: ShortInterest | null;
  options: OptionsSummary | null;
  news: NewsArticle[];
  altData?: {
    trends?: TrendsDataPoint[];
    esg?: EsgScores | null;
    supplyChain?: SupplyChainExposure | null;
  };
  macro: MacroSnapshot;
}
