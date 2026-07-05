// SPDX-License-Identifier: MIT
/**
 * A real-world benchmark dataset — real published skills, real human messages.
 *
 * The demo catalog in `skill-benchmark.ts` is tidy and synthetic. This one is modelled on skills that
 * actually exist in the wild: Anthropic's official Agent Skills (github.com/anthropics/skills — pdf,
 * docx, xlsx, pptx, skill-creator, mcp-builder, brand-guidelines, canvas-design, webapp-testing, …)
 * plus popular community skills catalogued in awesome-agent-skills (Next.js, Terraform, Stripe,
 * Playwright, Semgrep, Notion, Cloudflare Workers, PostgreSQL, and more). Names and one-line
 * descriptions follow those real skills' `SKILL.md` frontmatter.
 *
 * The queries are the messy way people actually ask — lowercase, colloquial, with typos and slang —
 * NOT clean keyword matches. That makes retrieval genuinely hard (many look-alike skills in the same
 * domain — the "same-capability ambiguity" that SkillResolve-Bench measures), which is the point: it's
 * where meaning-based matching earns its keep. Gold labels allow more than one acceptable skill where
 * two skills genuinely overlap.
 */

import type { SkillDefinition } from './types.js';
import { defineSkill } from './types.js';

/** ~50 skills across 12 categories, modelled on real published Agent Skills. */
export function buildRealWorldCatalog(): SkillDefinition[] {
  const s = (id: string, name: string, summary: string, whenToUse: string, tags: string[], extra: Partial<SkillDefinition> = {}) =>
    defineSkill({ id, name, summary, whenToUse, tags, ...extra });
  return [
    // ── Documents (Anthropic official) ──────────────────────────────────────────────
    s('pdf', 'PDF Toolkit', 'Fill, extract from and manipulate PDF documents — fill form fields, pull text and tables, merge or split files.', 'When a user has a PDF to fill in, read from, or combine.', ['documents'], { inputModalities: ['pdf', 'text'] }),
    s('docx', 'Word Documents', 'Create and edit Microsoft Word documents with formatting, styles, headings and tables.', 'When a user wants to produce or edit a Word (.docx) document.', ['documents']),
    s('xlsx', 'Excel Spreadsheets', 'Create and edit Excel spreadsheets — write data, formulas, charts and formatting.', 'When a user wants data put into or pulled out of an Excel file.', ['documents', 'data'], { inputModalities: ['table', 'text'] }),
    s('pptx', 'PowerPoint Decks', 'Build and edit PowerPoint presentations — slides, layouts, images and speaker notes.', 'When a user wants a slide deck created or edited.', ['documents']),
    // ── Anthropic creative / dev / comms ────────────────────────────────────────────
    s('skill-creator', 'Skill Creator', 'Scaffold a new Agent Skill — generate a SKILL.md, folder structure and starter scripts.', 'When a user wants to build a new reusable skill.', ['meta']),
    s('mcp-builder', 'MCP Server Builder', 'Build an MCP server to expose an external API or tool to AI agents.', 'When a user wants to connect an API or tool to agents over MCP.', ['integration']),
    s('brand-guidelines', 'Brand Guidelines', "Apply a company's brand guidelines — colours, fonts, tone and logo usage — to documents and designs.", 'When output must follow a specific brand style.', ['design']),
    s('canvas-design', 'Canvas Design', 'Create visual art and designs in PNG and PDF formats programmatically.', 'When a user wants a graphic or visual design generated.', ['design'], { inputModalities: ['image', 'text'] }),
    s('algorithmic-art', 'Algorithmic Art', 'Generate procedural, generative art using p5.js with seeded randomness.', 'When a user wants generative or procedural artwork.', ['design']),
    s('webapp-testing', 'Web App Testing', 'Test a web app end-to-end in a real browser and report what breaks.', 'When a user wants their web app exercised and bugs surfaced.', ['testing']),
    s('doc-coauthoring', 'Document Co-author', 'Co-author long documents with a human — draft, revise and track changes section by section.', 'When a user wants help writing a long document collaboratively.', ['writing']),
    s('internal-comms', 'Internal Comms', 'Write internal communications — status reports, newsletters, announcements and FAQs.', 'When a user needs an internal update, announcement or newsletter written.', ['writing']),
    s('frontend-design', 'Frontend Design', 'Design polished frontend UI — layout, components and responsive styling.', 'When a user wants a good-looking, responsive UI designed.', ['design', 'code']),
    s('web-artifacts', 'Web Artifact Builder', 'Build interactive web artifacts — self-contained HTML/JS apps and visualisations.', 'When a user wants a small interactive web app or visualisation.', ['code']),
    // ── Web / app development ────────────────────────────────────────────────────────
    s('nextjs', 'Next.js Best Practices', 'Recommend patterns and modernisation for Next.js — routing, rendering and performance.', 'When a user is working on a Next.js app and wants it faster or more idiomatic.', ['code']),
    s('angular', 'Angular Developer', 'Generate Angular components, services and reactive patterns with architectural guidance.', 'When a user is building or structuring an Angular app.', ['code']),
    s('react-native', 'React Native Performance', 'Optimise React Native apps for performance — rendering, lists and startup time.', 'When a user wants their React Native mobile app to run faster.', ['code']),
    s('wordpress', 'WordPress Plugin Dev', 'Build WordPress plugins — hooks, settings API and secure plugin architecture.', 'When a user is building a WordPress plugin.', ['code']),
    s('rest-api', 'REST API Development', 'Design REST endpoints with schema, auth and consistent responses.', 'When a user is designing or building a REST API.', ['code', 'api']),
    // ── Data & analytics ─────────────────────────────────────────────────────────────
    s('clickhouse', 'ClickHouse Best Practices', 'Optimise ClickHouse — datasources, materialised views and SQL performance.', 'When a user works with ClickHouse and wants faster queries.', ['data']),
    s('postgres', 'PostgreSQL Best Practices', 'Design and optimise PostgreSQL schemas, indexes and queries.', 'When a user wants help with Postgres schema or slow queries.', ['data']),
    s('huggingface-datasets', 'Hugging Face Datasets', 'Browse and query Hugging Face datasets with SQL-like queries.', 'When a user wants to explore a public dataset.', ['data', 'ai']),
    s('azure-monitor', 'Azure Monitor Query', 'Query logs and metrics across Azure infrastructure.', 'When a user needs to investigate cloud logs or metrics.', ['data', 'devops']),
    // ── Security ─────────────────────────────────────────────────────────────────────
    s('static-analysis', 'Static Analysis', 'Detect code vulnerabilities using CodeQL and Semgrep with SARIF reporting.', 'When a user wants an automated vulnerability scan of a codebase.', ['security']),
    s('semgrep-rules', 'Semgrep Rule Creator', 'Write custom Semgrep rules to detect vulnerability patterns.', 'When a user wants a custom code-scanning rule.', ['security']),
    s('security-review', 'Security Best Practices', 'Review code for language-specific security vulnerabilities and weak patterns.', 'When a user wants a human-style security review of their code.', ['security']),
    s('insecure-defaults', 'Insecure Defaults Finder', 'Find hardcoded secrets, default credentials and weak cryptography in a codebase.', 'When a user worries about leaked secrets or weak crypto in their repo.', ['security']),
    // ── Testing ──────────────────────────────────────────────────────────────────────
    s('playwright', 'Playwright E2E Tests', 'Generate Playwright end-to-end tests in TypeScript, Python, Java or C#.', 'When a user wants browser end-to-end tests written.', ['testing']),
    s('jest', 'Jest Unit Testing', 'Write Jest unit tests with mocking, fixtures and snapshots.', 'When a user wants unit tests for JavaScript/TypeScript code.', ['testing']),
    s('cypress', 'Cypress Testing', 'Build Cypress tests for single-page apps and components.', 'When a user prefers Cypress for their frontend tests.', ['testing']),
    s('test-migration', 'Test Framework Migration', 'Migrate tests between Selenium, Playwright and Cypress.', 'When a user wants to move an existing test suite to another framework.', ['testing']),
    // ── DevOps / infra ───────────────────────────────────────────────────────────────
    s('terraform', 'Terraform Provider', 'Scaffold and implement a Terraform infrastructure provider.', 'When a user is writing Terraform or a custom provider.', ['devops']),
    s('cloudflare-workers', 'Cloudflare Workers', 'Deploy and manage serverless functions, KV storage and D1 on Cloudflare.', 'When a user wants to deploy a function or edge app to Cloudflare.', ['devops']),
    s('docker', 'Docker & Registry', 'Build container images and push them to a registry.', 'When a user wants to containerise an app or push an image.', ['devops']),
    s('cicd', 'CI/CD Pipelines', 'Generate CI/CD pipelines for GitHub Actions, Jenkins or GitLab CI.', 'When a user wants an automated build/test/deploy pipeline.', ['devops']),
    // ── Productivity ─────────────────────────────────────────────────────────────────
    s('notion-capture', 'Notion Knowledge Capture', 'Convert a conversation or notes into a structured, searchable Notion page.', 'When a user wants a chat or notes saved into Notion.', ['productivity']),
    s('github-workflow', 'GitHub Workflow Patterns', 'Best practices for pull requests, code review and branching.', 'When a user asks how to structure PRs, reviews or branches.', ['productivity', 'code']),
    s('linear', 'Linear Issues', 'Manage Linear issues, projects and team workflows with automation.', 'When a user wants to create or organise Linear issues.', ['productivity']),
    s('gworkspace', 'Google Workspace CLI', 'Manage Google Drive, Sheets, Gmail and Calendar from the command line.', 'When a user wants to automate Google Workspace tasks.', ['productivity']),
    // ── AI / ML ──────────────────────────────────────────────────────────────────────
    s('hf-training', 'Hugging Face Training', 'Train models with SFT/DPO and export to GGUF.', 'When a user wants to fine-tune or train a model.', ['ai']),
    s('replicate', 'Replicate Models', 'Discover, compare and run AI models via the Replicate API.', 'When a user wants to run a hosted AI model.', ['ai']),
    s('falai-images', 'fal.ai Image Generation', 'Generate and edit images using fal.ai model endpoints.', 'When a user wants an image generated or edited by AI.', ['ai', 'design'], { inputModalities: ['image', 'text'] }),
    // ── Payments / integrations ──────────────────────────────────────────────────────
    s('stripe', 'Stripe Integration', 'Integrate Stripe payments and handle webhooks securely.', 'When a user wants to add payments or handle Stripe webhooks.', ['api']),
    s('composio', 'Composio Connector', 'Connect an AI agent to 1000+ external apps with managed auth.', 'When a user wants to connect an agent to many third-party apps.', ['integration']),
    // ── Databases / storage ──────────────────────────────────────────────────────────
    s('cosmosdb', 'Cosmos DB', 'Run NoSQL operations on Azure Cosmos DB with global distribution.', 'When a user works with Cosmos DB.', ['data']),
    s('azure-blob', 'Azure Blob Storage', 'Manage Azure Blob object storage — uploads, downloads and lifecycle.', 'When a user wants to store or fetch files in Azure Blob.', ['data', 'devops']),
    s('redis', 'Redis Cache', 'Use Redis for caching and session storage.', 'When a user wants to add caching or sessions with Redis.', ['data']),
    // ── Writing / docs ───────────────────────────────────────────────────────────────
    s('markdown-docs', 'Markdown Documentation', 'Write structured documentation in Markdown with proper hierarchy.', 'When a user wants clean project documentation written.', ['writing']),
  ];
}

/**
 * Real human messages — the messy, colloquial way people actually type. Gold = acceptable skill id(s).
 * Deliberately avoids restating the skill's keywords, so it tests meaning, not string overlap.
 */
export const REAL_WORLD_QUERIES: ReadonlyArray<{ query: string; gold: string[] }> = [
  { query: 'my nextjs site feels really sluggish, how do i speed it up', gold: ['nextjs'] },
  { query: 'can you fill in this application form i got as a pdf', gold: ['pdf'] },
  { query: 'turn these quarterly numbers into a spreadsheet with a chart', gold: ['xlsx'] },
  { query: 'i need a slide deck for the monday board meeting', gold: ['pptx'] },
  { query: 'draft me a word doc for the new hire offer letter', gold: ['docx'] },
  { query: 'write some browser tests that click through our checkout', gold: ['playwright', 'webapp-testing'] },
  { query: 'scan my repo for any passwords or api keys i left in the code', gold: ['insecure-defaults', 'security-review'] },
  { query: 'help me get a function live on cloudflare edge', gold: ['cloudflare-workers'] },
  { query: 'i want to add card payments to my checkout page', gold: ['stripe'] },
  { query: 'save this whole conversation into our team wiki', gold: ['notion-capture'] },
  { query: 'my postgres queries are crawling, whats wrong', gold: ['postgres'] },
  { query: 'spin up a little server so claude can talk to our internal api', gold: ['mcp-builder'] },
  { query: 'make our app run smoother on iphones, its a react native thing', gold: ['react-native'] },
  { query: 'set up an automated build and deploy on every push', gold: ['cicd'] },
  { query: 'i wanna generate some cool abstract artwork', gold: ['algorithmic-art', 'canvas-design'] },
  { query: 'containerise this app and push it somewhere', gold: ['docker'] },
  { query: 'review my code for security holes before we ship', gold: ['security-review', 'static-analysis'] },
  { query: 'write unit tests for this typescript module', gold: ['jest'] },
  { query: 'make a picture of a sunset over mountains', gold: ['falai-images'] },
  { query: 'i need infra as code for our aws setup', gold: ['terraform'] },
  { query: 'help me structure our pull request and review process', gold: ['github-workflow'] },
  { query: 'add caching so we stop hammering the database', gold: ['redis'] },
  { query: 'write up a status update for the whole company', gold: ['internal-comms'] },
  { query: 'build a small interactive dashboard i can open in a browser', gold: ['web-artifacts', 'frontend-design'] },
  { query: 'make it match our company colours and logo', gold: ['brand-guidelines'] },
  { query: 'create a bunch of linear tickets from this list of tasks', gold: ['linear'] },
  { query: 'query our azure logs to see what caused the outage', gold: ['azure-monitor'] },
  { query: 'i want to fine tune a small model on my dataset', gold: ['hf-training'] },
  { query: 'help me build a plugin for our wordpress site', gold: ['wordpress'] },
  { query: 'design a clean responsive landing page', gold: ['frontend-design'] },
  { query: 'i need to scaffold a brand new skill for our agent', gold: ['skill-creator'] },
  { query: 'write clear docs for this project in markdown', gold: ['markdown-docs'] },
];
