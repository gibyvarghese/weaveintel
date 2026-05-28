export interface TrendsDataPoint {
  week: string;  // ISO date (Monday)
  index: number; // 0-100 relative search interest
}

export interface EsgScores {
  symbol: string;
  asOf: string;
  environmental: number | null;  // 0-100
  social: number | null;
  governance: number | null;
  composite: number | null;
  ratingAgency: string | null;
}

export interface SupplyChainExposure {
  symbol: string;
  asOf: string;
  topSuppliers: string[];          // company names
  topCustomers: string[];
  geographicRevenue: Record<string, number>;  // region -> fraction (sum ≈ 1)
}
