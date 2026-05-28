export { buildPeerSet, computeFactor, scoreSymbol, scoreUniverse, explainScore } from './scorer.js';
export { strategies } from './strategies.js';
export { detectFlags } from './flags.js';
export { zScore, squash, median, slope, cagr, annualizedVol, maxDrawdown, crossSectionalZ, clip } from './math.js';

export type {
  FactorCategory, FactorScore, PeerSet, SymbolScore, ScoringStrategy,
  RedFlag, GreenFlag, InputBundle,
} from './types.js';
