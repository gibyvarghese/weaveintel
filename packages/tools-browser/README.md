# @weaveintel/tools-browser

**Browser and web tools — fetch pages, extract clean content, and drive a real browser — for your agent.**

## Why it exists

Much of what an agent needs lives on the open web, but a raw web page is a cluttered room: ads, menus, scripts, and the one paragraph you actually wanted. These tools tidy that room. They fetch a page, strip it down to readable content, follow a sitemap, or — when a task really needs clicking and typing — open a real Playwright browser and act like a person would. It sits on top of `@weaveintel/tools`, adding a web-shaped toolbelt to the standard one.

This is a **separate, install-it-yourself package on purpose**: driving a real browser drags in `playwright-core`, which is heavy. Keeping it apart means agents that only need lightweight tools don't pay for a browser they'll never launch.

## When to reach for it

Reach for it when your agent needs to read the web or automate a page (log in, click, fill a form). If you only need general-purpose tools (files, math, HTTP), stay with `@weaveintel/tools` and skip the Playwright weight. Automation needs a browser present — check `isBrowserAutomationAvailable()` first.

## How to use it

```ts
import { fetchPage, readability, createBrowserTools } from '@weaveintel/tools-browser';

// One-off: fetch and clean a page
const page = await fetchPage('https://example.com');
const article = readability(page.html ?? '', 'https://example.com');
console.log(article.title, article.textContent);

// Or hand the whole browser toolbelt to your agent
const tools = createBrowserTools();   // Tool[] ready for a ToolRegistry
```

## What's in the box

| Export | What it does |
| --- | --- |
| `fetchPage(url, opts?)` | Fetch a page's HTML/text |
| `readability(html, url)` | Strip a page down to its readable article |
| `extractContent`, `scrape`, `parseSitemap` | Structured extraction, scraping, sitemap parsing |
| `createBrowserTools()` | Fetch/extract/read tools as a `Tool[]` |
| `createAutomationTools()` | Real-browser click/type/navigate tools (Playwright) |
| `createBrowserAuthTools()`, `BrowserAuthProvider` | Logged-in browsing (form/cookie/OAuth/SSO hand-off) |
| `BrowserPool`, `BrowserSession`, `captureSnapshot` | Lower-level session pooling and page snapshots |
| `isBrowserAutomationAvailable()` | Check whether Playwright is installed before automating |

## License

MIT.
