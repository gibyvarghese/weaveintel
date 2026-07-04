import type { ExecutionContext } from '@weaveintel/core';
import type { AltDataAdapter } from '../adapter.js';
import type { TrendsDataPoint, EsgScores, SupplyChainExposure } from '../types.js';

const ESG: Record<string, EsgScores> = {
  AAPL:     { symbol: 'AAPL',     asOf: '2026-01-01', environmental: 72, social: 68, governance: 75, composite: 72, ratingAgency: 'MSCI' },
  MSFT:     { symbol: 'MSFT',     asOf: '2026-01-01', environmental: 82, social: 79, governance: 85, composite: 82, ratingAgency: 'MSCI' },
  GOOGL:    { symbol: 'GOOGL',    asOf: '2026-01-01', environmental: 68, social: 62, governance: 70, composite: 67, ratingAgency: 'MSCI' },
  JNJ:      { symbol: 'JNJ',      asOf: '2026-01-01', environmental: 65, social: 72, governance: 78, composite: 72, ratingAgency: 'Sustainalytics' },
  XOM:      { symbol: 'XOM',      asOf: '2026-01-01', environmental: 28, social: 45, governance: 62, composite: 42, ratingAgency: 'MSCI' },
  RELIANCE: { symbol: 'RELIANCE', asOf: '2026-01-01', environmental: 38, social: 52, governance: 58, composite: 49, ratingAgency: 'Sustainalytics' },
  TCS:      { symbol: 'TCS',      asOf: '2026-01-01', environmental: 65, social: 78, governance: 82, composite: 75, ratingAgency: 'MSCI' },
  INFY:     { symbol: 'INFY',     asOf: '2026-01-01', environmental: 70, social: 75, governance: 80, composite: 75, ratingAgency: 'MSCI' },
};

const SUPPLY: Record<string, SupplyChainExposure> = {
  AAPL:  { symbol: 'AAPL',  asOf: '2026-01-01', topSuppliers: ['Foxconn', 'TSMC', 'Samsung', 'Broadcom', 'Qualcomm'], topCustomers: [], geographicRevenue: { 'Americas': 0.42, 'Europe': 0.25, 'Greater China': 0.19, 'Japan': 0.07, 'Rest of Asia Pacific': 0.07 } },
  MSFT:  { symbol: 'MSFT',  asOf: '2026-01-01', topSuppliers: ['Intel', 'AMD', 'NVIDIA', 'Samsung'], topCustomers: [], geographicRevenue: { 'US': 0.50, 'Europe': 0.25, 'Asia Pacific': 0.15, 'Other': 0.10 } },
  GOOGL: { symbol: 'GOOGL', asOf: '2026-01-01', topSuppliers: ['TSMC', 'Samsung', 'Intel', 'Motorola'], topCustomers: [], geographicRevenue: { 'US': 0.47, 'EMEA': 0.30, 'APAC': 0.16, 'Other Americas': 0.07 } },
  JNJ:   { symbol: 'JNJ',   asOf: '2026-01-01', topSuppliers: ['DuPont', 'BASF', 'Merck KGaA'], topCustomers: ['Distributors', 'Hospitals', 'Governments'], geographicRevenue: { 'US': 0.50, 'Europe': 0.25, 'Asia Pacific': 0.15, 'Other': 0.10 } },
  XOM:   { symbol: 'XOM',   asOf: '2026-01-01', topSuppliers: ['Schlumberger', 'Baker Hughes', 'Halliburton'], topCustomers: ['Refineries', 'Industrial Users'], geographicRevenue: { 'US': 0.40, 'Asia Pacific': 0.30, 'Europe': 0.18, 'Other': 0.12 } },
  RELIANCE: { symbol: 'RELIANCE', asOf: '2026-01-01', topSuppliers: ['Saudi Aramco', 'ADNOC', 'ONGC'], topCustomers: [], geographicRevenue: { 'India': 0.82, 'Asia Pacific': 0.10, 'Other': 0.08 } },
  TCS:   { symbol: 'TCS',   asOf: '2026-01-01', topSuppliers: ['Microsoft', 'Oracle', 'SAP'], topCustomers: ['Banks', 'Insurance', 'Retail'], geographicRevenue: { 'North America': 0.53, 'Europe': 0.31, 'India': 0.06, 'Other': 0.10 } },
  INFY:  { symbol: 'INFY',  asOf: '2026-01-01', topSuppliers: ['Microsoft', 'IBM', 'Oracle'], topCustomers: ['Financial Services', 'Manufacturing', 'Energy'], geographicRevenue: { 'North America': 0.60, 'Europe': 0.25, 'India': 0.04, 'Other': 0.11 } },
};

export function fixtureAltDataAdapter(): AltDataAdapter {
  return {
    async getGoogleTrends(_ctx, query, weeks): Promise<TrendsDataPoint[]> {
      const results: TrendsDataPoint[] = [];
      const base = 50 + (query.length % 30);
      for (let i = weeks - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i * 7 - d.getDay());
        const index = Math.round(Math.max(10, Math.min(100, base + Math.sin(i * 0.4) * 15 + (i === 0 ? 10 : 0))));
        results.push({ week: d.toISOString().slice(0, 10), index });
      }
      return results;
    },

    async getEsgScores(_ctx, symbol): Promise<EsgScores | null> {
      return ESG[symbol] ?? null;
    },

    async getSupplyChainExposure(_ctx, symbol): Promise<SupplyChainExposure | null> {
      return SUPPLY[symbol] ?? null;
    },
  };
}
