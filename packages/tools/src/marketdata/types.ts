/**
 * @weaveintel/tools-marketdata — normalized, provider-agnostic data shapes.
 * All fields are camelCase. Adapters set unsupported fields to null; the
 * equity-scoring engine handles partial data via coverage-aware imputation.
 */

export type FiscalConvention = 'US_GAAP' | 'IND_AS' | 'IFRS' | 'OTHER';
export type Exchange = 'NASDAQ' | 'NYSE' | 'AMEX' | 'NSE' | 'BSE' | 'LSE' | 'TSE' | 'HKEX' | 'ASX' | 'TSX' | 'OTHER';

export interface SymbolSearchResult {
  symbol: string;
  name: string;
  exchange: Exchange;
  type: string | null;
  currency: string | null;
}

export interface CompanyProfile {
  symbol: string;
  name: string;
  exchange: Exchange;
  sector: string | null;
  industry: string | null;
  country: string;
  currency: string;
  ipoDate: string | null;
  sharesOutstanding: number | null;
  description: string | null;
  website: string | null;
  fiscalYearEnd: string | null;
}

export interface Quote {
  symbol: string;
  price: number;
  currency: string;
  ts: string;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
}

export interface OHLCVBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjustedClose: number;
  volume: number;
}

export interface Fundamentals {
  symbol: string;
  asOf: string;
  fiscalConvention: FiscalConvention;
  currency: string;
  marketCap: number | null;
  enterpriseValue: number | null;
  peRatio: number | null;
  forwardPE: number | null;
  pegRatio: number | null;
  pbRatio: number | null;
  psRatio: number | null;
  evToEbitda: number | null;
  evToSales: number | null;
  fcfYield: number | null;
  earningsYield: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  roe: number | null;
  roa: number | null;
  roic: number | null;
  grossProfitToAssets: number | null;
  epsTtm: number | null;
  dilutedEps: number | null;
  bookValuePerShare: number | null;
  fcfPerShare: number | null;
  dividendYield: number | null;
  payoutRatio: number | null;
  buybackYield: number | null;
  shareholderYield: number | null;
  debtToEquity: number | null;
  netDebtToEbitda: number | null;
  currentRatio: number | null;
  quickRatio: number | null;
  interestCoverage: number | null;
  altmanZScore: number | null;
  piotroskiFScore: number | null;
  beneishMScore: number | null;
  revenueGrowthYoy: number | null;
  epsGrowthYoy: number | null;
  fcfGrowthYoy: number | null;
  accrualsRatio: number | null;
  cfoToNetIncome: number | null;
}

export interface AnnualFinancials {
  fiscalYear: number;
  periodEnd: string;
  currency: string;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  ebitda: number | null;
  eps: number | null;
  cfo: number | null;
  capex: number | null;
  fcf: number | null;
  totalAssets: number | null;
  totalEquity: number | null;
  totalDebt: number | null;
  sharesDilutedAvg: number | null;
  dividendsPaid: number | null;
  buybacksDollar: number | null;
  roeReported: number | null;
  roicReported: number | null;
}

export interface QuarterlyFinancials extends AnnualFinancials {
  fiscalQuarter: 1 | 2 | 3 | 4;
}

export interface EarningsEvent {
  fiscalPeriod: string;
  reportDate: string;
  epsEstimate: number | null;
  epsActual: number | null;
  surprisePct: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  revenueSurprisePct: number | null;
  guidanceTone: 'raised' | 'maintained' | 'lowered' | 'none' | null;
}

export interface AnalystConsensus {
  symbol: string;
  asOf: string;
  buyCount: number;
  holdCount: number;
  sellCount: number;
  meanTargetPrice: number | null;
  medianTargetPrice: number | null;
  epsRevisions30d: { up: number; down: number } | null;
  epsRevisions90d: { up: number; down: number } | null;
  consensusEps1y: number | null;
  consensusEps2y: number | null;
  consensusRevenue1y: number | null;
  longTermGrowthEstimate: number | null;
}

export interface DividendEvent {
  exDate: string;
  payDate: string | null;
  amount: number;
  currency: string;
}

export interface SplitEvent {
  exDate: string;
  numerator: number;
  denominator: number;
}

export interface SECFilingRef {
  formType: string;
  filedDate: string;
  periodOfReport: string | null;
  accessionNumber: string;
  url: string;
}

export interface InsiderTransaction {
  symbol: string;
  insiderName: string;
  insiderTitle: string | null;
  transactionDate: string;
  transactionCode: 'P' | 'S' | 'A' | 'D' | 'M' | 'F' | 'G' | 'OTHER';
  shares: number;
  pricePerShare: number | null;
  valueUsd: number | null;
  sharesOwnedAfter: number | null;
}

export interface InstitutionalHolding {
  symbol: string;
  filer: string;
  filerType: 'hedge_fund' | 'mutual_fund' | 'pension' | 'sovereign' | 'other';
  asOf: string;
  shares: number;
  marketValue: number;
  shareChangeQoq: number | null;
  shareChangePctQoq: number | null;
}

export interface ShortInterest {
  symbol: string;
  asOf: string;
  shortShares: number;
  shortPctFloat: number | null;
  daysToCover: number | null;
  costToBorrow: number | null;
}

export interface OptionsSummary {
  symbol: string;
  asOf: string;
  putCallRatioOI: number | null;
  putCallRatioVolume: number | null;
  impliedVolatility30d: number | null;
  ivRank: number | null;
  skew25Delta: number | null;
  totalOpenInterest: number | null;
}

export interface MacroSnapshot {
  asOf: string;
  region: 'US' | 'IN' | 'EU' | 'UK' | 'GLOBAL';
  policyRate: number | null;
  cpiYoy: number | null;
  gdpGrowthYoy: number | null;
  unemploymentRate: number | null;
  yieldCurve10y2y: number | null;
  vix: number | null;
}

export interface FxRate {
  from: string;
  to: string;
  rate: number;
  asOf: string;
}
