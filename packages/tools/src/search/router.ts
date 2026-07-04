/**
 * SearchRouter — picks the best available search provider and fans out queries
 */
import type { SearchResult, SearchOptions, SearchProviderConfig, SearchProvider } from './types.js';
import { DuckDuckGoProvider } from './providers/duckduckgo.js';
import { BraveProvider } from './providers/brave.js';
import { GooglePSEProvider } from './providers/google-pse.js';
import { TavilyProvider } from './providers/tavily.js';
import { BingProvider } from './providers/bing.js';
import { SearXNGProvider } from './providers/searxng.js';
import { JinaProvider } from './providers/jina.js';
import { ExaProvider } from './providers/exa.js';
import { SerperProvider } from './providers/serper.js';

const BUILT_IN: SearchProvider[] = [
  new DuckDuckGoProvider(),
  new BraveProvider(),
  new GooglePSEProvider(),
  new TavilyProvider(),
  new BingProvider(),
  new SearXNGProvider(),
  new JinaProvider(),
  new ExaProvider(),
  new SerperProvider(),
];

export interface SearchRouterOptions {
  /** Custom provider instances (merged with built-ins) */
  providers?: SearchProvider[];
  /** Provider configs keyed by provider name */
  configs: Record<string, SearchProviderConfig>;
  /** Fallback limit when provider fails */
  fallback?: boolean;
}

export interface SearchRouterResult {
  provider: string;
  results: SearchResult[];
  latencyMs: number;
  error?: string;
}

export function createSearchRouter(opts: SearchRouterOptions) {
  const allProviders = [...BUILT_IN, ...(opts.providers ?? [])];
  const providerMap = new Map<string, SearchProvider>();
  for (const p of allProviders) providerMap.set(p.name, p);

  /** Get enabled providers sorted by priority (lower = higher priority) */
  function enabledProviders(): Array<{ provider: SearchProvider; config: SearchProviderConfig }> {
    return Object.entries(opts.configs)
      .filter(([, c]) => c.enabled !== false)
      .sort((a, b) => (a[1].priority ?? 50) - (b[1].priority ?? 50))
      .map(([, c]) => {
        const p = providerMap.get(c.name);
        return p ? { provider: p, config: c } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  /** Search using the highest-priority available provider */
  async function search(options: SearchOptions): Promise<SearchRouterResult> {
    const providers = enabledProviders();
    if (providers.length === 0) throw new Error('No search providers configured');

    for (const { provider, config } of providers) {
      const start = Date.now();
      try {
        const results = await provider.search(options, config);
        return { provider: provider.name, results, latencyMs: Date.now() - start };
      } catch (err) {
        if (!opts.fallback) {
          return { provider: provider.name, results: [], latencyMs: Date.now() - start, error: String(err) };
        }
        // try next provider
      }
    }
    return { provider: 'none', results: [], latencyMs: 0, error: 'All providers failed' };
  }

  /** Search a specific provider by name */
  async function searchWith(providerName: string, options: SearchOptions): Promise<SearchRouterResult> {
    const provider = providerMap.get(providerName);
    const config = opts.configs[providerName];
    if (!provider || !config) throw new Error(`Provider "${providerName}" not found or not configured`);
    const start = Date.now();
    try {
      const results = await provider.search(options, config);
      return { provider: providerName, results, latencyMs: Date.now() - start };
    } catch (err) {
      return { provider: providerName, results: [], latencyMs: Date.now() - start, error: String(err) };
    }
  }

  /** Fan out to multiple providers and merge results */
  async function searchAll(options: SearchOptions): Promise<SearchRouterResult[]> {
    const providers = enabledProviders();
    return Promise.all(
      providers.map(async ({ provider, config }) => {
        const start = Date.now();
        try {
          const results = await provider.search(options, config);
          return { provider: provider.name, results, latencyMs: Date.now() - start } as SearchRouterResult;
        } catch (err) {
          return { provider: provider.name, results: [], latencyMs: Date.now() - start, error: String(err) } as SearchRouterResult;
        }
      }),
    );
  }

  function listProviders(): string[] {
    return allProviders.map(p => p.name);
  }

  return { search, searchWith, searchAll, listProviders };
}

export type SearchRouter = ReturnType<typeof createSearchRouter>;
