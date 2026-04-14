/**
 * @weaveintel/tools-browser — Web fetching, extraction, scraping, and browser automation tools
 */
export type { FetchOptions, FetchResult, ExtractedContent, SitemapEntry, ReadabilityResult, ScraperConfig, ScrapedData } from './types.js';
export type { PageSnapshot, SnapshotElement } from './snapshot.js';
export type { BrowserPoolOptions, SessionInfo } from './automation.js';
export { fetchPage } from './fetcher.js';
export { extractContent } from './extractor.js';
export { readability } from './readability.js';
export { scrape } from './scraper.js';
export { parseSitemap } from './sitemap.js';
export { createBrowserTools } from './mcp.js';
export { createAutomationTools } from './mcp-automation.js';
export { BrowserPool, BrowserSession } from './automation.js';
export { captureSnapshot } from './snapshot.js';

// Convenience aliases
export { fetchPage as weaveFetchPage } from './fetcher.js';
export { readability as weaveReadability } from './readability.js';
export { createBrowserTools as weaveBrowserTools } from './mcp.js';
export { createAutomationTools as weaveAutomationTools } from './mcp-automation.js';
