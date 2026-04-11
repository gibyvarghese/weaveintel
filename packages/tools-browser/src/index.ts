/**
 * @weaveintel/tools-browser — Web fetching, extraction, scraping tools
 */
export type { FetchOptions, FetchResult, ExtractedContent, SitemapEntry, ReadabilityResult, ScraperConfig, ScrapedData } from './types.js';
export { fetchPage } from './fetcher.js';
export { extractContent } from './extractor.js';
export { readability } from './readability.js';
export { scrape } from './scraper.js';
export { parseSitemap } from './sitemap.js';
export { createBrowserTools } from './mcp.js';

// Convenience aliases
export { fetchPage as weaveFetchPage } from './fetcher.js';
export { readability as weaveReadability } from './readability.js';
export { createBrowserTools as weaveBrowserTools } from './mcp.js';
