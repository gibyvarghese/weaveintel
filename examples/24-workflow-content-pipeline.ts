/**
 * Example 24 — Content Publishing Intelligence Pipeline
 *
 * Exercises every workflow step type in a single end-to-end flow, then
 * wires a supervisor agent (weaveAgent + workers) on top.
 *
 * Step types in content-pipeline workflow:
 *   deterministic  — validate, enrich, type enrichment, quality, dist-prep
 *   parallel       — simultaneous sentiment + entity + SEO (named lanes)
 *   forEach        — normalise each tag (__forEachItem / __forEachIndex)
 *   switch         — route to breaking / feature / evergreen enrichment
 *   condition      — JSONLogic quality gate (qualityScore >= 75)
 *   loop           — iterate editors, score each (__loopItem)
 *   branch         — choose distribution channel (truthy → digital, falsy → print)
 *   fork           — concurrent analytics + compliance + archive audit
 *   join           — aggregate fork results
 *   human-task     — pause for editorial review when quality fails
 *   wait           — compliance hold (durable pause before publish)
 *
 * ┌─ Scenario A ──────────────────────────────────────────────────────────┐
 * │  4 articles: 3 good (pause at compliance-hold) + 1 draft (pauses at  │
 * │  human-task). Verifies every step type fires on the correct path.    │
 * └───────────────────────────────────────────────────────────────────────┘
 * ┌─ Scenario B ──────────────────────────────────────────────────────────┐
 * │  weaveAgent supervisor with 3 workers (pipeline, analytics, strategy)│
 * │  produces an editorial brief across all pending articles.            │
 * └───────────────────────────────────────────────────────────────────────┘
 * ┌─ Scenario C ──────────────────────────────────────────────────────────┐
 * │  batch-pipeline parent workflow uses forEach to process all articles  │
 * │  and aggregates quality statistics via a script step.                │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Run:  npx tsx examples/24-workflow-content-pipeline.ts
 */

import 'dotenv/config';
import {
  DefaultWorkflowEngine,
  HandlerResolverRegistry,
  InMemorySpanEmitter,
  createNoopResolver,
  createScriptResolver,
  createToolResolver,
} from '@weaveintel/workflows';
import type { WorkflowDefinition } from '@weaveintel/core';
import { weaveContext, weaveTool, weaveToolRegistry } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';

// ── Helpers ───────────────────────────────────────────────────────────────

function header(t: string) {
  console.log(`\n${'═'.repeat(74)}\n  ${t}\n${'═'.repeat(74)}`);
}
function sub(t: string)  { console.log(`\n  ── ${t}`); }
function ok(m: string)   { console.log(`  ✓ ${m}`); }
function info(m: string) { console.log(`  → ${m}`); }
function fail(m: string) { console.log(`  ✗ ${m}`); throw new Error(m); }

// ── Domain types ──────────────────────────────────────────────────────────

interface Article {
  id: string;
  title: string;
  content: string;
  authorId: string;
  contentType: 'breaking' | 'feature' | 'evergreen';
  topics: string[];
  tags: string[];
  region: 'global' | 'us' | 'emea' | 'apac';
}

interface Editor {
  id: string;
  name: string;
  specializations: string[];
  experience: number;
  available: boolean;
}

// ── Static data ───────────────────────────────────────────────────────────

const ARTICLE_DB: Record<string, Article> = {
  'news-001': {
    id: 'news-001',
    title: 'Central Bank Raises Rates 75bps — Biggest Hike Since 1994',
    content:
      'The central bank delivered its largest rate increase in three decades, lifting the benchmark by 75 basis points to combat inflation at a 40-year high. ' +
      'The unanimous decision signals policymakers will accept slower growth to restore price stability. ' +
      'Consumer prices rose 9.1 percent over the past year, the highest reading since 1981. ' +
      'Analysts expect further hikes: some project the terminal rate reaching 4 percent by early next year. ' +
      'Mortgage rates have surged past 6 percent, cooling a housing market that saw double-digit price gains. ' +
      'Corporate treasurers are revising capital plans as borrowing costs climb; small-business confidence surveys signal growing concern. ' +
      'Historically, the full impact of tighter monetary policy takes 12 to 18 months to materialise in the real economy. ' +
      'Global equity markets fell sharply on the news, with rate-sensitive technology stocks leading the decline. ' +
      'Emerging-market central banks face additional pressure as dollar strength tightens their own financial conditions. ' +
      'The next policy meeting is in six weeks; officials have signalled additional increases remain on the table.',
    authorId: 'author-alex',
    contentType: 'breaking',
    topics: ['finance', 'markets', 'economy'],
    tags: ['central-bank', 'interest-rates', 'inflation', 'monetary-policy'],
    region: 'global',
  },
  'feature-001': {
    id: 'feature-001',
    title: 'How Precision Agriculture Is Feeding a Hungry Planet',
    content:
      'On a farm in rural Iowa, sensors buried six inches underground transmit soil-moisture readings every 15 minutes to a dashboard on the farmer\'s phone. ' +
      'Overhead, autonomous drones capture multispectral images that machine-learning models parse for early fungal disease. ' +
      'Welcome to precision agriculture, a quiet revolution rewriting the economics of food production. ' +
      'Adoption has accelerated since 2020 as hardware costs dropped and 5G connectivity reached rural areas. ' +
      'Companies including CropX, Trimble and John Deere offer integrated platforms combining GPS-guided machinery, AI advisory tools and real-time weather modelling. ' +
      'Results are striking: pilot farms cut water use by 30 percent, reduced pesticide application by a quarter and raised yields 12 to 18 percent on average. ' +
      'Climate scientists argue precision methods are critical to reducing agriculture\'s 20-percent share of global greenhouse emissions. ' +
      'Critics warn that data ownership and algorithmic opacity could disadvantage smallholders lacking capital to adopt these platforms. ' +
      'Researchers at MIT are building open-source alternatives designed for subsistence farmers in the developing world. ' +
      'If scaled successfully, the technology could close yield gaps that today contribute to chronic food insecurity in sub-Saharan Africa and South Asia.',
    authorId: 'author-sam',
    contentType: 'feature',
    topics: ['technology', 'agriculture', 'ai', 'sustainability'],
    tags: ['Precision-Agriculture', 'AI', 'Drones', 'food-tech', 'sustainability'],
    region: 'global',
  },
  'evergreen-001': {
    id: 'evergreen-001',
    title: 'The Seven Habits of Highly Effective Engineering Managers',
    content:
      'Engineering management is among the most demanding transitions in the technology industry. ' +
      'Skills that made you an excellent individual contributor rarely map directly to what makes a great manager. ' +
      'After interviewing dozens of engineering leaders at companies from early-stage startups to Fortune 500 firms, a consistent set of practices emerges. ' +
      'Effective managers treat one-on-ones as sacred: weekly sessions focused on the direct report\'s growth, blockers and wellbeing, never on project status. ' +
      'They write clear, time-bound goals that connect individual work to company-level strategy, making the reasoning explicit. ' +
      'Candid, specific feedback is given early and often rather than saved for annual reviews, which are too infrequent to change behaviour. ' +
      'Building psychological safety is essential so that team members speak up about problems before they escalate into incidents. ' +
      'Effective managers also protect focus time by triaging meetings ruthlessly and setting explicit quiet hours. ' +
      'Maintaining technical depth matters: reading architecture decision records, reviewing pull requests and attending design discussions lets them ask good questions. ' +
      'Finally, they celebrate learning from failure as vocally as celebrating wins, reinforcing a growth culture that attracts and retains strong engineers.',
    authorId: 'author-jordan',
    contentType: 'evergreen',
    topics: ['leadership', 'engineering', 'management'],
    tags: ['Leadership', 'Management', 'engineering', 'career', 'productivity'],
    region: 'us',
  },
  'draft-001': {
    id: 'draft-001',
    title: 'stuff',
    content: 'stuff is here.',
    authorId: 'author-intern',
    contentType: 'feature',
    topics: ['misc'],
    tags: ['misc'],
    region: 'us',
  },
};

const EDITOR_DB: Editor[] = [
  { id: 'ed-1', name: 'Alice Chen',  specializations: ['finance', 'markets', 'economy'],      experience: 8,  available: true  },
  { id: 'ed-2', name: 'Bob Park',    specializations: ['technology', 'ai', 'agriculture'],     experience: 5,  available: true  },
  { id: 'ed-3', name: 'Carol Diaz',  specializations: ['leadership', 'engineering', 'career'], experience: 10, available: true  },
  { id: 'ed-4', name: 'Dan Wu',      specializations: ['environment', 'science', 'health'],    experience: 6,  available: false },
  { id: 'ed-5', name: 'Eva Stone',   specializations: ['finance', 'tech', 'sustainability'],   experience: 7,  available: true  },
];

const TAG_CANON: Record<string, string> = {
  'central-bank':          'monetary-policy',
  'interest-rates':        'monetary-policy',
  'inflation':             'economics',
  'monetary-policy':       'monetary-policy',
  'Precision-Agriculture': 'precision-agriculture',
  'AI':                    'ai',
  'Drones':                'drones',
  'food-tech':             'food-technology',
  'sustainability':        'sustainability',
  'Leadership':            'leadership',
  'Management':            'leadership',
  'engineering':           'engineering',
  'career':                'professional-development',
  'productivity':          'productivity',
  'misc':                  'uncategorized',
};

// ── Tool implementations ──────────────────────────────────────────────────

type ToolFn = (input: Record<string, unknown>) => Promise<unknown>;

// Deterministic metadata enrichment
const enrichArticleTool: ToolFn = async (input) => {
  const article = input['article'] as Article;
  const words   = article.content.trim().split(/\s+/).length;
  const readingTimeMin = Math.max(1, Math.round(words / 200));
  const sentences = article.content.split(/[.!?]+/).filter(Boolean).length;
  const avgWPS    = words / Math.max(1, sentences);
  const avgWLen   = article.content.replace(/\W/g, '').length / Math.max(1, words);
  let readabilityScore = Math.round(Math.max(10, Math.min(100,
    100 - (avgWPS - 12) * 1.5 - (avgWLen - 4.5) * 8,
  )));
  // Short-content penalty: less than 50 words → cap at words*2
  if (words < 50) readabilityScore = Math.min(readabilityScore, Math.max(10, words * 2));
  return { wordCount: words, readingTimeMin, readabilityScore, characterCount: article.content.length };
};

// Parallel lane 1 — sentiment
const sentimentTool: ToolFn = async (input) => {
  const article = input['article'] as Article;
  const text    = (article.title + ' ' + article.content).toLowerCase();
  const pos = ['advance', 'success', 'effective', 'improve', 'innovative', 'rewarding', 'benefit', 'growth'].filter(w => text.includes(w)).length;
  const neg = ['crash', 'crisis', 'decline', 'warn', 'fail', 'risk', 'concern', 'fall'].filter(w => text.includes(w)).length;
  const total = pos + neg;
  const polarity = total === 0 ? 0.5 : pos / total;
  return { label: polarity > 0.6 ? 'positive' : polarity < 0.4 ? 'negative' : 'neutral', polarity, positiveSignals: pos, negativeSignals: neg };
};

// Parallel lane 2 — entity extraction
const entityExtractionTool: ToolFn = async (input) => {
  const article = input['article'] as Article;
  const caps    = (article.content.match(/[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/g) ?? []).slice(0, 8);
  return {
    people:        caps.filter(e => e.split(' ').length === 2).slice(0, 3),
    organizations: caps.filter(e => e.split(' ').length === 1).slice(0, 4),
    locations:     [],
    entityCount:   caps.length,
  };
};

// Parallel lane 3 — SEO
const seoScoreTool: ToolFn = async (input) => {
  const article  = input['article'] as Article;
  const words    = article.content.split(/\s+/).length;
  const titleLen = article.title.length;
  const tagCount = article.tags.length;
  const wordScore  = words < 50 ? 20 : words < 100 ? 45 : words < 300 ? 65 : 90;
  const titleScore = titleLen < 20 || titleLen > 70 ? 55 : 90;
  const tagScore   = Math.min(100, tagCount * 20);
  return {
    seoScore:    Math.round(wordScore * 0.5 + titleScore * 0.3 + tagScore * 0.2),
    wordCount:   words,
    suggestions: [
      ...(words < 300   ? ['Expand content to 300+ words'] : []),
      ...(tagCount < 3  ? ['Add more tags'] : []),
      ...(titleLen > 70 ? ['Shorten title'] : []),
    ],
  };
};

// forEach handler — returns the tags array for iteration
const getTagsTool: ToolFn = async (input) => {
  const article = input['article'] as Article;
  return article.tags;
};

// forEach body — normalises one tag (__forEachItem / __forEachIndex injected by engine)
const normalizeTagTool: ToolFn = async (input) => {
  const raw = input['__forEachItem'] as string;
  const idx = input['__forEachIndex'] as number;
  return { original: raw, canonical: TAG_CANON[raw] ?? raw.toLowerCase().replace(/\s+/g, '-'), position: idx };
};

// Switch handler — returns content type string (case key)
const classifyTypeTool: ToolFn = async (input) => {
  return (input['article'] as Article).contentType;
};

// Type-specific enrichment tools
const breakingEnrichTool: ToolFn = async (input) => ({
  urgencyScore:    95,
  breakingPriority:'P1',
  pushAlert:       true,
  headline:        ((input['article'] as Article).title).slice(0, 60),
});

const featureEnrichTool: ToolFn = async (input) => {
  const words = (input['article'] as Article).content.split(/\s+/).length;
  return { seriesId: null, longformScore: Math.min(100, Math.round(words / 2)), authorBioNeeded: true };
};

const evergreenEnrichTool: ToolFn = async () => ({
  longevityScore:     88,
  updateScheduleDays: 180,
  evergreen:          true,
  refreshTriggers:    ['new data', 'annual review'],
});

// Quality scoring — word-count anchored so scores are deterministic
// wordCount >= 100 → base 80; < 50 → base 5; readability/SEO are adjustments
const qualityScoreTool: ToolFn = async (input) => {
  const wordCount   = (input['wordCount'] as number) ?? 0;
  const readability = (input['readabilityScore'] as number) ?? 50;
  // analysis is the full __step_scan-parallel object: { sentiment, entities, seo }
  const analysis    = (input['analysisResults'] as Record<string, unknown>) ?? {};
  const seo         = (analysis['seo'] as Record<string, unknown>) ?? {};
  const seoScore    = (seo['seoScore'] as number) ?? 50;

  const wordBase = wordCount >= 100 ? 80 : wordCount >= 50 ? 55 : wordCount >= 10 ? 30 : 5;
  const readAdj  = Math.round((readability - 50) * 0.20);
  const seoAdj   = Math.round((seoScore    - 50) * 0.10);
  const qualityScore = Math.min(100, Math.max(0, wordBase + readAdj + seoAdj));
  const qualityLabel = qualityScore >= 85 ? 'excellent' : qualityScore >= 75 ? 'good' : qualityScore >= 55 ? 'fair' : 'poor';
  return { qualityScore, qualityLabel, components: { wordCount, readability, seoScore } };
};

// Loop handler — returns eligible editors for this article
const getEligibleEditorsTool: ToolFn = async (input) => {
  const article  = input['article'] as Article;
  const eligible = EDITOR_DB.filter(ed =>
    ed.available && ed.specializations.some(s => article.topics.includes(s)),
  );
  return eligible.length > 0 ? eligible : EDITOR_DB.filter(e => e.available);
};

// Loop BODY handler — scores one editor for fit.
// Registered directly on the engine (loop body handlers are not auto-resolved
// in resolveHandlersForRun; only forEach body handlers are).
const scoreEditorFitFn = async (vars: Record<string, unknown>) => {
  const editor  = vars['__loopItem'] as Editor;
  const article = vars['article']    as Article;
  const matches = editor.specializations.filter(s => article.topics.includes(s)).length;
  return { editorId: editor.id, editorName: editor.name, fitScore: matches * 25 + editor.experience * 5, topicMatches: matches };
};

// Branch handler — truthy → digital (index 0), falsy → print (index 1)
const selectChannelTool: ToolFn = async (input) => {
  return (input['article'] as Article).region === 'global';
};

// Distribution prep tools
const digitalPrepTool: ToolFn = async (input) => ({
  channel: 'digital', format: 'html',
  cdnPath: `/content/${(input['article'] as Article).id}`,
  ampEnabled: (input['article'] as Article).contentType === 'breaking',
});

const printPrepTool: ToolFn = async (input) => ({
  channel: 'print', format: 'pdf',
  pageCount: Math.ceil(((input['wordCount'] as number) ?? 300) / 400),
  layout: (input['article'] as Article).contentType === 'evergreen' ? 'magazine' : 'newspaper',
});

// Fork branch tools — each receives { ...variables, __forkBranch: name }
const auditAnalyticsTool: ToolFn = async (input) => ({
  type: 'analytics', articleId: (input['article'] as Article).id,
  predictedViews: (input['article'] as Article).contentType === 'breaking' ? 50_000 : 10_000,
  engagementTier: 'high',
});
const auditComplianceTool: ToolFn = async (input) => ({
  type: 'compliance', articleId: (input['article'] as Article).id,
  gdprCheck: 'passed', copyrightCheck: 'passed',
  disclaimer: (input['article'] as Article).topics.includes('finance') ? 'financial-advice-notice' : null,
});
const auditArchiveTool: ToolFn = async (input) => ({
  type: 'archive', articleId: (input['article'] as Article).id,
  storageKey: `archive/${new Date().getFullYear()}/${(input['article'] as Article).id}`,
  compressed: true,
});

// ── Tool registry ─────────────────────────────────────────────────────────

const TOOLS: Record<string, ToolFn> = {
  'enrich-article':       enrichArticleTool,
  'sentiment':            sentimentTool,
  'entities':             entityExtractionTool,
  'seo':                  seoScoreTool,
  'get-tags':             getTagsTool,
  'normalize-tag':        normalizeTagTool,
  'classify-type':        classifyTypeTool,
  'breaking-enrich':      breakingEnrichTool,
  'feature-enrich':       featureEnrichTool,
  'evergreen-enrich':     evergreenEnrichTool,
  'quality-score':        qualityScoreTool,
  'get-eligible-editors': getEligibleEditorsTool,
  'select-channel':       selectChannelTool,
  'digital-prep':         digitalPrepTool,
  'print-prep':           printPrepTool,
  'audit-analytics':      auditAnalyticsTool,
  'audit-compliance':     auditComplianceTool,
  'audit-archive':        auditArchiveTool,
};

// ── Workflow definition ───────────────────────────────────────────────────
//
// IMPORTANT — outputMap mechanics:
//   outputMap only reliably writes variables when the step has a direct
//   handler (deterministic, switch, branch). For parallel / forEach / fork /
//   join / loop, the outputMap would be applied to the *main* handler result
//   (items array / lane results), not the final step composite result.
//   Those steps store their composite result as variables.__step_{id}, which
//   subsequent steps read via inputMap paths like '__step_scan-parallel'.

const contentPipelineWorkflow: WorkflowDefinition = {
  id:          'content-pipeline',
  name:        'Content Publishing Pipeline',
  version:     '1.0.0',
  entryStepId: 'validate',
  steps: [

    // ── 1. Validate (deterministic / script) ─────────────────────────
    {
      id: 'validate', name: 'Validate Article',
      type: 'deterministic' as const, handler: 'script:validate',
      config: {
        script: `
          const a = variables.article;
          if (!a || !a.id || !a.title || !a.content || !a.authorId)
            throw new Error('Article missing required fields');
          if (a.content.trim().split(/\\s+/).length < 3)
            throw new Error('Content too short');
          return { valid: true, articleId: a.id };
        `,
      },
      next: 'enrich',
    },

    // ── 2. Enrich metadata (deterministic / tool) ─────────────────────
    {
      id: 'enrich', name: 'Enrich Metadata',
      type: 'deterministic' as const, handler: 'tool:enrich-article',
      inputMap:  { article: 'article' },
      outputMap: { wordCount: 'wordCount', readingTimeMin: 'readingTimeMin', readabilityScore: 'readabilityScore' },
      next: 'scan-parallel',
    },

    // ── 3. Parallel analysis (named lanes) ────────────────────────────
    // Each lane handler receives the full variables (article is in scope).
    // Result stored as variables.__step_scan-parallel = { sentiment, entities, seo }.
    // No outputMap here — read via __step_scan-parallel in compute-quality.
    {
      id: 'scan-parallel', name: 'Parallel Content Analysis',
      type: 'parallel' as const,
      config: { lanes: { sentiment: 'tool:sentiment', entities: 'tool:entities', seo: 'tool:seo' } },
      next: 'normalize-tags',
    },

    // ── 4. forEach — normalise tags ───────────────────────────────────
    // Main handler returns tags array; body handler normalises each tag.
    // Result stored as variables.__step_normalize-tags = { count, results[], broke }.
    {
      id: 'normalize-tags', name: 'Normalise Tags',
      type: 'forEach' as const, handler: 'tool:get-tags',
      inputMap: { article: 'article' },
      config: { bodyHandler: 'tool:normalize-tag', maxConcurrency: 2 },
      next: 'route-type',
    },

    // ── 5. Switch — route to type-specific enrichment ─────────────────
    {
      id: 'route-type', name: 'Route by Content Type',
      type: 'switch' as const, handler: 'tool:classify-type',
      inputMap:  { article: 'article' },
      outputMap: { contentType: '' },
      config: { cases: { breaking: 'enrich-breaking', feature: 'enrich-feature', evergreen: 'enrich-evergreen' } },
    },

    // ── 6a-c. Type-specific enrichment (each routes to compute-quality) ─
    {
      id: 'enrich-breaking', name: 'Breaking News Enrichment',
      type: 'deterministic' as const, handler: 'tool:breaking-enrich',
      inputMap:  { article: 'article' },
      outputMap: { contentMeta: '' },
      next: 'compute-quality',
    },
    {
      id: 'enrich-feature', name: 'Feature Article Enrichment',
      type: 'deterministic' as const, handler: 'tool:feature-enrich',
      inputMap:  { article: 'article' },
      outputMap: { contentMeta: '' },
      next: 'compute-quality',
    },
    {
      id: 'enrich-evergreen', name: 'Evergreen Content Enrichment',
      type: 'deterministic' as const, handler: 'tool:evergreen-enrich',
      inputMap:  { article: 'article' },
      outputMap: { contentMeta: '' },
      next: 'compute-quality',
    },

    // ── 7. Quality score (deterministic / tool) ───────────────────────
    // Reads __step_scan-parallel for analysis data (parallel step result).
    {
      id: 'compute-quality', name: 'Compute Quality Score',
      type: 'deterministic' as const, handler: 'tool:quality-score',
      inputMap: {
        wordCount:       'wordCount',
        readabilityScore:'readabilityScore',
        analysisResults: '__step_scan-parallel',
      },
      outputMap: { qualityScore: 'qualityScore', qualityLabel: 'qualityLabel' },
      next: 'quality-gate',
    },

    // ── 8. Condition — quality gate (JSONLogic expression) ────────────
    // true  (score >= 75) → index 0 → assign-editors
    // false (score <  75) → index 1 → request-review
    {
      id: 'quality-gate', name: 'Quality Gate',
      type: 'condition' as const,
      config: { expression: { '>=': [{ var: 'qualityScore' }, 75] } },
      next: ['assign-editors', 'request-review'],
    },

    // ── 9a. Human-task — editorial review (pauses workflow) ───────────
    {
      id: 'request-review', name: 'Request Editorial Review',
      type: 'human-task' as const,
      config: { taskType: 'review', title: 'Quality Review Required', priority: 'high' },
    },

    // ── 9b. Loop — score each eligible editor ─────────────────────────
    // Main handler returns editors[]; body (registered directly on engine)
    // scores each editor. Result: variables.__step_assign-editors = { count, results[] }.
    {
      id: 'assign-editors', name: 'Score & Assign Editors',
      type: 'loop' as const, handler: 'tool:get-eligible-editors',
      inputMap: { article: 'article' },
      config: { bodyHandler: 'tool:score-editor-fit' },
      next: 'select-channel',
    },

    // ── 10. Branch — pick distribution channel ────────────────────────
    // truthy → index 0 → prepare-digital
    // falsy  → index 1 → prepare-print
    {
      id: 'select-channel', name: 'Select Distribution Channel',
      type: 'branch' as const, handler: 'tool:select-channel',
      inputMap: { article: 'article' },
      next: ['prepare-digital', 'prepare-print'],
    },

    // ── 11a-b. Distribution prep (each routes to audit-fork) ──────────
    {
      id: 'prepare-digital', name: 'Prepare Digital Distribution',
      type: 'deterministic' as const, handler: 'tool:digital-prep',
      inputMap:  { article: 'article' },
      outputMap: { distributionPackage: '' },
      next: 'audit-fork',
    },
    {
      id: 'prepare-print', name: 'Prepare Print Distribution',
      type: 'deterministic' as const, handler: 'tool:print-prep',
      inputMap:  { article: 'article', wordCount: 'wordCount' },
      outputMap: { distributionPackage: '' },
      next: 'audit-fork',
    },

    // ── 12. Fork — concurrent audit branches ──────────────────────────
    // Result: variables.__step_audit-fork = { analytics, compliance, archive }.
    {
      id: 'audit-fork', name: 'Parallel Audit (Fork)',
      type: 'fork' as const,
      config: { branches: { analytics: 'tool:audit-analytics', compliance: 'tool:audit-compliance', archive: 'tool:audit-archive' } },
      next: 'audit-join',
    },

    // ── 13. Join — aggregate fork results ─────────────────────────────
    // Reads __step_audit-fork and returns it directly.
    // Result: variables.__step_audit-join = { analytics, compliance, archive }.
    {
      id: 'audit-join', name: 'Aggregate Audit Results (Join)',
      type: 'join' as const,
      config: { forkStepId: 'audit-fork' },
      next: 'compliance-hold',
    },

    // ── 14. Wait — compliance hold (pauses workflow) ──────────────────
    {
      id: 'compliance-hold', name: 'Compliance Hold',
      type: 'wait' as const,
      // In production set wakeAfterMs for durable auto-resume.
      // In this demo the engine pauses: run.status === 'paused'.
    },
  ],
};

// ── Batch pipeline workflow ───────────────────────────────────────────────

const batchPipelineWorkflow: WorkflowDefinition = {
  id:          'batch-pipeline',
  name:        'Batch Article Processing',
  version:     '1.0.0',
  entryStepId: 'init-batch',
  steps: [
    {
      id: 'init-batch', name: 'Initialise Batch',
      type: 'deterministic' as const, handler: 'script:init-batch',
      config: {
        script: `
          if (!Array.isArray(variables.articleIds) || variables.articleIds.length === 0)
            throw new Error('articleIds array required');
          return { batchSize: variables.articleIds.length, startedAt: new Date().toISOString() };
        `,
      },
      next: 'process-articles',
    },
    {
      id: 'process-articles', name: 'Process Each Article (forEach)',
      type: 'forEach' as const, handler: 'tool:get-article-ids',
      config: { bodyHandler: 'tool:run-article-pipeline', maxConcurrency: 1 },
      next: 'aggregate-stats',
    },
    {
      id: 'aggregate-stats', name: 'Aggregate Batch Statistics',
      type: 'deterministic' as const, handler: 'script:aggregate-stats',
      config: {
        script: `
          const results = variables['__step_process-articles']?.results || [];
          const passed  = results.filter(r => r.passed);
          const failed  = results.filter(r => !r.passed);
          return {
            total:            results.length,
            passCount:        passed.length,
            failCount:        failed.length,
            avgQualityScore:  passed.length > 0 ? Math.round(passed.reduce((s, r) => s + r.qualityScore, 0) / passed.length) : 0,
            passRate:         Math.round(passed.length / Math.max(1, results.length) * 100),
            failedArticles:   failed.map(r => r.articleId),
          };
        `,
      },
      outputMap: { batchStats: '' },
    },
  ],
};

// ── Engine factory ────────────────────────────────────────────────────────

function buildEngine(): DefaultWorkflowEngine {
  const registry = new HandlerResolverRegistry();
  registry.register(createNoopResolver());
  registry.register(createScriptResolver());
  registry.register(createToolResolver({ async getTool(k) { return TOOLS[k]; } }));

  const engine = new DefaultWorkflowEngine({
    resolverRegistry: registry,
    spanEmitter:      new InMemorySpanEmitter(),
  });

  // Loop body handler must be registered directly — loop body handlers are
  // NOT added to toResolve in resolveHandlersForRun (only forEach body
  // handlers, fork branches, and parallel lanes are).
  engine.registerHandler('tool:score-editor-fit', scoreEditorFitFn);

  return engine;
}

// ═════════════════════════════════════════════════════════════════════════
//  Scenario A — Direct workflow: 4 articles, every step type fires
// ═════════════════════════════════════════════════════════════════════════

async function scenarioA() {
  header('Scenario A — content-pipeline: All Step Types, 4 Articles');

  const engine = buildEngine();
  await engine.createDefinition(contentPipelineWorkflow);

  const cases = [
    { id: 'news-001',     label: 'Breaking news  (global → digital)', expectPauseAt: 'compliance-hold', expectEnrich: 'enrich-breaking',  expectChannel: 'prepare-digital' },
    { id: 'feature-001',  label: 'Feature article (global → digital)', expectPauseAt: 'compliance-hold', expectEnrich: 'enrich-feature',   expectChannel: 'prepare-digital' },
    { id: 'evergreen-001',label: 'Evergreen       (us → print)',        expectPauseAt: 'compliance-hold', expectEnrich: 'enrich-evergreen', expectChannel: 'prepare-print'   },
    { id: 'draft-001',    label: 'Draft           (fails quality gate)', expectPauseAt: 'request-review', expectEnrich: 'enrich-feature',   expectChannel: null              },
  ];

  for (const { id, label, expectPauseAt, expectEnrich, expectChannel } of cases) {
    sub(label);
    const run   = await engine.startRun('content-pipeline', { article: ARTICLE_DB[id] });
    const vars  = run.state.variables as Record<string, unknown>;
    const steps = run.state.history.map(h => h.stepId);

    if (run.status !== 'paused') fail(`Expected status paused, got "${run.status}": ${run.error}`);
    if (run.state.currentStepId !== expectPauseAt) {
      fail(`Expected pause at "${expectPauseAt}", paused at "${run.state.currentStepId}"`);
    }
    ok(`Paused at: ${expectPauseAt}`);

    // ── deterministic: enrich metadata ───────────────────────────────
    const wc = vars['wordCount'] as number;
    if (!wc || wc < 1) fail('wordCount not written by enrich step');
    ok(`Deterministic enrich: wordCount=${wc}, readability=${vars['readabilityScore']}`);

    // ── parallel: scan-parallel ───────────────────────────────────────
    const analysis = vars['__step_scan-parallel'] as Record<string, unknown>;
    if (!analysis?.['sentiment'] || !analysis?.['entities'] || !analysis?.['seo']) {
      fail('Parallel named lanes incomplete — missing sentiment/entities/seo');
    }
    const sLabel = (analysis['sentiment'] as Record<string,unknown>)['label'];
    const seoS   = (analysis['seo']       as Record<string,unknown>)['seoScore'];
    ok(`Parallel (3 named lanes): sentiment=${sLabel}, seo=${seoS}`);

    // ── forEach: normalize-tags ───────────────────────────────────────
    const freach = vars['__step_normalize-tags'] as Record<string, unknown>;
    const normTags = (freach?.['results'] as Array<Record<string,unknown>>) ?? [];
    if (normTags.length === 0) fail('forEach normalize-tags produced no results');
    ok(`forEach normalised ${normTags.length} tags: "${normTags[0]?.['original']}" → "${normTags[0]?.['canonical']}"`);

    // ── switch: route-type ────────────────────────────────────────────
    if (!steps.includes(expectEnrich)) fail(`Switch should route to "${expectEnrich}"`);
    ok(`Switch routed to: ${expectEnrich} (contentType="${vars['contentType']}")`);

    // ── quality gate ──────────────────────────────────────────────────
    const qs = vars['qualityScore'] as number;
    ok(`Quality score: ${qs} (${vars['qualityLabel']}) — ${qs >= 75 ? 'PASS' : 'FAIL'}`);
    if (id === 'draft-001' && qs >= 75)  fail(`draft-001 should fail gate (got ${qs})`);
    if (id !== 'draft-001' && qs <  75)  fail(`${id} should pass gate (got ${qs})`);

    if (expectChannel) {
      // ── loop: assign-editors ─────────────────────────────────────────
      const loopOut = vars['__step_assign-editors'] as Record<string, unknown>;
      const editors = (loopOut?.['results'] as Array<Record<string,unknown>>) ?? [];
      if (editors.length === 0) fail('Loop assign-editors produced no results');
      const topEd = editors.sort((a,b) => (b['fitScore'] as number) - (a['fitScore'] as number))[0];
      ok(`Loop: ${editors.length} editor(s) scored — top: ${topEd?.['editorName']} (fit ${topEd?.['fitScore']})`);

      // ── branch: select-channel ────────────────────────────────────────
      if (!steps.includes(expectChannel)) fail(`Branch should select "${expectChannel}"`);
      const pkg = vars['distributionPackage'] as Record<string, unknown>;
      ok(`Branch → ${pkg?.['channel']} / ${pkg?.['format']}`);

      // ── fork/join: audit ──────────────────────────────────────────────
      const forkOut = vars['__step_audit-fork'] as Record<string, unknown>;
      if (!forkOut?.['analytics'] || !forkOut?.['compliance'] || !forkOut?.['archive']) {
        fail('Fork 3 branches incomplete');
      }
      const joinOut = vars['__step_audit-join'] as Record<string, unknown>;
      if (!joinOut?.['compliance']) fail('Join did not aggregate fork results');
      const comp = joinOut['compliance'] as Record<string, unknown>;
      ok(`Fork/join: 3 branches — compliance gdpr=${comp['gdprCheck']}, archive=${!(joinOut['archive'] as Record<string,unknown>)?.['compressed'] ? 'uncompressed' : 'compressed'}`);
    }

    info(`Steps: ${steps.join(' → ')}`);
  }

  ok('All 4 articles processed; all 11 step types triggered');
}

// ═════════════════════════════════════════════════════════════════════════
//  Scenario B — Supervisor agent with 3 specialist workers
// ═════════════════════════════════════════════════════════════════════════

async function scenarioB() {
  header('Scenario B — Supervisor Agent (3 workers: pipeline, analytics, strategy)');

  const engine = buildEngine();
  await engine.createDefinition(contentPipelineWorkflow);

  // pipeline-worker tools
  const pipelineTools = weaveToolRegistry();
  pipelineTools.register(weaveTool({
    name: 'run_pipeline',
    description: 'Run the full content-pipeline workflow for a single article. Returns quality score, label, channel, and pause point.',
    parameters: {
      type: 'object',
      properties: { articleId: { type: 'string', description: 'Article ID to process' } },
      required: ['articleId'],
    },
    execute: async (args: { articleId: string }) => {
      const article = ARTICLE_DB[args.articleId];
      if (!article) return JSON.stringify({ error: `Unknown article: ${args.articleId}` });
      const run  = await engine.startRun('content-pipeline', { article });
      const vars = run.state.variables as Record<string, unknown>;
      return JSON.stringify({
        articleId:    args.articleId,
        title:        article.title.slice(0, 55),
        status:       run.status,
        pausePoint:   run.state.currentStepId,
        qualityScore: vars['qualityScore'],
        qualityLabel: vars['qualityLabel'],
        contentType:  vars['contentType'],
        wordCount:    vars['wordCount'],
        channel:      (vars['distributionPackage'] as Record<string,unknown>)?.['channel'] ?? 'pending-review',
      });
    },
  }));

  pipelineTools.register(weaveTool({
    name: 'list_articles',
    description: 'Return all article IDs in the system.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => JSON.stringify({ articleIds: Object.keys(ARTICLE_DB) }),
  }));

  // analytics-worker tools
  const analyticsTools = weaveToolRegistry();
  analyticsTools.register(weaveTool({
    name: 'quality_distribution',
    description: 'Run the pipeline for ALL articles and return a full quality report.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: async () => {
      const rows = [];
      for (const [id, article] of Object.entries(ARTICLE_DB)) {
        const run  = await engine.startRun('content-pipeline', { article });
        const vars = run.state.variables as Record<string, unknown>;
        const qs   = (vars['qualityScore'] as number) ?? 0;
        rows.push({ articleId: id, title: article.title.slice(0,45), qualityScore: qs, passed: qs >= 75, contentType: article.contentType });
      }
      rows.sort((a, b) => b.qualityScore - a.qualityScore);
      return JSON.stringify({
        total:    rows.length,
        passed:   rows.filter(r => r.passed).length,
        failed:   rows.filter(r => !r.passed).length,
        avgScore: Math.round(rows.reduce((s,r) => s + r.qualityScore, 0) / rows.length),
        articles: rows,
      });
    },
  }));

  const workerModel = weaveAnthropicModel('claude-haiku-4-5-20251001');

  const supervisor = weaveAgent({
    name:  'editorial-supervisor',
    model: weaveAnthropicModel('claude-haiku-4-5-20251001'),
    workers: [
      {
        name:        'pipeline-worker',
        description: 'Runs the content-pipeline for individual articles, or lists available article IDs.',
        model:       workerModel,
        tools:       pipelineTools,
      },
      {
        name:        'analytics-worker',
        description: 'Runs the pipeline for all articles at once and returns quality distribution statistics.',
        model:       workerModel,
        tools:       analyticsTools,
      },
      {
        name:        'strategy-worker',
        description: 'Editorial strategy expert. Provide this worker with raw data and it will generate publishing priorities, quality improvement advice, and a content calendar recommendation.',
        model:       workerModel,
      },
    ],
    systemPrompt: 'You are the Editorial Supervisor AI for a digital news platform. Coordinate your workers to deliver a clear editorial brief covering article readiness, quality issues, and publishing priorities.',
    maxSteps: 20,
  });

  const ctx    = weaveContext({ userId: 'editorial-director' });
  const result = await supervisor.run(ctx, {
    messages: [{
      role:    'user',
      content: 'Give me today\'s editorial brief: which articles are ready to publish, which need review, quality scores for each, and what our publishing priorities should be.',
    }],
  });

  info('Supervisor brief:');
  console.log('\n' + result.output.split('\n').map((l: string) => `    ${l}`).join('\n'));
  ok(`Supervisor completed in ${result.steps.length} steps`);
}

// ═════════════════════════════════════════════════════════════════════════
//  Scenario C — Batch forEach orchestration workflow
// ═════════════════════════════════════════════════════════════════════════

async function scenarioC() {
  header('Scenario C — batch-pipeline: forEach Orchestration + Script Aggregation');

  // Child engine handles the individual content-pipeline runs
  const childEngine = buildEngine();
  await childEngine.createDefinition(contentPipelineWorkflow);

  // Batch-specific tools
  const batchTools: Record<string, ToolFn> = {
    'get-article-ids': async (input) => {
      return (input['articleIds'] as string[]) ?? Object.keys(ARTICLE_DB);
    },
    'run-article-pipeline': async (input) => {
      const articleId = input['__forEachItem'] as string;
      const article   = ARTICLE_DB[articleId];
      if (!article) return { articleId, error: 'not found', passed: false, qualityScore: 0 };
      const run  = await childEngine.startRun('content-pipeline', { article });
      const vars = run.state.variables as Record<string, unknown>;
      const qs   = (vars['qualityScore'] as number) ?? 0;
      return {
        articleId,
        title:        article.title.slice(0, 40),
        qualityScore: qs,
        qualityLabel: vars['qualityLabel'],
        passed:       qs >= 75,
        contentType:  article.contentType,
        channel:      (vars['distributionPackage'] as Record<string,unknown>)?.['channel'] ?? 'pending-review',
        pausePoint:   run.state.currentStepId,
      };
    },
  };

  const batchRegistry = new HandlerResolverRegistry();
  batchRegistry.register(createNoopResolver());
  batchRegistry.register(createScriptResolver());
  batchRegistry.register(createToolResolver({ async getTool(k) { return batchTools[k]; } }));

  const batchEngine = new DefaultWorkflowEngine({
    resolverRegistry: batchRegistry,
    spanEmitter:      new InMemorySpanEmitter(),
  });
  await batchEngine.createDefinition(batchPipelineWorkflow);

  const run = await batchEngine.startRun('batch-pipeline', {
    articleIds: Object.keys(ARTICLE_DB),
  });

  if (run.status !== 'completed') fail(`Batch pipeline failed: ${run.error ?? '(unknown)'}`);

  const vars    = run.state.variables as Record<string, unknown>;
  const stats   = vars['batchStats']  as Record<string, unknown>;
  const rawRows = (vars['__step_process-articles'] as Record<string,unknown>)?.['results'] as Array<Record<string,unknown>>;

  ok(`Batch pipeline completed — ${stats['total']} articles processed`);
  sub('Quality report:');
  info(`Pass rate: ${stats['passCount']}/${stats['total']} (${stats['passRate']}%)  avg quality: ${stats['avgQualityScore']}`);
  if ((stats['failCount'] as number) > 0) {
    info(`Needs review: ${(stats['failedArticles'] as string[]).join(', ')}`);
  }

  sub('Per-article results:');
  for (const r of rawRows) {
    const icon = r['passed'] ? '✓' : '✗';
    info(`  ${icon} ${r['articleId']}  quality=${r['qualityScore']} (${r['qualityLabel']})  channel=${r['channel']}`);
  }

  // Assertions
  if (!((stats['failedArticles'] as string[]).includes('draft-001'))) {
    fail('draft-001 should be in failedArticles');
  }
  if ((stats['passCount'] as number) < 3) fail(`Expected ≥3 passing articles, got ${stats['passCount']}`);
  if (rawRows.length !== Object.keys(ARTICLE_DB).length) {
    fail(`forEach result count mismatch: expected ${Object.keys(ARTICLE_DB).length}, got ${rawRows.length}`);
  }
  ok(`forEach processed all ${rawRows.length} articles (maxConcurrency=1)`);

  const stepIds = run.state.history.map(h => h.stepId);
  if (!stepIds.includes('init-batch') || !stepIds.includes('process-articles') || !stepIds.includes('aggregate-stats')) {
    fail('Not all batch-pipeline steps executed');
  }
  ok(`Batch steps: ${stepIds.join(' → ')}`);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  Content Publishing Intelligence Pipeline');
  console.log('  Example 24 — All Workflow Step Types + Supervisor Agent\n');
  try {
    await scenarioA();
    await scenarioB();
    await scenarioC();
    header('All scenarios completed successfully');
  } catch (err) {
    console.error('\n  FATAL:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
