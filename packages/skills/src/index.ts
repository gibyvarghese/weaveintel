/**
 * @weaveintel/skills — Agent Skills capability
 *
 * Skills are reusable, named units of capability that agents can discover and
 * apply automatically.  Unlike tools (executable functions), a skill bundles:
 *
 *  - Trigger conditions  (when should the agent activate this skill?)
 *  - Step-by-step instructions  (injected as a system-prompt snippet)
 *  - Associated tool names  (tools to make available when the skill is active)
 *  - Examples  (few-shot demonstrations that guide the model)
 *
 * Design goals (informed by Anthropic's "Building Effective Agents" research):
 *  1. Simplicity — no embeddings, no heavy ML; pure pattern matching + priority.
 *  2. Composability — skills stack on top of any base system prompt.
 *  3. Discoverability — agents find skills from user messages automatically.
 *  4. Transparency — injected instructions are human-readable, not opaque.
 *
 * Typical flow:
 *   const registry = createSkillRegistry();
 *   registry.register(mySkill);
 *   const matches = registry.discover(userMessage, { maxSkills: 3 });
 *   const augmented = applySkillsToPrompt(baseSystemPrompt, matches);
 *   // pass augmented to the agent as its systemPrompt
 */

// ─── Types ────────────────────────────────────────────────────

export type SkillCategory =
  | 'retrieval'
  | 'computation'
  | 'communication'
  | 'data-processing'
  | 'planning'
  | 'analysis'
  | 'code'
  | 'web'
  | 'general';

/**
 * SkillDefinition — the core contract for a skill.
 *
 * Fields map 1-to-1 to the `skills` table in geneWeave so that skills can be
 * stored in the DB, loaded at runtime, and applied to agents automatically.
 */
export interface SkillDefinition {
  /** Unique identifier */
  readonly id: string;
  /** Short human-readable name shown in the admin UI */
  readonly name: string;
  /**
   * Description of what this skill does.  Shown in the admin UI and also
   * used as fallback for pattern matching when triggerPatterns is empty.
   */
  readonly description: string;
  /**
   * Broad functional category.  Used to filter skills by type and group
   * them in the admin UI.
   */
  readonly category: SkillCategory;
  /**
   * Phrases / intent signals that trigger this skill.
   * The discovery algorithm checks whether the user's message contains any of
   * these patterns (case-insensitive substring match).
   *
   * Good patterns are short, distinctive phrases:
   *   ["analyze", "chart", "trend", "data set"] — data analysis skill
   *   ["summarize", "tldr", "brief"] — summarization skill
   *   ["search the web", "look it up", "browse"] — web-research skill
   */
  readonly triggerPatterns: readonly string[];
  /**
   * System-prompt snippet injected when this skill is active.
   * Write it as if speaking to the agent:
   *   "When asked to analyze data, follow this procedure: ..."
   *
   * Best practices (Anthropic ACI guidelines):
   *   - Include step-by-step instructions
   *   - List edge cases and what NOT to do
   *   - Mention which tools to use and in what order
   *   - Keep under ~400 tokens to avoid drowning the base prompt
   */
  readonly instructions: string;
  /**
   * Tool names (from the agent's ToolRegistry) to make available when this
   * skill is active.  If empty/undefined, skill only injects instructions.
   */
  readonly toolNames?: readonly string[];
  /**
   * Optional few-shot examples.  These are appended to the instructions
   * block so the model sees concrete demonstrations.
   */
  readonly examples?: ReadonlyArray<{ readonly input: string; readonly output: string }>;
  /** Searchable tags for the admin UI and future semantic discovery. */
  readonly tags?: readonly string[];
  /**
   * Tie-breaking priority when multiple skills score the same.
   * Higher = preferred. Default 0.
   */
  readonly priority?: number;
  readonly version?: string;
  /** Only enabled skills participate in discovery. */
  readonly enabled?: boolean;
}

// ─── Discovery ────────────────────────────────────────────────

export interface SkillDiscoveryOptions {
  /** Maximum skills to return.  Default 3. */
  maxSkills?: number;
  /**
   * Minimum relevance score [0-1] to include a skill.
   * Default 0.1 — skills that match at least one pattern always qualify.
   */
  minScore?: number;
  /** Restrict discovery to these categories. */
  categories?: SkillCategory[];
}

/** A skill that was matched for a given user query. */
export interface SkillMatch {
  readonly skill: SkillDefinition;
  /** Normalized relevance score [0-1]. */
  readonly score: number;
  /** Which triggerPatterns were found in the query. */
  readonly matchedPatterns: readonly string[];
}

// ─── Registry ─────────────────────────────────────────────────

export interface SkillRegistry {
  /** Register a skill.  Replaces any existing skill with the same id. */
  register(skill: SkillDefinition): void;
  /** Remove a skill by id. */
  unregister(skillId: string): void;
  /** Get a skill by id. */
  get(skillId: string): SkillDefinition | undefined;
  /** List all registered skills (regardless of enabled flag). */
  list(): SkillDefinition[];
  /**
   * Discover skills relevant to a user message.
   *
   * Algorithm:
   *  1. Skip disabled skills.
   *  2. For each skill, count how many triggerPatterns appear in the query.
   *  3. score = (matchCount / totalPatterns) * (1 + priority * 0.05)
   *  4. Sort descending by score, then priority, then name (stable).
   *  5. Return top-maxSkills results with score >= minScore.
   */
  discover(query: string, opts?: SkillDiscoveryOptions): SkillMatch[];
}

export function createSkillRegistry(): SkillRegistry {
  const skills = new Map<string, SkillDefinition>();

  return {
    register(skill: SkillDefinition): void {
      skills.set(skill.id, skill);
    },

    unregister(skillId: string): void {
      skills.delete(skillId);
    },

    get(skillId: string): SkillDefinition | undefined {
      return skills.get(skillId);
    },

    list(): SkillDefinition[] {
      return Array.from(skills.values());
    },

    discover(query: string, opts?: SkillDiscoveryOptions): SkillMatch[] {
      const maxSkills = opts?.maxSkills ?? 3;
      const minScore = opts?.minScore ?? 0.1;
      const categories = opts?.categories;
      const lower = query.toLowerCase();

      const matches: SkillMatch[] = [];

      for (const skill of skills.values()) {
        if (skill.enabled === false) continue;
        if (categories && categories.length > 0 && !categories.includes(skill.category)) continue;

        const patterns = skill.triggerPatterns;
        const matched: string[] = [];

        // Also check description as a fallback signal
        const descLower = skill.description.toLowerCase();
        const isDescriptionMatch = descLower.split(' ').some(word => word.length > 4 && lower.includes(word));

        for (const pattern of patterns) {
          if (lower.includes(pattern.toLowerCase())) {
            matched.push(pattern);
          }
        }

        if (matched.length === 0 && !isDescriptionMatch) continue;

        // Score: pattern coverage + priority boost + description fallback
        const patternCoverage = patterns.length > 0 ? matched.length / patterns.length : 0;
        const descBonus = isDescriptionMatch && matched.length === 0 ? 0.1 : 0;
        const priorityBoost = (skill.priority ?? 0) * 0.05;
        const score = Math.min(1, patternCoverage + descBonus + priorityBoost);

        if (score >= minScore) {
          matches.push({ skill, score, matchedPatterns: matched });
        }
      }

      // Sort: score desc, then priority desc, then name asc (stable)
      matches.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const pa = a.skill.priority ?? 0;
        const pb = b.skill.priority ?? 0;
        if (pb !== pa) return pb - pa;
        return a.skill.name.localeCompare(b.skill.name);
      });

      return matches.slice(0, maxSkills);
    },
  };
}

// ─── Prompt injection ─────────────────────────────────────────

/**
 * Build a system-prompt block from a set of matched skills.
 * Returns an empty string when matches is empty.
 *
 * Format:
 *   ## Active Skills
 *
 *   ### <skill name>
 *   <instructions>
 *
 *   **Examples:**
 *   - Input: ...
 *     Output: ...
 */
export function buildSkillSystemPrompt(matches: SkillMatch[]): string {
  if (matches.length === 0) return '';

  const parts: string[] = ['## Active Skills\n'];

  for (const { skill } of matches) {
    parts.push(`### ${skill.name}`);
    parts.push(skill.instructions.trim());

    if (skill.examples && skill.examples.length > 0) {
      parts.push('\n**Examples:**');
      for (const ex of skill.examples) {
        parts.push(`- Input: ${ex.input}\n  Output: ${ex.output}`);
      }
    }

    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Augment a base system prompt with skill instructions.
 * Returns undefined when there are no skills and no base prompt.
 */
export function applySkillsToPrompt(
  basePrompt: string | undefined,
  matches: SkillMatch[],
): string | undefined {
  const skillBlock = buildSkillSystemPrompt(matches);
  if (!skillBlock && !basePrompt) return undefined;
  if (!skillBlock) return basePrompt;
  if (!basePrompt) return skillBlock;
  return `${basePrompt.trim()}\n\n${skillBlock}`;
}

/**
 * Return the unique set of tool names requested by matched skills.
 * The caller should make these tools available in the agent's ToolRegistry.
 */
export function collectSkillTools(matches: SkillMatch[]): string[] {
  const tools = new Set<string>();
  for (const { skill } of matches) {
    if (skill.toolNames) {
      for (const t of skill.toolNames) {
        tools.add(t);
      }
    }
  }
  return Array.from(tools);
}

// ─── Builder helper ───────────────────────────────────────────

/** Type-safe skill builder with sensible defaults. */
export function defineSkill(def: SkillDefinition): SkillDefinition {
  return {
    priority: 0,
    version: '1.0',
    enabled: true,
    ...def,
  };
}

// ─── DB row ↔ SkillDefinition conversion ─────────────────────

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  category: string;
  trigger_patterns: string;  // JSON string[]
  instructions: string;
  tool_names: string | null;  // JSON string[]
  examples: string | null;    // JSON array
  tags: string | null;        // JSON string[]
  priority: number;
  version: string;
  enabled: number;            // SQLite boolean (0|1)
  created_at: string;
  updated_at: string;
}

export function skillFromRow(row: SkillRow): SkillDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category as SkillCategory,
    triggerPatterns: safeParseArray(row.trigger_patterns),
    instructions: row.instructions,
    toolNames: row.tool_names ? safeParseArray(row.tool_names) : undefined,
    examples: row.examples ? JSON.parse(row.examples) : undefined,
    tags: row.tags ? safeParseArray(row.tags) : undefined,
    priority: row.priority,
    version: row.version,
    enabled: !!row.enabled,
  };
}

function safeParseArray(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─── Built-in seed skills ─────────────────────────────────────

/**
 * A curated set of built-in skills covering common agent use cases.
 * These can be seeded into the DB via the admin UI "Seed Defaults" button.
 *
 * Based on research from:
 *   - Anthropic "Building Effective Agents" (Dec 2024)
 *   - OpenAI Agents SDK tool patterns
 *   - Common enterprise AI assistant use cases
 */
export const BUILT_IN_SKILLS: SkillDefinition[] = [
  defineSkill({
    id: 'skill-data-analysis',
    name: 'Data Analysis',
    description: 'Analyze structured data, compute statistics, identify trends and anomalies',
    category: 'analysis',
    priority: 10,
    triggerPatterns: [
      'analyze', 'analysis', 'data', 'dataset', 'csv', 'table',
      'trend', 'statistics', 'statistical', 'average', 'sum', 'total',
      'chart', 'graph', 'visualize', 'breakdown',
    ],
    instructions: `When asked to analyze data, follow this procedure:
1. **Understand the data** — identify column types, value ranges, and missing values before computing anything.
2. **Compute descriptive statistics** — count, mean, median, min, max, standard deviation where relevant.
3. **Identify trends** — look for patterns over time, groupings, or correlations.
4. **Highlight anomalies** — flag values that are statistical outliers (> 2 standard deviations from mean).
5. **Summarize findings** — lead with the most important insight, then supporting details.
6. **Cite numbers precisely** — always include the actual values, not just relative terms like "high" or "low".

Do NOT:
- Guess values not present in the data.
- Present analysis as definitive if the data is incomplete.
- Skip showing sample calculations that justify your conclusions.`,
    toolNames: ['calculator'],
    examples: [
      {
        input: 'Analyze this sales CSV: Month,Revenue\nJan,10000\nFeb,12000\nMar,9500',
        output: 'Revenue ranges from $9,500 (Mar) to $12,000 (Feb), mean $10,500. Feb outperformed by 14.3%. Mar dipped 20.8% below Feb — warrants investigation.',
      },
    ],
    tags: ['data', 'statistics', 'csv', 'charts'],
  }),

  defineSkill({
    id: 'skill-web-research',
    name: 'Web Research',
    description: 'Search the web, synthesize information from multiple sources, cite references',
    category: 'web',
    priority: 8,
    triggerPatterns: [
      'search', 'look up', 'find', 'what is', 'who is', 'latest', 'current',
      'news', 'recent', 'browse', 'research', 'online', 'web',
    ],
    instructions: `When performing web research:
1. **Plan your searches** — break the question into 2-3 targeted search queries before searching.
2. **Triangulate sources** — verify key facts across at least 2 independent sources.
3. **Prefer authoritative sources** — official documentation, peer-reviewed papers, reputable news outlets.
4. **State the date** — always note when information was retrieved.
5. **Cite inline** — include source URLs or site names next to each fact.
6. **Flag uncertainty** — if sources conflict, say so explicitly and explain the disagreement.
7. **Summarize clearly** — lead with the direct answer, then supporting context.

Do NOT:
- Present a single source as definitive proof.
- Make up URLs or fabricate citations.
- Present outdated information without noting the date.`,
    toolNames: ['web_search', 'web_browse'],
    examples: [
      {
        input: 'What is the current interest rate set by the Federal Reserve?',
        output: 'Based on Federal Reserve official communications (federalreserve.gov, retrieved today), the federal funds rate target range is currently X%-X%. [cite source]',
      },
    ],
    tags: ['search', 'web', 'research', 'citations'],
  }),

  defineSkill({
    id: 'skill-code-review',
    name: 'Code Review',
    description: 'Review code for bugs, security issues, performance problems, and style',
    category: 'code',
    priority: 9,
    triggerPatterns: [
      'review', 'code', 'bug', 'security', 'vulnerability', 'performance',
      'refactor', 'improve', 'function', 'class', 'optimize', 'fix', 'debug',
    ],
    instructions: `When reviewing code, evaluate these dimensions in order:

1. **Correctness** — Does the code do what it claims? Are there off-by-one errors, null pointer risks, or logic gaps?
2. **Security** — Check for: injection (SQL, command, path traversal), hardcoded secrets, improper auth, insecure deserialization, missing input validation (OWASP Top 10).
3. **Performance** — Identify O(n²) algorithms, unnecessary DB queries in loops, memory leaks, blocking I/O in async paths.
4. **Readability** — Flag unclear variable names, missing error handling, functions > 50 lines.
5. **Tests** — Note missing test coverage for edge cases.

Format your response as:
- 🔴 **Critical** — must fix before deployment
- 🟡 **Warning** — should fix soon
- 🟢 **Suggestion** — nice to have

Always explain WHY each issue matters, not just WHAT is wrong.`,
    tags: ['code', 'security', 'review', 'bugs'],
  }),

  defineSkill({
    id: 'skill-document-summary',
    name: 'Document Summarization',
    description: 'Summarize long documents, extract key points, create structured briefs',
    category: 'analysis',
    priority: 7,
    triggerPatterns: [
      'summarize', 'summary', 'tldr', 'brief', 'key points', 'extract',
      'main points', 'highlights', 'overview', 'outline',
    ],
    instructions: `When summarizing documents:
1. **Read completely** — do not summarize based on the first paragraph alone.
2. **Identify the core thesis** — what is the single most important claim or conclusion?
3. **Extract key supporting points** — typically 3-7 bullet points that substantiate the thesis.
4. **Note action items** — if the document contains tasks, deadlines, or decisions, list them separately.
5. **Preserve nuance** — do not strip away important qualifications (e.g., "only applies to X").
6. **Scale to length** — for documents < 1 page: 3-5 sentences. For > 5 pages: structured sections.

Format:
**TL;DR:** [1-2 sentence core thesis]
**Key Points:** [bulleted list]
**Action Items:** [if any]`,
    tags: ['summary', 'documents', 'extraction', 'briefs'],
  }),

  defineSkill({
    id: 'skill-email-drafting',
    name: 'Email Drafting',
    description: 'Draft professional emails with appropriate tone, structure, and clarity',
    category: 'communication',
    priority: 6,
    triggerPatterns: [
      'email', 'write', 'draft', 'compose', 'message', 'reply', 'respond',
      'follow up', 'professional', 'formal', 'letter',
    ],
    instructions: `When drafting emails:
1. **Clarify the goal** — what single action do you want the reader to take?
2. **Choose the right tone** — formal (board, legal, external clients), semi-formal (colleagues), casual (close teammates).
3. **Structure: Subject → Opening → Body → Call-to-action → Closing**
   - Subject: specific, < 60 characters, no ALL CAPS
   - Opening: acknowledge context if it's a reply
   - Body: one paragraph per topic, no walls of text
   - Call-to-action: one clear ask, with a deadline if relevant
   - Closing: appropriate sign-off for the tone
4. **Be concise** — cut any sentence that doesn't serve the goal.
5. **Proofread mentally** — check for ambiguity, typos, and unintended tone.

Provide subject line, body, and sign-off separately so the user can mix and match.`,
    tags: ['email', 'communication', 'writing', 'professional'],
  }),

  defineSkill({
    id: 'skill-planning',
    name: 'Planning & Decomposition',
    description: 'Break complex tasks into steps, create actionable plans, sequence dependencies',
    category: 'planning',
    priority: 7,
    triggerPatterns: [
      'plan', 'planning', 'how to', 'steps', 'roadmap', 'strategy',
      'approach', 'organize', 'schedule', 'prioritize', 'break down',
    ],
    instructions: `When creating plans:
1. **Clarify the end goal** — what does "done" look like? What are the acceptance criteria?
2. **Identify dependencies** — which steps must happen before others?
3. **Break into atomic tasks** — each task should be completable in one sitting with a clear deliverable.
4. **Assign estimates** — add rough time estimates (hours/days) to each task.
5. **Flag risks** — note blockers, assumptions, and things that could go wrong.
6. **Sequence properly** — order tasks to deliver value early (parallelizable tasks, critical path).

Format as a numbered list with sub-tasks indented. Include a brief "success criteria" section at the end.`,
    tags: ['planning', 'tasks', 'roadmap', 'strategy'],
  }),

  defineSkill({
    id: 'skill-translation',
    name: 'Translation',
    description: 'Translate text between languages with cultural nuance and accuracy',
    category: 'communication',
    priority: 5,
    triggerPatterns: [
      'translate', 'translation', 'in spanish', 'in french', 'in german',
      'in chinese', 'in japanese', 'in arabic', 'in portuguese', 'into',
    ],
    instructions: `When translating:
1. **Identify source language** — if not specified, identify it first.
2. **Translate meaning, not words** — use natural idioms in the target language; avoid literal word-for-word translation.
3. **Preserve tone** — if the source is formal, the translation must be formal; if casual, casual.
4. **Flag cultural nuances** — note when a phrase has no direct equivalent or could be misunderstood.
5. **Offer alternatives** — for ambiguous phrases, provide 2 translation options with brief explanations.
6. **Validate proper nouns** — do not translate names, brands, or technical terms unless standard translations exist.`,
    tags: ['translation', 'languages', 'localization'],
  }),

  defineSkill({
    id: 'skill-sql-query',
    name: 'SQL Query Writing',
    description: 'Write, explain, and optimize SQL queries for relational databases',
    category: 'data-processing',
    priority: 8,
    triggerPatterns: [
      'sql', 'query', 'database', 'select', 'join', 'table', 'db',
      'fetch', 'records', 'filter', 'aggregate', 'group by',
    ],
    instructions: `When writing SQL queries:
1. **Understand the schema** — ask for table/column names if not provided.
2. **Write readable SQL** — use UPPERCASE keywords, consistent indentation, aliases for long table names.
3. **Optimize for performance**:
   - Filter early (WHERE before JOIN where possible)
   - Avoid SELECT * in production queries
   - Use indexes — note which columns should be indexed
   - Avoid N+1 patterns; prefer JOINs or CTEs
4. **Handle NULLs explicitly** — use IS NULL / IS NOT NULL, COALESCE where appropriate.
5. **Explain the query** — add a brief comment block describing what it does and why.
6. **Security** — never concatenate user input into queries; use parameterized queries.

Always test edge cases: empty results, NULL values, duplicate rows.`,
    tags: ['sql', 'database', 'queries', 'optimization'],
  }),

  defineSkill({
    id: 'skill-api-design',
    name: 'API Design',
    description: 'Design RESTful or GraphQL APIs with proper resource modeling, status codes, and docs',
    category: 'code',
    priority: 6,
    triggerPatterns: [
      'api', 'endpoint', 'rest', 'graphql', 'route', 'http', 'design',
      'schema', 'request', 'response', 'json',
    ],
    instructions: `When designing APIs:
1. **Resource modeling** — use nouns for resource paths (/users, /orders), not verbs.
2. **HTTP methods** — GET (read), POST (create), PUT (replace), PATCH (partial update), DELETE.
3. **Status codes** — 200 OK, 201 Created, 204 No Content, 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 409 Conflict, 422 Unprocessable, 500 Internal Error.
4. **Consistent response shape** — use a standard envelope: { data, error, meta }.
5. **Versioning** — prefix routes with /v1/ for public APIs.
6. **Security** — require auth on all mutating endpoints; validate all inputs; rate-limit public endpoints.
7. **Pagination** — use cursor-based pagination for large collections.
8. **Documentation** — provide OpenAPI/Swagger snippet for each endpoint.`,
    tags: ['api', 'rest', 'design', 'http'],
  }),

  defineSkill({
    id: 'skill-debugging',
    name: 'Debugging',
    description: 'Systematically debug errors, trace stack traces, identify root causes',
    category: 'code',
    priority: 9,
    triggerPatterns: [
      'error', 'exception', 'crash', 'failed', 'broken', 'bug', 'debug',
      'issue', 'problem', 'not working', 'stack trace', 'undefined', 'null',
    ],
    instructions: `When debugging:
1. **Read the full error message** — parse the error type, message, and stack trace before guessing.
2. **Reproduce first** — identify the minimal input that triggers the bug.
3. **Form a hypothesis** — state what you think is wrong before looking at code.
4. **Isolate the failure** — binary-search through the code: which function fails?
5. **Check the data** — inspect the actual values at the point of failure; assumptions about data types or shape are the most common bug source.
6. **Fix root cause, not symptoms** — don't mask errors with try/catch without understanding why they occur.
7. **Verify the fix** — confirm the original error is gone AND that no regression was introduced.

Provide: (a) root cause diagnosis, (b) fix, (c) how to prevent recurrence.`,
    tags: ['debug', 'errors', 'troubleshooting', 'bugs'],
  }),

  defineSkill({
    id: 'skill-nz-statistics',
    name: 'New Zealand Statistics (Stats NZ)',
    description: 'Query official New Zealand statistics from the Stats NZ Aotearoa Data Explorer (ADE) — population, census, GDP, trade, housing, labour, agriculture, and more',
    category: 'retrieval',
    priority: 10,
    triggerPatterns: [
      'stats nz', 'statsnz', 'new zealand', 'nz statistics', 'nz data',
      'aotearoa', 'aotearoa data explorer', 'census', 'population',
      'gdp', 'trade', 'housing', 'labour', 'employment', 'unemployment',
      'inflation', 'cpi', 'immigration', 'tourism', 'agriculture',
      'maori', 'pacific', 'ethnicity', 'birth', 'death', 'mortality',
      'education', 'income', 'household', 'dwelling', 'poverty',
      'regional', 'auckland', 'wellington', 'canterbury', 'waikato',
      'dataflow', 'sdmx',
    ],
    instructions: `When answering questions about New Zealand statistics, follow this procedure:

1. **Identify the dataset** — use statsnz_search_dataflows to find the relevant dataflow by keyword. If the user is vague, search for 2-3 plausible terms (e.g. "population", "census", "dwelling").
2. **Get dataset structure** — call statsnz_get_dataflow_info to understand the dataset's dimensions and available breakdowns (e.g. age, sex, region, year).
3. **Check available values** — if the user requests a specific region or year, call statsnz_get_codelist for the relevant dimension to confirm the code exists.
4. **Fetch the data** — call statsnz_get_data with the correct key filter. Use dimension codes (not labels) in the key. Use "all" for dimensions you don't need to filter.
5. **Present results clearly** — include the dataset name, reference period, actual numeric values, and units. If showing a time series, present as a table.
6. **Cite the source** — always attribute data to "Stats NZ, Aotearoa Data Explorer" with the dataflow ID.

CRITICAL:
- Always use statsnz_get_dataflow_info BEFORE statsnz_get_data — you need the dimension order to construct the key.
- Dimension keys are dot-separated positional filters matching DSD order (e.g. "6050.1.2018").
- Use "all" as the key to retrieve unfiltered data if the dataset is small.
- If the API returns an error, check that dimension codes are valid via statsnz_get_codelist.
- Stats NZ data is authoritative government data — treat it as a primary source.`,
    toolNames: [
      'statsnz_list_dataflows',
      'statsnz_search_dataflows',
      'statsnz_get_dataflow_info',
      'statsnz_get_datastructure',
      'statsnz_get_structure',
      'statsnz_get_actualconstraint',
      'statsnz_get_codelist',
      'statsnz_get_data',
    ],
    examples: [
      {
        input: 'What is the population of New Zealand by region?',
        output: 'I searched Stats NZ ADE for "population" and found the "Subnational Population Estimates" dataflow. Auckland has 1.7M, Wellington 543K, Canterbury 645K (2023 estimate). Source: Stats NZ, Aotearoa Data Explorer (DPE_POP_001).',
      },
      {
        input: 'Show me NZ GDP growth over the last 5 years',
        output: 'From the "Gross Domestic Product" dataflow (SNA_GDP_001): 2019: 3.1%, 2020: -1.1%, 2021: 5.4%, 2022: 2.4%, 2023: 0.9%. Source: Stats NZ, Aotearoa Data Explorer.',
      },
    ],
    tags: ['statistics', 'new-zealand', 'government', 'census', 'population', 'economics', 'sdmx'],
  }),
];
