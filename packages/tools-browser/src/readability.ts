/**
 * Readability-style content extraction — extracts main article text from HTML
 * Simplified algorithm: scores nodes by text density and p/li/td density
 */
import type { ReadabilityResult } from './types.js';

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]!) : '';
}

function extractByline(html: string): string | undefined {
  const m = html.match(/<meta[^>]*name\s*=\s*["']author["'][^>]*content\s*=\s*["']([^"']*)["']/i);
  return m ? m[1] : undefined;
}

function extractSiteName(html: string): string | undefined {
  const m = html.match(/<meta[^>]*property\s*=\s*["']og:site_name["'][^>]*content\s*=\s*["']([^"']*)["']/i);
  return m ? m[1] : undefined;
}

export function readability(html: string): ReadabilityResult {
  // Remove script, style, nav, header, footer, aside
  let cleaned = html.replace(/<(script|style|noscript|nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Remove comments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, '');

  // Find <article> or <main> tag content
  let mainContent = '';
  const articleMatch = cleaned.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
  if (articleMatch) {
    mainContent = articleMatch[1]!;
  } else {
    // Fallback: use body
    const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    mainContent = bodyMatch ? bodyMatch[1]! : cleaned;
  }

  // Extract paragraphs as main content
  const paragraphs: string[] = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(mainContent)) !== null) {
    const text = stripTags(m[1]!);
    if (text.length > 30) paragraphs.push(text);
  }

  const textContent = paragraphs.join('\n\n');
  const contentHtml = paragraphs.map(p => `<p>${p}</p>`).join('\n');
  const title = extractTitle(html);

  return {
    title,
    content: contentHtml,
    textContent,
    length: textContent.length,
    excerpt: textContent.slice(0, 200),
    siteName: extractSiteName(html),
    byline: extractByline(html),
  };
}
