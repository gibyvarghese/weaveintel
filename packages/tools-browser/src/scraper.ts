/**
 * CSS selector-based scraper for structured data extraction
 * Uses regex-based extraction (no DOM parser dependency)
 */
import type { ScraperConfig, ScrapedData } from './types.js';
import { fetchPage } from './fetcher.js';

function selectAll(html: string, selector: string): string[] {
  // Simple tag-based selector support (tag, tag.class, tag#id, .class)
  let tagName = '[a-z][a-z0-9]*';
  let classFilter: string | null = null;
  let idFilter: string | null = null;

  if (selector.startsWith('.')) {
    classFilter = selector.slice(1);
  } else if (selector.includes('.')) {
    const [t, c] = selector.split('.');
    tagName = t!;
    classFilter = c!;
  } else if (selector.includes('#')) {
    const [t, i] = selector.split('#');
    tagName = t!;
    idFilter = i!;
  } else {
    tagName = selector;
  }

  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const fullTag = m[0];
    if (classFilter && !fullTag.match(new RegExp(`class\\s*=\\s*["'][^"']*\\b${classFilter}\\b`, 'i'))) continue;
    if (idFilter && !fullTag.match(new RegExp(`id\\s*=\\s*["']${idFilter}["']`, 'i'))) continue;
    results.push(m[1]!.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  }
  return results;
}

export async function scrape(url: string, config: ScraperConfig): Promise<ScrapedData> {
  const result = await fetchPage({ url, timeout: 30_000 });
  const data: Record<string, string | string[]> = {};

  for (const [key, selector] of Object.entries(config.selectors)) {
    const matches = selectAll(result.html, selector);
    data[key] = matches.length === 1 ? matches[0]! : matches;
  }

  return { url: result.url, data };
}
