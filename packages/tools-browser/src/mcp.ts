/**
 * MCP tool definitions for browser tools
 */
import type { Tool, ToolInput, ToolOutput, ExecutionContext } from '@weaveintel/core';
import { fetchPage } from './fetcher.js';
import { extractContent } from './extractor.js';
import { readability } from './readability.js';
import { scrape } from './scraper.js';
import { parseSitemap } from './sitemap.js';

const URL_PARAMS = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'URL to process' },
  },
  required: ['url'],
} as const;

export function createBrowserTools(): Tool[] {
  return [
    {
      schema: {
        name: 'browser.fetch',
        description: 'Fetch a web page and return its raw HTML',
        parameters: URL_PARAMS,
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const url = String(input.arguments['url']);
        const result = await fetchPage({ url, timeout: 30_000 });
        return { content: JSON.stringify({ status: result.status, html: result.html.slice(0, 50_000), latencyMs: result.latencyMs }) };
      },
    },
    {
      schema: {
        name: 'browser.extract',
        description: 'Fetch a page and extract structured content (title, text, links, images, metadata)',
        parameters: URL_PARAMS,
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const url = String(input.arguments['url']);
        const page = await fetchPage({ url, timeout: 30_000 });
        const content = extractContent(page.html);
        return { content: JSON.stringify(content) };
      },
    },
    {
      schema: {
        name: 'browser.read',
        description: 'Fetch a page and extract the main article text (readability mode)',
        parameters: URL_PARAMS,
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const url = String(input.arguments['url']);
        const page = await fetchPage({ url, timeout: 30_000 });
        const result = readability(page.html);
        return { content: JSON.stringify(result) };
      },
    },
    {
      schema: {
        name: 'browser.scrape',
        description: 'Scrape structured data from a page using CSS selectors',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to scrape' },
            selectors: { type: 'object', description: 'Map of field name to CSS selector', additionalProperties: { type: 'string' } },
          },
          required: ['url', 'selectors'],
        },
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const args = input.arguments;
        const url = String(args['url']);
        const selectors = (args['selectors'] ?? {}) as Record<string, string>;
        const result = await scrape(url, { selectors });
        return { content: JSON.stringify(result) };
      },
    },
    {
      schema: {
        name: 'browser.sitemap',
        description: 'Parse a sitemap XML and return all URLs',
        parameters: URL_PARAMS,
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const url = String(input.arguments['url']);
        const entries = await parseSitemap(url);
        return { content: JSON.stringify(entries) };
      },
    },
  ];
}
