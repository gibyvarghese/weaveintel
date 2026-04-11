/**
 * HTML content extractor — extracts structured data from raw HTML
 * Uses regex-based extraction (no external HTML parser dependency)
 */
import type { ExtractedContent } from './types.js';

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractTag(html: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = html.match(re);
  return m ? stripTags(m[1]!) : '';
}

function extractMeta(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const re = /<meta\s+([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1]!;
    const nameMatch = attrs.match(/(?:name|property)\s*=\s*["']([^"']*)["']/i);
    const contentMatch = attrs.match(/content\s*=\s*["']([^"']*)["']/i);
    if (nameMatch && contentMatch) meta[nameMatch[1]!] = contentMatch[1]!;
  }
  return meta;
}

function extractLinks(html: string): Array<{ href: string; text: string }> {
  const links: Array<{ href: string; text: string }> = [];
  const re = /<a\s+[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    links.push({ href: m[1]!, text: stripTags(m[2]!) });
  }
  return links;
}

function extractImages(html: string): Array<{ src: string; alt: string }> {
  const images: Array<{ src: string; alt: string }> = [];
  const re = /<img\s+[^>]*src\s*=\s*["']([^"']*)["'][^>]*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const altMatch = m[0]!.match(/alt\s*=\s*["']([^"']*)["']/i);
    images.push({ src: m[1]!, alt: altMatch ? altMatch[1]! : '' });
  }
  return images;
}

export function extractContent(html: string): ExtractedContent {
  // Remove script and style tags
  const cleaned = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
  return {
    title: extractTag(html, 'title'),
    text: stripTags(cleaned.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? cleaned),
    links: extractLinks(cleaned),
    images: extractImages(cleaned),
    metadata: extractMeta(html),
  };
}
