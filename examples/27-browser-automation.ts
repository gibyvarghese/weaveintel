/**
 * Example 27 — Browser Automation
 *
 * Demonstrates @weaveintel/tools-browser: fetching web pages, content extraction,
 * readability parsing, sitemap crawling, browser pool session management, login form
 * detection, snapshot capture, and agent-level browser auth tool delegation.
 *
 * WeaveIntel packages used:
 *   @weaveintel/tools-browser — Web fetching, scraping, and browser automation:
 *     • fetchPage             — HTTP fetch with redirect following, gzip support,
 *                               and optional stealth headers. Returns raw HTML + metadata
 *                               (status, redirectUrl, contentType). No browser required.
 *     • extractContent        — Strips HTML tags and script/style elements from a page,
 *                               returning clean text suitable for LLM ingestion.
 *     • readability           — Applies Mozilla's Readability algorithm to extract the
 *                               article body, title, byline, and word count from any URL.
 *                               Ideal for news articles and blog posts.
 *     • scrape                — Rule-based scraper. Provide CSS selectors and field names;
 *                               returns a typed object with the extracted values.
 *     • parseSitemap          — Parses XML sitemap (or sitemap index) at a given URL and
 *                               returns all page URLs with their lastmod dates.
 *     • BrowserPool           — Manages a pool of Playwright browser sessions. Sessions
 *                               expire after a configurable idle timeout. Supports system
 *                               Chrome (set BROWSER_EXECUTABLE_PATH env var) or bundled
 *                               Chromium. Used by agents that need JS rendering.
 *     • BrowserSession        — A single browser context with a Page. Exposes .snapshot(),
 *                               .settle(), .handoffState, and direct Playwright Page access.
 *     • captureSnapshot       — Takes a structural snapshot of the current page: title,
 *                               URL, all interactive elements (links, inputs, buttons) with
 *                               their bounding rects. Used by agents to decide next actions
 *                               without seeing raw HTML.
 *     • detectLoginForm       — Scans a page snapshot for login form patterns (username/
 *                               password inputs, OAuth buttons). Returns detection result
 *                               with confidence score and form type.
 *     • createBrowserAuthTools— Creates MCP tools for the browser auth handoff protocol:
 *                               detect_login_form, initiate_auth_handoff, confirm_handoff.
 *                               Used to hand control to the user for auth, then resume.
 *     • createBrowserTools    — Wraps fetchPage, extractContent, readability, scrape, and
 *                               parseSitemap as MCP tool definitions for agent use.
 *     • createAutomationTools — Wraps BrowserPool session lifecycle (open/click/type/
 *                               screenshot/close) as MCP tools so agents can control
 *                               a real browser.
 *   @weaveintel/core    — weaveContext(), weaveTool(), weaveToolRegistry()
 *   @weaveintel/agents  — weaveAgent()
 *   @weaveintel/testing — weaveFakeModel()
 *
 * NOTE: Sections 3–5 (BrowserPool, snapshot, detectLoginForm) require Playwright and either
 * a bundled Chromium or a system Chrome. Install with: npx playwright install chromium
 * Set BROWSER_EXECUTABLE_PATH to use system Chrome (e.g. /usr/bin/google-chrome).
 *
 * Sections 1–2 (HTTP fetch, readability, scrape) work without a browser.
 *
 * Run: npx tsx examples/27-browser-automation.ts
 */

import {
  fetchPage,
  extractContent,
  readability,
  scrape,
  parseSitemap,
  BrowserPool,
  captureSnapshot,
  detectLoginForm,
  createBrowserTools,
  createAutomationTools,
  createBrowserAuthTools,
} from '@weaveintel/tools-browser';
import { weaveContext, weaveToolRegistry } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';

async function main() {
  // --- 1. HTTP fetch + content extraction (no browser needed) ---
  console.log('=== 1. fetchPage + extractContent ===');

  // fetchPage() uses native fetch with stealth headers. Returns HTML and metadata.
  // In CI/CD environments where you want lightweight scraping without a browser,
  // this is the preferred approach.
  try {
    const page = await fetchPage({ url: 'https://example.com' });
    console.log(`Status:       ${page.status}`);
    console.log(`Content-Type: ${page.headers['content-type'] ?? ''}`);
    console.log(`HTML length:  ${page.html.length} chars`);

    // extractContent() strips HTML to plain text for LLM ingestion.
    const text = extractContent(page.html).text;
    console.log(`Extracted text (first 200 chars):\n  ${text.slice(0, 200).replace(/\n/g, ' ')}`);
  } catch (err) {
    console.log(`  (network unavailable in this environment — skipped: ${(err as Error).message})`);
  }

  // --- 2. Readability article extraction + CSS scraping ---
  console.log('\n=== 2. readability() + scrape() ===');

  // readability() applies Mozilla Readability to extract clean article content.
  // Perfect for ingesting blog posts or docs into a RAG pipeline.
  try {
    const page = await fetchPage({ url: 'https://example.com' });
    const article = readability(page.html);
    if (article) {
      console.log(`Title:    ${article.title}`);
      console.log(`Byline:   ${article.byline ?? '(none)'}`);
      console.log(`Words:    ${Math.round(article.textContent.split(/\s+/).length)}`);
      console.log(`Excerpt:  ${article.content.slice(0, 150).replace(/\n/g, ' ')}`);
    } else {
      console.log('  Readability returned no article (page may not be article-format)');
    }
  } catch (err) {
    console.log(`  (network unavailable — skipped: ${(err as Error).message})`);
  }

  // scrape() lets you extract specific fields using CSS selectors.
  // Define field→selector mappings; results are typed by your schema.
  try {
    const data = await scrape('https://example.com', {
      selectors: {
        title: 'h1',
        description: 'p',
        links: 'a',
      },
    });
    const scraped = data as unknown as Record<string, unknown>;
    console.log(`Scraped title: ${String(scraped['title'] ?? '')}`);
    console.log(`Scraped description: ${String(scraped['description'] ?? '').slice(0, 80)}`);
  } catch (err) {
    console.log(`  (scrape skipped: ${(err as Error).message})`);
  }

  // parseSitemap() downloads and parses an XML sitemap (or sitemap index).
  // Returns an array of SitemapEntry: { url, lastmod? }.
  // Useful for crawling a whole domain's pages into a vector store.
  console.log('\n=== 2b. parseSitemap() ===');
  try {
    const sitemapEntries = await parseSitemap('https://example.com/sitemap.xml');
    console.log(`Sitemap entries: ${sitemapEntries.length}`);
    for (const entry of sitemapEntries.slice(0, 3)) {
      console.log(`  ${entry.loc}${entry.lastmod ? ` (${entry.lastmod})` : ''}`);
    }
  } catch (err) {
    console.log(`  (sitemap unavailable — skipped: ${(err as Error).message})`);
  }

  // --- 3. BrowserPool session management ---
  // BrowserPool manages Playwright browser instances. Sessions are created on
  // demand and evicted after sessionTimeoutMs of idle time.
  //
  // Set BROWSER_EXECUTABLE_PATH to use system Chrome/Chromium:
  //   export BROWSER_EXECUTABLE_PATH=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome
  // This avoids downloading Playwright's bundled Chromium and uses what's already installed.
  console.log('\n=== 3. BrowserPool (requires Playwright) ===');

  // Check if Playwright is available before attempting to launch a browser
  let playwrightAvailable = false;
  try {
    await import('playwright-core');
    playwrightAvailable = true;
  } catch {
    console.log('  playwright-core not installed — skipping BrowserPool demo');
    console.log('  Install with: npm install playwright-core && npx playwright install chromium');
  }

  if (playwrightAvailable) {
    const pool = new BrowserPool({
      maxSessions: 3,
      sessionTimeoutMs: 5 * 60 * 1000, // 5 minutes idle timeout
      headless: true,
      // Uses system Chrome if BROWSER_EXECUTABLE_PATH is set; otherwise bundled Chromium
      executablePath: process.env['BROWSER_EXECUTABLE_PATH'],
    });

    try {
      // open() creates a new BrowserSession (browser + context + page)
      const { session } = await pool.open('https://example.com');
      console.log(`Session created: ${session.id}`);
      console.log(`Active sessions: ${pool.list().length}`);

      // Navigate the session's page directly via Playwright's Page API
      await session.page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

      // settle() waits for networkidle — useful after clicking / form submission
      await session.settle();

      const sessionInfo = pool.list().find((s) => s.id === session.id);
      console.log(`Session info: url=${sessionInfo?.url ?? session.page.url()}`);

      // --- 4. Page snapshot + login form detection ---
      // captureSnapshot() takes a structural snapshot of the current page:
      // all interactive elements (inputs, buttons, links) with their text and position.
      // This lets an agent understand the page without processing raw HTML.
      console.log('\n=== 4. captureSnapshot() + detectLoginForm() ===');

      const updatedSnapshot = await captureSnapshot(session.page);
      console.log(`Snapshot title: ${updatedSnapshot.title}`);
      console.log(`Snapshot URL:   ${updatedSnapshot.url}`);
      console.log(`Interactive elements: ${updatedSnapshot.elements.length}`);
      for (const el of updatedSnapshot.elements.slice(0, 5)) {
        console.log(`  [${el.tag}] "${el.name.slice(0, 50)}" role=${el.role ?? 'none'}`);
      }

      // detectLoginForm() scans the snapshot for username/password patterns,
      // OAuth provider buttons (Google, GitHub, Microsoft), and SSO indicators.
      // Returns: { hasLoginForm, formType, confidence, fields }
      const loginDetection = detectLoginForm(updatedSnapshot);
      console.log(`\nLogin form detection:`);
      console.log(`  detected:      ${loginDetection.detected}`);
      console.log(`  type:          ${loginDetection.type ?? '(none)'}`);
      console.log(`  captchaPresent:${loginDetection.captchaPresent}`);
      console.log(`  oauthButtons:  ${loginDetection.oauthButtons.join(', ') || '(none)'}`);

      // Close the session when done
      await pool.close(session.id);
      console.log(`Session ${session.id} closed`);
    } catch (err) {
      console.log(`  BrowserPool error (browser launch may fail in headless CI): ${(err as Error).message}`);
    } finally {
      await pool.dispose();
    }
  }

  // --- 5. MCP tool wiring ---
  // createBrowserTools() wraps HTTP-based tools (fetchPage, readability, scrape, parseSitemap)
  // as MCP tool definitions. Agents can call them via their ToolRegistry.
  // createAutomationTools() wraps BrowserPool session lifecycle as MCP tools (open/click/type).
  // createBrowserAuthTools() adds the auth handoff protocol (detect_login_form, initiate_auth_handoff).
  console.log('\n=== 5. MCP tool wiring ===');

  const browserMCPTools = createBrowserTools();
  const automationMCPTools = createAutomationTools();
  const authMCPTools = createBrowserAuthTools();

  const allBrowserTools = [...browserMCPTools, ...automationMCPTools, ...authMCPTools];
  console.log(`Total MCP tools exposed: ${allBrowserTools.length}`);
  for (const t of allBrowserTools) {
    console.log(`  • ${t.schema.name}: ${(t.schema.description ?? '').slice(0, 70)}`);
  }

  // Wire into an agent's tool registry
  const registry = weaveToolRegistry();
  for (const toolDef of browserMCPTools) {
    registry.register(toolDef);
  }

  const ctx = weaveContext({ userId: 'browser-demo' });
  const model = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [
          {
            id: 'b1',
            function: {
              name: 'fetch_page',
              arguments: JSON.stringify({ url: 'https://example.com' }),
            },
          },
        ],
      },
      { content: 'I fetched the page and extracted the content.' },
    ],
  });

  const agent = weaveAgent({ model, tools: registry, maxSteps: 4 });
  const result = await agent.run(ctx, {
    messages: [{ role: 'user', content: 'Fetch https://example.com and tell me what it says.' }],
  });

  console.log(`\nAgent result: ${result.messages[result.messages.length - 1]?.content}`);

  // --- Summary ---
  console.log('\n=== Summary ===');
  console.log('fetchPage + extractContent:  lightweight HTTP scraping, no browser required');
  console.log('readability():               Mozilla Readability — clean article text extraction');
  console.log('scrape(html, selectors):     CSS-selector-based structured field extraction');
  console.log('parseSitemap():              crawl a whole domain\'s URL index from XML sitemap');
  console.log('BrowserPool + BrowserSession: Playwright browser lifecycle with idle timeout + session reuse');
  console.log('captureSnapshot():           structural page snapshot (elements, roles) for agents');
  console.log('detectLoginForm():           identify login/OAuth forms before auth handoff');
  console.log('createBrowserAuthTools():    MCP tools for agent↔user auth handoff protocol');
  console.log('BROWSER_EXECUTABLE_PATH:     use system Chrome instead of bundled Chromium');
}

main().catch(console.error);
