/**
 * @weaveintel/tools-search — Web search provider ecosystem
 */

// Types
export type { SearchResult, SearchOptions, SearchProviderConfig, SearchProvider } from './types.js';

// Base class
export { BaseSearchProvider } from './base.js';

// Providers
export { DuckDuckGoProvider } from './providers/duckduckgo.js';
export { BraveProvider } from './providers/brave.js';
export { GooglePSEProvider } from './providers/google-pse.js';
export { TavilyProvider } from './providers/tavily.js';
export { BingProvider } from './providers/bing.js';
export { SearXNGProvider } from './providers/searxng.js';
export { JinaProvider } from './providers/jina.js';
export { ExaProvider } from './providers/exa.js';
export { SerperProvider } from './providers/serper.js';

// Router
export { createSearchRouter } from './router.js';
export type { SearchRouter, SearchRouterOptions, SearchRouterResult } from './router.js';

// MCP integration
export { createSearchTools } from './mcp.js';

// Convenience aliases
export {
  createSearchRouter as weaveSearchRouter,
} from './router.js';
export { createSearchTools as weaveSearchMCPTools } from './mcp.js';
