import type { ExecutionContext } from '@weaveintel/core';
import type { TrendsDataPoint, EsgScores, SupplyChainExposure } from './types.js';

export interface AltDataAdapter {
  getGoogleTrends(ctx: ExecutionContext, query: string, weeks: number): Promise<TrendsDataPoint[]>;
  getEsgScores(ctx: ExecutionContext, symbol: string): Promise<EsgScores | null>;
  getSupplyChainExposure(ctx: ExecutionContext, symbol: string): Promise<SupplyChainExposure | null>;
}
