/**
 * Sitemap parser — fetches and parses XML sitemaps
 */
import type { SitemapEntry } from './types.js';
import { fetchPage } from './fetcher.js';

export async function parseSitemap(url: string): Promise<SitemapEntry[]> {
  const result = await fetchPage({ url, timeout: 30_000 });
  const entries: SitemapEntry[] = [];

  // Parse <url> entries
  const urlRe = /<url>([\s\S]*?)<\/url>/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(result.html)) !== null) {
    const block = m[1]!;
    const loc = block.match(/<loc>([\s\S]*?)<\/loc>/i)?.[1]?.trim();
    if (!loc) continue;
    entries.push({
      loc,
      lastmod: block.match(/<lastmod>([\s\S]*?)<\/lastmod>/i)?.[1]?.trim(),
      changefreq: block.match(/<changefreq>([\s\S]*?)<\/changefreq>/i)?.[1]?.trim(),
      priority: block.match(/<priority>([\s\S]*?)<\/priority>/i)?.[1] ? Number(block.match(/<priority>([\s\S]*?)<\/priority>/i)![1]) : undefined,
    });
  }

  // Also check for sitemap index
  const sitemapRe = /<sitemap>([\s\S]*?)<\/sitemap>/gi;
  while ((m = sitemapRe.exec(result.html)) !== null) {
    const loc = m[1]!.match(/<loc>([\s\S]*?)<\/loc>/i)?.[1]?.trim();
    if (loc) {
      const nested = await parseSitemap(loc);
      entries.push(...nested);
    }
  }

  return entries;
}
