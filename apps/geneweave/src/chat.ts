/**
 * @weaveintel/geneweave — Chat engine
 *
 * Orchestrates weaveIntel models for chat. Supports three modes:
 *  - **direct**: model.generate / model.stream (default, original behavior)
 *  - **agent**: weaveAgent with tool-calling ReAct loop
 *  - **supervisor**: weaveSupervisor with hierarchical worker delegation
 *
 * Integrates redaction (PII scrubbing), observability (trace spans),
 * and eval (response quality assertions) into the message flow.
 *
 * WeaveIntel packages integrated here:
 *   @weaveintel/core         — ExecutionContext, EventBus, Model/ToolRegistry types
 *   @weaveintel/agents       — weaveAgent (ReAct loop) and weaveSupervisor
 *   @weaveintel/observability — weaveInMemoryTracer, weaveUsageTracker for spans
 *   @weaveintel/redaction     — weaveRedactor for PII scrubbing before/after LLM
 *   @weaveintel/evals         — weaveEvalRunner for response quality assertions
 *   @weaveintel/guardrails    — createGuardrailPipeline, risk classification
 *   @weaveintel/human-tasks   — PolicyEvaluator for automatic human-review triggers
 *   @weaveintel/prompts       — shared prompt record parsing + variable-substituted rendering
 *   @weaveintel/routing       — SmartModelRouter, ModelHealthTracker
 *   @weaveintel/cache         — weaveInMemoryCacheStore, semantic cache for responses
 */

import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type {
  Model, ModelRequest, ModelResponse, StreamChunk, ExecutionContext, Message,
  ToolRegistry, AgentStepEvent, AgentStep, AgentResult, EventBus,
  Guardrail, GuardrailResult, GuardrailStage,
} from '@weaveintel/core';
import { weaveContext, weaveEventBus, EventTypes } from '@weaveintel/core';
import { weaveAgent, weaveSupervisor } from '@weaveintel/agents';
import { weaveInMemoryTracer, weaveUsageTracker } from '@weaveintel/observability';
import { weaveRedactor } from '@weaveintel/redaction';
import { weaveEvalRunner } from '@weaveintel/evals';
import { createGuardrailPipeline, hasDeny, hasWarning, getDenyReason, summarizeGuardrailResults, type GuardrailCategorySummary } from '@weaveintel/guardrails';
import type { DatabaseAdapter, MessageRow, ChatSettingsRow, GuardrailRow, HumanTaskPolicyRow, PromptRow, RoutingPolicyRow } from './db.js';
import { createToolRegistry, type ToolRegistryOptions } from './tools.js';
import { createTemporalStore } from './temporal-store.js';
import { PolicyEvaluator, createPolicy } from '@weaveintel/human-tasks';
import {
  createPromptVersionFromRecord,
  createTemplate,
  executePromptRecord,
  resolveFragments,
  InMemoryFragmentRegistry,
  InMemoryPromptStrategyRegistry,
  fragmentFromRecord,
  strategyFromRecord,
  defaultPromptStrategyRegistry,
  resolvePromptRecordForExecution,
  contractFromRecord,
  validateContract,
  InMemoryContractRegistry,
  type ContractValidationResult,
  type PromptRecordExecutionResult,
} from '@weaveintel/prompts';
import {
  applySkillsToPrompt,
  collectSkillTools,
  createSkillRegistry,
  skillFromRow,
  type SkillMatch,
} from '@weaveintel/skills';
import { createContract, DefaultCompletionValidator } from '@weaveintel/contracts';
import { SmartModelRouter, ModelHealthTracker } from '@weaveintel/routing';
import type { ModelCostInfo, ModelQualityInfo } from '@weaveintel/routing';
import { weaveInMemoryCacheStore } from '@weaveintel/cache';
import { weaveCacheKeyBuilder } from '@weaveintel/cache';
import { shouldBypass, resolvePolicy } from '@weaveintel/cache';
import type { CachePolicy } from '@weaveintel/core';
import { runHybridMemoryExtraction, type ExtractedEntity, type MemoryExtractionRule } from '@weaveintel/memory';
import { createEnterpriseTools, createEnterpriseToolGroups, ServiceNowProvider, type EnterpriseConnectorConfig, type EnterpriseToolGroup } from '@weaveintel/tools-enterprise';
import { normalizePersona } from './rbac.js';

export interface ChatAttachment {
  name: string;
  mimeType: string;
  size: number;
  dataBase64?: string;
  transcript?: string;
}

const TEMPORAL_TOOL_POLICY = [
  'Temporal Tool Usage Policy:',
  '- When asked about current day/date/time, current timestamp, or timezone-dependent time, do not guess.',
  '- You MUST call datetime and/or timezone_info before answering.',
  '- Use tool outputs as the source of truth for temporal answers.',
  '- If timezone is missing, use available context and state assumptions explicitly.',
  '',
  'Timer and Stopwatch Tool Usage Policy:',
  '- When asked to "start a timer", "start a stopwatch", "begin timing", or anything that requires tracking elapsed time:',
  '  • ALWAYS call `stopwatch_start` (not just `datetime`). Return the full JSON including the stopwatch `id`.',
  '  • The caller needs the stopwatch ID to later stop it and check elapsed time.',
  '- When asked to "stop the timer", "check elapsed time", or "how long did it take":',
  '  • First call `timer_list` and check for active timers. If none, check for active stopwatches.',
  '  • Call `stopwatch_stop` (or `timer_stop`) with the appropriate ID.',
  '  • Always report `elapsedMs` converted to human-readable format (minutes and seconds).',
  '- NEVER calculate elapsed time from raw timestamps or message content — use the stopwatch/timer tools.',
].join('\n');

const SUPERVISOR_CODE_EXECUTION_POLICY = [
  'You have direct access to `cse_run_code` — a tool that executes code in a real isolated Docker container.',
  'Execution strategy by task type:',
  '- Simple code-run requests (no attached dataset): call `cse_run_code` directly from supervisor.',
  '- Dataset/file analysis requests (attachments, CSV/JSON/XLSX, or "analyze this file"): delegate to `code_executor` first, then to `analyst` for result verification.',
  '- Data retrieval + code analysis requests (user asks to fetch data from a specialist AND run code/Python on it): use SEQUENTIAL multi-worker delegation — (1) delegate to the data specialist worker first to retrieve the data, (2) then delegate to `code_executor` with the retrieved data embedded in the task description so it can write and execute the analysis script. Do NOT synthesize the final response until code_executor returns actual stdout.',
  '',
  'Attachment handling policy:',
  '- Attached files are injected into container workspace and should be opened by filename.',
  '- For CSV analysis, prefer Python standard library (`csv`) first.',
  '- Do not assume `pandas` is installed unless you install it in the same run and verify installation succeeded.',
  '- If you need to install Python packages during execution, call `cse_run_code` with `networkAccess=true`.',
  '- In CSE, install packages with: `os.makedirs("/workspace/.deps", exist_ok=True); os.makedirs("/workspace/.tmp", exist_ok=True); subprocess.check_call([sys.executable, "-m", "pip", "install", "--target", "/workspace/.deps", "<package>"]); sys.path.insert(0, "/workspace/.deps")`.',
  '- For matplotlib/pyplot, always call `matplotlib.use("Agg")` before `import matplotlib.pyplot as plt` (headless environment, no display).',
  '- When saving chart images, create the output directory first: `os.makedirs("/workspace/output", exist_ok=True)` then save to `/workspace/output/<name>.png`.',
  '- Never use notebook-style `!pip install ...` inside Python scripts.',
  '',
  'Verification and retry policy (MANDATORY):',
  '- Verify tool outputs before final response.',
  '- If tool execution fails (import/file/path/runtime errors), send it back to code_executor with the exact stderr and a corrected plan.',
  '- Continue iterate->run->verify until success or clear environmental blocker is proven.',
  '- For successful analyses, final response must include computed metrics and concise insights grounded in execution stdout.',
  '',
  'Example: "write a Python script to add 15 numbers and run it"',
  '  → Write the script, then call: cse_run_code(code="...", language="python")',
  '  → Include the actual stdout in your final response.',
  '',
  'Supported languages: python, javascript, typescript, bash.',
].join('\n');

const POLICY_PROMPT_SUPERVISOR_CODE_EXECUTION = 'Runtime: Supervisor Code Execution Policy';
const POLICY_PROMPT_SUPERVISOR_TEMPORAL = 'Runtime: Supervisor Temporal Policy';
const POLICY_PROMPT_RESPONSE_CARD_FORMAT = 'Runtime: Response Card Format Policy';
const POLICY_PROMPT_MULTI_WORKER_PIPELINE = 'Runtime: Multi Worker Sequential Pipeline';
const POLICY_PROMPT_ENTERPRISE_WORKER_SYSTEM = 'Runtime: Enterprise ServiceNow Worker System Prompt';
const POLICY_PROMPT_FORCED_WORKER_REQUIREMENT = 'Runtime: Forced Worker Data Analysis Requirement';
const POLICY_PROMPT_HARD_EXECUTION_GUARD = 'Runtime: Hard Execution Guard';

const FORCED_WORKER_REQUIREMENT = 'WORKFLOW REQUIREMENT: This request requires actual code execution. Delegate to code_executor to generate and run Python in container against attached files and/or retrieved tool data. If execution fails, retry with corrected code. After successful execution, delegate to analyst to verify computed outputs and produce at least 3 concrete insights.';

const HARD_EXECUTION_GUARD_POLICY = [
  'HARD EXECUTION GUARD: The answer is invalid unless you explicitly call delegate_to_worker(worker="code_executor") and produce a successful cse_run_code execution. Do not execute code directly in supervisor for this workflow. Delegate to code_executor, run code successfully, verify output, then respond.',
  '',
  'HARD PRESENTATION GUARD: Do not reference sandbox filesystem paths like /workspace/output/*.png or return img_path values that point to container files. If charts are requested, return renderable structured JSON with chart labels/values and optional table data instead of local file paths. If a prior run produced blank or incomplete insights, fix the script and rerun until the computed insights are non-empty.',
].join('\n');

const ENTERPRISE_WORKER_SYSTEM_PROMPT = [
  'You are a specialized ServiceNow agent for: {{description}}',
  'Use the available tools to fulfill the user\'s request. Always use the most specific tool available rather than generic query/get when possible.',
].join('\n');

const RESPONSE_CARD_FORMAT_POLICY = [
  'RESPONSE PRESENTATION POLICY (for rich response cards):',
  '- Choose output format based on user intent and data shape.',
  '- If user asks for a chart, graph, visualization, trend, or numeric comparison, prefer structured JSON with chart fields.',
  '- If user asks for tabular output, dataset rows, or comparisons, prefer structured JSON with table fields.',
  '- If user asks for both, include both table and chart.',
  '- Never reference sandbox-only file paths such as /workspace/output/*.png or return img_path values that point to local container files.',
  '- If charts are requested, translate computed results into renderable chart labels/values in JSON instead of markdown images pointing to local files.',
  '- For code or scripts, return JSON object: {"code":"...","language":"python|javascript|typescript|sql|bash|json|xml|yaml"}.',
  '- For normal conversational answers, use concise markdown text and do not force JSON.',
  '',
  'Preferred structured schema when visualization or tabular output is requested:',
  '{',
  '  "summary": "short narrative",',
  '  "table": { "headers": ["col1","col2"], "rows": [["r1", 10], ["r2", 12]] },',
  '  "chart": { "type": "bar|line", "title": "optional", "labels": ["r1","r2"], "values": [10,12], "unit": "optional" }',
  '}',
  '- Keep values accurate and grounded in computed or tool-derived outputs.',
].join('\n');

const SUPERVISOR_TEMPORAL_POLICY = [
  'TEMPORAL QUESTION HANDLING (CRITICAL):',
  '- If the user asks about current day/date/time/timestamp or anything time-dependent:',
  '  • ALWAYS delegate to a worker that has datetime/timezone tools',
  '  • Do NOT answer from your training data or memory',
  '  • Always use `think` tool first to reason about what worker you need',
  '  • Always use `plan` tool to decompose the request',
  '  • After the worker responds, use `think` with reasoning_phase="reasoning" to verify the answer',
  '  • Then formulate your response based on the worker\'s actual tool outputs',
  '- Examples of temporal questions that MUST be delegated:',
  '  • "What day is today?" / "What date is it?" / "What is today\'s date?"',
  '  • "What time is it?" / "What is the current time?"',
  '  • "What timezone am I in?" / "What is the timezone?"',
  '  • Any question about current timestamp, current date, current time, or today',
  '',
  'TIMER AND STOPWATCH MANAGEMENT (CRITICAL):',
  '- When the user asks to START a timer or stopwatch (e.g. "start a timer", "start timing", "begin stopwatch"):',
  '  • Delegate to analyst with EXPLICIT goal: "Use the `stopwatch_start` tool to start a stopwatch labeled \'[context label]\'. Return the full JSON response including the stopwatch ID."',
  '  • Do NOT ask the analyst to just "capture the current timestamp" — it MUST call `stopwatch_start`',
  '  • After analyst returns, extract the stopwatch ID from the JSON',
  '  • Tell the user the timer has started AND include the stopwatch ID in your response (e.g. "Timer started (ID: watch-abc123). I\'ll track this until you return.")',
  '  • The stopwatch ID MUST appear in your reply so it is recorded in conversation history for later retrieval',
  '',
  '- When the user RETURNS after a timer was started (e.g. "I am back", "I\'m back", "stop the timer"):',
  '',
  'BROWSER LOGIN & AUTHENTICATION (CRITICAL):',
  '- When the user asks to log in, sign in, authenticate, or access a site that requires login:',
  '  • ALWAYS delegate to the researcher worker — it has browser_detect_auth, browser_login, browser_save_cookies, browser_handoff_request, and browser_handoff_resume tools',
  '  • The researcher can detect login forms, auto-fill credentials from the vault, and log in automatically',
  '  • If the site needs 2FA, CAPTCHA, or manual steps, the researcher will trigger a handoff to the user',
  '  • NEVER refuse login requests — the credential vault securely stores and encrypts website credentials',
  '  • Example goal for researcher: "Navigate to [url], detect the login form, then use browser_login to authenticate using stored credentials. If 2FA or CAPTCHA appears, use browser_handoff_request."',
  '',
  '  • Look in the conversation history for the stopwatch ID from when the timer was started',
  '  • Delegate to analyst with EXPLICIT goal: "Use `stopwatch_stop` with stopwatchId=\'[ID from history]\' to stop the stopwatch and report the total elapsed time in minutes and seconds."',
  '  • If no stopwatch ID is found in history, delegate to analyst: "Use `timer_list` and `stopwatch_status` to find any active timers or stopwatches. If found, stop them and report the elapsed time."',
  '  • Do NOT try to calculate elapsed time using raw timestamps or message metadata — always use the stopwatch tools',
].join('\n');

// Stats NZ routing and specialist policies are now stored in worker_agents table (DB-driven)

// ─── Tool Policies (auto-select tools by mode) ─────────────────

/**
 * Default tool suite for each mode. Tools are auto-selected based on the
 * chat mode to ensure agents have access to necessary capabilities without
 * requiring manual configuration.
 */
const TOOL_POLICIES: Record<'direct' | 'agent' | 'supervisor', string[]> = {
  // Direct mode: model has no tools (direct inference)
  direct: [],
  
  // Agent mode: full toolkit for general-purpose reasoning
  agent: [
    // Temporal tools
    'datetime', 'timezone_info',
    'timer_start', 'timer_pause', 'timer_resume', 'timer_stop', 'timer_status', 'timer_list',
    'stopwatch_start', 'stopwatch_lap', 'stopwatch_pause', 'stopwatch_resume', 'stopwatch_stop', 'stopwatch_status',
    'reminder_create', 'reminder_list', 'reminder_cancel',
    // Utility tools
    'calculator', 'json_format', 'text_analysis', 'memory_recall',
    'web_search',
    // Compute Sandbox Engine
    'cse_run_code', 'cse_session_status', 'cse_end_session',
  ],
  
  // Supervisor mode: reserved for worker delegation; supervisor itself has minimal direct tools
  supervisor: [
    'datetime', 'timezone_info', 'calculator', 'json_format', 'text_analysis',
  ],
};

/**
 * Get the default enabled tools for a given chat mode.
 * Tools are auto-selected to ensure proper functionality without manual setup.
 */
export function getDefaultToolsByMode(mode: 'direct' | 'agent' | 'supervisor'): string[] {
  return TOOL_POLICIES[mode] ?? [];
}

// ─── Model pricing (per 1 M tokens) ─────────────────────────

interface ModelPricing { input: number; output: number }

interface PromptContractCheckResult {
  key: string;
  name: string;
  contractType: string;
  valid: boolean;
  severity: ContractValidationResult['severity'];
  message: string;
  errorCount: number;
  repairSuggestion?: string;
}

interface PromptContractValidationSummary {
  total: number;
  passed: number;
  failed: number;
  error: number;
  warning: number;
  info: number;
}

interface PromptContractValidationReport {
  summary: PromptContractValidationSummary;
  results: PromptContractCheckResult[];
}

interface PromptStrategyInfo {
  requestedKey: string;
  resolvedKey: string;
  usedFallback: boolean;
  name: string;
  description: string;
  metadata?: Record<string, unknown>;
}

interface ResolvedSystemPrompt {
  content?: string;
  strategy?: PromptStrategyInfo;
  resolution?: {
    source: 'base_prompt' | 'prompt_version';
    resolvedVersion: string;
    selectedBy: 'requested_version' | 'experiment' | 'active_flag' | 'latest_published' | 'base_prompt';
    experimentId?: string;
    experimentVariantLabel?: string;
  };
}

// Fallback pricing used when DB lookup yields nothing (keeps system functional during cold start)
const FALLBACK_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-20250514':       { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514':         { input: 15.00, output: 75.00 },
  'claude-haiku-4-20250414':        { input: 1.00, output: 5.00 },
  'gpt-4o':                         { input: 2.50, output: 10.00 },
  'gpt-4o-mini':                    { input: 0.15, output: 0.60 },
  'gpt-4.1':                        { input: 2.00, output: 8.00 },
  'gpt-4.1-mini':                   { input: 0.40, output: 1.60 },
  'gpt-4.1-nano':                   { input: 0.10, output: 0.40 },
  'o3':                             { input: 2.00, output: 8.00 },
  'o4-mini':                        { input: 1.10, output: 4.40 },
};

export function calculateCost(modelId: string, promptTokens: number, completionTokens: number, pricingOverride?: ModelPricing): number {
  const pricing = pricingOverride ?? FALLBACK_PRICING[modelId];
  if (!pricing) return 0;
  return (promptTokens / 1_000_000) * pricing.input + (completionTokens / 1_000_000) * pricing.output;
}

// ─── Provider config ─────────────────────────────────────────

export interface ProviderConfig {
  apiKey: string;
}

export interface ChatEngineConfig {
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  defaultModel: string;
}

// ─── Model factory ───────────────────────────────────────────

const modelCache = new Map<string, Model>();

export async function getOrCreateModel(
  provider: string,
  modelId: string,
  apiKey: string,
): Promise<Model> {
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-20250514" → "claude-sonnet-4-20250514")
  const bareModel = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
  const cacheKey = `${provider}:${bareModel}`;
  const cached = modelCache.get(cacheKey);
  if (cached) return cached;

  let model: Model;
  switch (provider) {
    case 'anthropic': {
      const mod = await import('@weaveintel/provider-anthropic');
      model = (mod as any).weaveAnthropicModel(bareModel, { apiKey });
      break;
    }
    case 'openai': {
      const mod = await import('@weaveintel/provider-openai');
      model = (mod as any).weaveOpenAIModel(bareModel, { apiKey });
      break;
    }
    default:
      throw new Error(`Unsupported provider "${provider}". Install @weaveintel/provider-${provider}`);
  }

  modelCache.set(cacheKey, model);
  return model;
}

// ─── Chat engine ─────────────────────────────────────────────

export interface ChatSettings {
  mode: 'direct' | 'agent' | 'supervisor';
  systemPrompt?: string;
  timezone?: string;
  enabledTools: string[];
  redactionEnabled: boolean;
  redactionPatterns: string[];
  workers: WorkerDef[];
}

export interface WorkerDef {
  name: string;
  description: string;
  tools: string[];
  persona?: string;
}

interface ToolCallObservableEvent {
  phase: 'start' | 'end' | 'error';
  timestamp: number;
  executionId?: string;
  spanId?: string;
  data: Record<string, unknown>;
}

interface AgentRunTelemetry {
  result: AgentResult;
  toolCallEvents: ToolCallObservableEvent[];
}

type CognitiveCheckSummary = GuardrailCategorySummary;

const DEFAULT_SETTINGS: ChatSettings = {
  mode: 'direct',
  enabledTools: getDefaultToolsByMode('direct'),
  redactionEnabled: false,
  redactionPatterns: ['email', 'phone', 'ssn', 'credit_card'],
  workers: [],
};

export function settingsFromRow(row: ChatSettingsRow | null): ChatSettings {
  if (!row) return { ...DEFAULT_SETTINGS };
  
  const mode = (row.mode as ChatSettings['mode']) || 'direct';
  
  // Apply tool policy based on mode: if no tools are explicitly set, use defaults for the mode
  const enabledTools = row.enabled_tools 
    ? JSON.parse(row.enabled_tools) 
    : getDefaultToolsByMode(mode);
  
  return {
    mode,
    systemPrompt: row.system_prompt ?? undefined,
    timezone: row.timezone ?? undefined,
    enabledTools,
    redactionEnabled: !!row.redaction_enabled,
    redactionPatterns: row.redaction_patterns ? JSON.parse(row.redaction_patterns) : DEFAULT_SETTINGS.redactionPatterns,
    workers: row.workers
      ? (JSON.parse(row.workers) as WorkerDef[]).map((worker) => ({
          ...worker,
          persona: normalizePersona(worker.persona, 'agent'),
        }))
      : [],
  };
}

export class ChatEngine {
  private readonly healthTracker = new ModelHealthTracker();
  private readonly responseCache = weaveInMemoryCacheStore();
  private readonly cacheKeyBuilder = weaveCacheKeyBuilder({ namespace: 'gw-chat' });
  private pricingCache: Map<string, ModelPricing> | null = null;
  private pricingCacheTs = 0;
  private policyPromptCache: { ts: number; prompts: Map<string, string> } | null = null;
  private readonly toolOptions: ToolRegistryOptions;

  private withTemporalToolPolicy(basePrompt: string | undefined, toolNames: string[]): string | undefined {
    const hasTemporalTools = toolNames.includes('datetime') || toolNames.includes('timezone_info')
      || toolNames.includes('stopwatch_start') || toolNames.includes('timer_start');
    if (!hasTemporalTools) return basePrompt;
    
    const enhancedPolicy = [
      TEMPORAL_TOOL_POLICY,
      '',
      'REASONING REQUIREMENT:',
      '- Always use the `think` tool before acting',
      '- After calling datetime/timezone_info tools, use `think` with reasoning_phase="reasoning"',
      '- Explicitly connect tool outputs to your answer',
      '- Do not guess or hallucinate dates/times',
    ].join('\n');
    
    const base = basePrompt?.trim();
    return base ? `${base}\n\n${enhancedPolicy}` : enhancedPolicy;
  }
  
  private async getPolicyPromptTemplates(): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.policyPromptCache && now - this.policyPromptCache.ts < 30_000) {
      return this.policyPromptCache.prompts;
    }
    try {
      const prompts = await this.db.listPrompts();
      const enabled = new Map<string, string>();
      for (const prompt of prompts) {
        if (prompt.enabled) enabled.set(prompt.name, prompt.template);
      }
      this.policyPromptCache = { ts: now, prompts: enabled };
      return enabled;
    } catch {
      return new Map<string, string>();
    }
  }

  private async getPolicyPromptTemplate(name: string, fallback: string): Promise<string> {
    const prompts = await this.getPolicyPromptTemplates();
    return prompts.get(name) ?? fallback;
  }

  private async renderPolicyPromptTemplate(
    name: string,
    fallbackTemplate: string,
    vars: Record<string, unknown>,
  ): Promise<string> {
    const template = await this.getPolicyPromptTemplate(name, fallbackTemplate);
    try {
      const tpl = createTemplate({ id: name, name, template });
      return tpl.render(vars);
    } catch {
      return fallbackTemplate;
    }
  }

  private async withResponseCardFormatPolicy(basePrompt: string | undefined): Promise<string | undefined> {
    const policy = await this.getPolicyPromptTemplate(POLICY_PROMPT_RESPONSE_CARD_FORMAT, RESPONSE_CARD_FORMAT_POLICY);
    const base = basePrompt?.trim();
    return base ? `${base}\n\n${policy}` : policy;
  }

  constructor(
    private readonly config: ChatEngineConfig,
    private readonly db: DatabaseAdapter,
  ) {
    this.toolOptions = { temporalStore: createTemporalStore(db) };
  }

  private shouldForceWorkerDataAnalysis(userContent: string, attachments?: ChatAttachment[]): boolean {
    const lower = userContent.toLowerCase();
    const analysisIntent = /\b(analy[sz]e|analysis|insight|dataset|csv|table|trend|summary|summarize|statistics|statistical)\b/.test(lower);
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    // Existing behavior: attached datasets with analysis intent must run through worker execution pipeline.
    if (hasAttachments && analysisIntent) return true;

    // New behavior: no-attachment requests that explicitly require code execution on retrieved data
    // should still enforce the multi-worker code execution path.
    const codeExecutionIntent = /\b(run|execute|execut(e|ing)|python|script|code)\b/.test(lower);
    const dataRetrievalIntent = /\b(data|extracted|retrieve|retrieval|economy|gdp|spending|region|age|ethnicity|historical|trend|stats|statistics|stats\s*nz|new zealand)\b/.test(lower);
    return codeExecutionIntent && dataRetrievalIntent;
  }

  private async discoverSkillsForInput(userContent: string): Promise<{ matches: SkillMatch[]; toolNames: string[] }> {
    try {
      const rows = await this.db.listEnabledSkills();
      if (!rows.length) return { matches: [], toolNames: [] };

      const registry = createSkillRegistry();
      for (const row of rows) {
        registry.register(skillFromRow(row));
      }

      const matches = registry.discover(userContent, { maxSkills: 3, minScore: 0.1 });
      const toolNames = collectSkillTools(matches);
      return { matches, toolNames };
    } catch {
      return { matches: [], toolNames: [] };
    }
  }

  private hasSuccessfulCseExecution(result: AgentResult): boolean {
    return this.scanForSuccessfulCseExecution(result, new WeakSet<object>());
  }

  private hasCodeExecutorDelegation(result: AgentResult): boolean {
    const steps = Array.isArray(result.steps) ? result.steps : [];
    for (const step of steps) {
      if (!step || typeof step !== 'object') continue;

      const delegationWorker = String(step.delegation?.worker ?? step.delegation?.workerName ?? '').trim().toLowerCase();
      if (delegationWorker === 'code_executor') return true;

      const toolName = String(step.toolCall?.name ?? '').trim();
      if (toolName !== 'delegate_to_worker') continue;

      const argsRec = this.asRecord(step.toolCall?.arguments);
      const argWorker = String(argsRec?.['worker'] ?? '').trim().toLowerCase();
      if (argWorker === 'code_executor') return true;
    }

    return false;
  }

  private scanForSuccessfulCseExecution(value: unknown, seen: WeakSet<object>): boolean {
    if (value == null) return false;

    if (typeof value === 'string') {
      const workerTrace = this.extractWorkerToolTrace(value);
      if (workerTrace && this.scanForSuccessfulCseExecution(workerTrace, seen)) {
        return true;
      }
      return false;
    }

    if (Array.isArray(value)) {
      return value.some((entry) => this.scanForSuccessfulCseExecution(entry, seen));
    }

    if (typeof value !== 'object') {
      return false;
    }

    if (seen.has(value)) {
      return false;
    }
    seen.add(value);

    const record = value as Record<string, unknown>;
    const toolCall = this.asRecord(record['toolCall']);
    if (toolCall && toolCall['name'] === 'cse_run_code' && this.isSuccessfulCseToolResult(toolCall['result'])) {
      return true;
    }

    if (record['name'] === 'cse_run_code' && this.isSuccessfulCseToolResult(record['result'])) {
      return true;
    }

    for (const nested of Object.values(record)) {
      if (this.scanForSuccessfulCseExecution(nested, seen)) {
        return true;
      }
    }

    return false;
  }

  private extractWorkerToolTrace(value: string): unknown[] | null {
    const traceIdx = value.indexOf('[WorkerToolTrace]');
    if (traceIdx < 0) {
      return null;
    }

    const traceJson = value.slice(traceIdx + '[WorkerToolTrace]\n'.length).trim();
    const parsed = this.safeParseJson(traceJson);
    if (Array.isArray(parsed)) {
      return parsed;
    }

    const rec = this.asRecord(parsed);
    const executions = rec?.['executions'];
    return Array.isArray(executions) ? executions : null;
  }

  private isSuccessfulCseToolResult(value: unknown): boolean {
    const parsed = typeof value === 'string' ? this.safeParseJson(value) : value;
    const record = this.asRecord(parsed);
    return record?.['status'] === 'success';
  }

  private isSuccessfulToolResult(value: unknown): boolean {
    if (value == null) return false;
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (
        lower.includes('tool error')
        || lower.includes('"status":"error"')
        || lower.includes('"status": "error"')
      ) {
        return false;
      }
    }
    const parsed = typeof value === 'string' ? this.safeParseJson(value) : value;
    const record = this.asRecord(parsed);
    if (!record) return true;
    if (record['isError'] === true) return false;
    const status = record['status'];
    if (status === 'error' || status === 'failed') return false;
    if (record['error']) return false;
    return true;
  }

  /**
   * Build supervisor worker definitions from DB `worker_agents` rows.
   */
  private buildWorkersFromDb(
    workerRows: import('./db-types.js').WorkerAgentRow[],
    model: Model,
    toolOptions: ToolRegistryOptions,
    customTools?: Awaited<ReturnType<ChatEngine['loadEnterpriseTools']>>,
  ): Array<{ name: string; description: string; systemPrompt?: string; model: Model; tools?: ToolRegistry }> {
    const sorted = [...workerRows].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return sorted.map((row) => {
      const toolNames = (this.safeParseJson(row.tool_names) as string[]) ?? [];
      const systemPrompt = this.withTemporalToolPolicy(row.system_prompt ?? undefined, toolNames);
      const persona = normalizePersona(row.persona ?? undefined, 'agent');
      const tools = toolNames.length
        ? createToolRegistry(toolNames, customTools, { ...toolOptions, actorPersona: persona })
        : customTools?.length
          ? createToolRegistry([], customTools, { ...toolOptions, actorPersona: persona })
          : undefined;

      return {
        name: row.name,
        description: row.description,
        systemPrompt,
        model,
        tools,
      };
    });
  }

  /**
   * Generic contract-based execution guard. Delegates to a specific worker and validates
   * the output against the worker's task contract. Retries up to max_retries times.
   */
  private async runWithContractGuard(
    agent: { run: (ctx: ExecutionContext, input: { messages: Message[]; goal: string }) => Promise<AgentResult> },
    ctx: ExecutionContext,
    messages: Message[],
    goal: string,
    workerRow: import('./db-types.js').WorkerAgentRow,
  ): Promise<AgentResult> {
    const contractId = workerRow.task_contract_id;
    const maxRetries = workerRow.max_retries ?? 0;

    // Load the task contract from DB
    let contractRow: import('./db-types.js').TaskContractRow | null = null;
    if (contractId) {
      contractRow = await this.db.getTaskContract(contractId);
    }

    const first = await agent.run(ctx, { messages, goal });
    if (!contractRow) return first;

    // Validate against contract
    if (await this.validateAgainstContract(first, contractRow)) return first;

    // Retry loop with progressively stronger instructions
    let lastResult = first;
    const workerToolNames: string[] = this.safeParseJson(workerRow.tool_names) as string[] ?? [];
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const retryGoal = `${goal}\n\nEXECUTION GUARD (attempt ${attempt + 2}): Delegate to ${workerRow.name} and ensure the response satisfies the task contract "${contractRow.name}". The worker has tools: ${workerToolNames.join(', ')}. Required output fields: ${this.extractRequiredFields(contractRow)}.`;
      lastResult = await agent.run(ctx, { messages, goal: retryGoal });
      if (await this.validateAgainstContract(lastResult, contractRow)) return lastResult;
    }

    return lastResult;
  }

  /**
   * Validate an agent result against a task contract's acceptance criteria.
   */
  private async validateAgainstContract(
    result: AgentResult,
    contractRow: import('./db-types.js').TaskContractRow,
  ): Promise<boolean> {
    const output = String(result.output ?? '');
    const criteria: Array<{ id: string; description: string; type: string; config: Record<string, unknown>; required: boolean }> =
      (this.safeParseJson(contractRow.acceptance_criteria) as Array<{ id: string; description: string; type: string; config: Record<string, unknown>; required: boolean }>) ?? [];

    // Build signal object from output using each criterion's field config
    const signal: Record<string, unknown> = {};
    for (const c of criteria) {
      const field = String(c.config?.['field'] ?? '');
      const operator = String(c.config?.['operator'] ?? '');
      if (operator === 'exists') {
        // Check if the field name appears meaningfully in the output
        signal[field] = this.outputContainsField(output, field);
      } else {
        signal[field] = this.extractFieldValue(output, field);
      }
    }

    const validator = new DefaultCompletionValidator();
    const contract = createContract({
      name: contractRow.name,
      acceptanceCriteria: criteria.map((c) => ({
        id: c.id,
        description: c.description,
        type: c.type as 'assertion',
        required: c.required,
        config: c.config,
      })),
    });
    const report = await validator.validate(signal, contract);
    return report.status === 'fulfilled';
  }

  /**
   * Check if an output contains evidence of a contract field.
   */
  private outputContainsField(output: string, field: string): boolean {
    switch (field) {
      case 'dataset_id':
        return /\b[A-Z]{2,}_[A-Z0-9]+_[0-9]{3}\b/.test(output);
      case 'period': {
        // Check for year references that aren't just part of random numbers
        return /\b(19|20)\d{2}\b/.test(output);
      }
      case 'values': {
        // Check for numeric values that aren't just years
        const tokens = output.match(/\b\d[\d,]*(?:\.\d+)?\b/g) ?? [];
        for (const token of tokens) {
          if (/^(19|20)\d{2}$/.test(token)) continue;
          const numeric = Number(token.replace(/,/g, ''));
          if (Number.isFinite(numeric)) return true;
        }
        return false;
      }
      default:
        return output.toLowerCase().includes(field.toLowerCase());
    }
  }

  private extractFieldValue(output: string, field: string): unknown {
    // Try to find a JSON-like value for the field in the output
    const regex = new RegExp(`"${field}"\\s*:\\s*"?([^",}]+)"?`, 'i');
    const match = output.match(regex);
    return match ? match[1]?.trim() : undefined;
  }

  private extractRequiredFields(contractRow: import('./db-types.js').TaskContractRow): string {
    const criteria: Array<{ config?: { field?: string }; required?: boolean }> =
      (this.safeParseJson(contractRow.acceptance_criteria) as Array<{ config?: { field?: string }; required?: boolean }>) ?? [];
    return criteria
      .filter((c) => c.required !== false)
      .map((c) => c.config?.field ?? 'unknown')
      .join(', ');
  }

  private async buildSupervisorInstructions(
    basePrompt: string | undefined,
    forceWorkerDataAnalysis: boolean,
    workerRows?: import('./db-types.js').WorkerAgentRow[],
  ): Promise<string> {
    const prompts = await this.getPolicyPromptTemplates();
    const workflowBlock = forceWorkerDataAnalysis
      ? prompts.get(POLICY_PROMPT_FORCED_WORKER_REQUIREMENT) ?? FORCED_WORKER_REQUIREMENT
      : undefined;

    // Multi-worker sequential pipeline instruction (always present in supervisor mode)
    const multiWorkerBlock = prompts.get(POLICY_PROMPT_MULTI_WORKER_PIPELINE) ?? [
      'MULTI-WORKER SEQUENTIAL PIPELINE:',
      'When the user\'s request spans multiple capabilities (e.g., "fetch NZ economic data AND run Python to find insights"), you MUST use sequential worker delegation:',
      '  Step 1 — Delegate to the data specialist worker (e.g., statsnz_specialist) to retrieve the raw data.',
      '  Step 2 — Once data is returned, delegate to code_executor with a task that embeds the retrieved data and asks it to write and execute Python (or other code) to produce insights.',
      '  Step 3 — Use the code_executor stdout in your final response. Never skip code execution when the user explicitly asked for it.',
      'Do not collapse multi-step pipelines into a single delegation or into a supervisor-only response.',
    ].join('\n');

    // Build dynamic routing guidance from DB worker capabilities/descriptions.
    // Supervisor should choose workers by user intent, not keyword matching.
    const routingBlocks: string[] = [];
    if (workerRows) {
      for (const row of workerRows) {
        if (!row.description?.trim()) continue;
        routingBlocks.push(
          `WORKER CAPABILITY — ${row.name.toUpperCase()}:\n` +
          `- Delegate to \`${row.name}\` when the user's query intent aligns with this capability.\n` +
          `- ${row.description}\n` +
          '- Select workers semantically based on meaning and task requirements, not keyword overlap.',
        );
      }
    }

    const policyBlocks = [
      prompts.get(POLICY_PROMPT_SUPERVISOR_CODE_EXECUTION) ?? SUPERVISOR_CODE_EXECUTION_POLICY,
      workflowBlock,
      multiWorkerBlock,
      prompts.get(POLICY_PROMPT_SUPERVISOR_TEMPORAL) ?? SUPERVISOR_TEMPORAL_POLICY,
      ...routingBlocks,
      prompts.get(POLICY_PROMPT_RESPONSE_CARD_FORMAT) ?? RESPONSE_CARD_FORMAT_POLICY,
    ].filter((v): v is string => Boolean(v && v.trim()));

    const prefix = basePrompt?.trim();
    return prefix ? `${prefix}\n\n${policyBlocks.join('\n\n')}` : policyBlocks.join('\n\n');
  }

  private containsSandboxArtifactPath(text: string): boolean {
    if (!text) return false;
    return /\/workspace\/output\/[^\s)"']+\.png/iu.test(text)
      || /"img_path"\s*:\s*"\/workspace\/output\//iu.test(text);
  }

  private indicatesIncompleteAttachmentAnalysis(text: string): boolean {
    if (!text) return false;
    const lower = text.toLowerCase();
    return lower.includes('insight summary was blank')
      || lower.includes('summary was blank')
      || lower.includes('would you like me to') && lower.includes('re-run the analysis');
  }

  private hasRenderableAttachmentAnalysisOutput(result: AgentResult, goal: string): boolean {
    const output = String(result.output || '').trim();
    if (!output) return false;
    if (this.containsSandboxArtifactPath(output)) return false;
    if (this.indicatesIncompleteAttachmentAnalysis(output)) return false;

    const expectsRenderableChart = /\b(chart|charts|graph|graphs|visuali[sz]ation|plot|plots)\b/i.test(goal);
    if (!expectsRenderableChart) return true;

    return output.includes('"chart"')
      || output.includes('```json')
      || !this.containsSandboxArtifactPath(output);
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private async runWithCseSuccessGuard(
    agent: { run: (ctx: ExecutionContext, input: { messages: Message[]; goal: string }) => Promise<AgentResult> },
    ctx: ExecutionContext,
    messages: Message[],
    goal: string,
    enforce: boolean,
  ): Promise<AgentResult> {
    const first = await agent.run(ctx, { messages, goal });
    if (
      !enforce
      || (
        this.hasSuccessfulCseExecution(first)
        && this.hasCodeExecutorDelegation(first)
        && this.hasRenderableAttachmentAnalysisOutput(first, goal)
      )
    ) return first;

    const guardPolicy = await this.getPolicyPromptTemplate(POLICY_PROMPT_HARD_EXECUTION_GUARD, HARD_EXECUTION_GUARD_POLICY);
    const retryGoal = `${goal}\n\n${guardPolicy}`;
    const second = await agent.run(ctx, { messages, goal: retryGoal });
    if (
      this.hasSuccessfulCseExecution(second)
      && this.hasCodeExecutorDelegation(second)
      && this.hasRenderableAttachmentAnalysisOutput(second, retryGoal)
    ) return second;

    return {
      ...second,
      output: '[Execution guard failure] The workflow did not satisfy required execution constraints. A successful cse_run_code run through delegated worker "code_executor" is required, and the final result must be renderable (no sandbox-local file paths, no incomplete insights). Please retry.',
    };
  }

  /** Load pricing from DB, cache for 60 s */
  private async loadPricing(): Promise<Map<string, ModelPricing>> {
    const now = Date.now();
    if (this.pricingCache && now - this.pricingCacheTs < 60_000) return this.pricingCache;
    try {
      const rows = await this.db.listModelPricing();
      const map = new Map<string, ModelPricing>();
      for (const r of rows) {
        if (r.enabled) map.set(r.model_id, { input: r.input_cost_per_1m, output: r.output_cost_per_1m });
      }
      this.pricingCache = map;
      this.pricingCacheTs = now;
      return map;
    } catch {
      return new Map();
    }
  }

  // ── Direct mode: send ───────────────────────────────────────

  async sendMessage(
    userId: string,
    chatId: string,
    content: string,
    opts?: { provider?: string; model?: string; maxTokens?: number; temperature?: number; attachments?: ChatAttachment[] },
  ): Promise<{
    assistantContent: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    cost: number;
    latencyMs: number;
    redaction?: { count: number; types: string[] };
    eval?: { passed: number; failed: number; total: number; score: number };
    steps?: AgentStep[];
    traceId?: string;
    guardrail?: { decision: 'allow' | 'deny' | 'warn'; reason?: string };
    cognitive?: CognitiveCheckSummary;
    policyChecks?: Array<{ tool: string; policy: string; taskType: string; priority: string }>;
    routingDecision?: { provider: string; model: string; reason: string };
    activeSkills?: Array<{ id: string; name: string; category: string; score: number; tools: string[] }>;
    skillTools?: string[];
    enabledTools?: string[];
    skillPromptApplied?: boolean;
    contracts?: PromptContractValidationReport;
    promptStrategy?: PromptStrategyInfo;
    promptResolution?: {
      source: 'base_prompt' | 'prompt_version';
      resolvedVersion: string;
      selectedBy: 'requested_version' | 'experiment' | 'active_flag' | 'latest_published' | 'base_prompt';
      experimentId?: string;
      experimentVariantLabel?: string;
    };
  }> {
    let provider = opts?.provider ?? this.config.defaultProvider;
    let modelId = opts?.model ?? this.config.defaultModel;
    let providerCfg = this.config.providers[provider];
    let routingInfo: { provider: string; model: string; reason: string } | undefined;

    // Try routing from DB policy
    const routed = await this.routeModel(opts);
    if (routed && this.config.providers[routed.provider]) {
      provider = routed.provider;
      modelId = routed.modelId;
      providerCfg = this.config.providers[provider];
      routingInfo = { provider, model: modelId, reason: 'Selected by routing policy' };
    }

    if (!providerCfg) {
      // Fall back to default provider when stored provider isn't configured
      provider = this.config.defaultProvider;
      modelId = this.config.defaultModel;
      providerCfg = this.config.providers[provider];
    }
    if (!providerCfg) {
      // Fall back to first available provider
      const first = Object.entries(this.config.providers)[0];
      if (!first) throw new Error(`No providers configured`);
      [provider, providerCfg] = first;
      modelId = this.config.defaultModel;
    }

    const model = await getOrCreateModel(provider, modelId, providerCfg.apiKey);
    const actor = await this.db.getUserById(userId);
    const userPersona = normalizePersona(actor?.persona, 'user');
    const settings = settingsFromRow(await this.db.getChatSettings(chatId));
    const resolvedSystemPrompt = await this.resolveSystemPrompt(settings);
    const resolvedPrompt = await this.withResponseCardFormatPolicy(resolvedSystemPrompt.content);
    const traceId = randomUUID();
    const ctx = weaveContext({ userId, deadline: Date.now() + 120_000, metadata: { traceId, chatId } });
    const startMs = Date.now();

    const attachments = this.normalizeAttachments(opts?.attachments);
    const contentWithAttachments = this.composeUserInput(content, attachments);

    // Redaction
    let processedContent = contentWithAttachments;
    let redactionInfo: { count: number; types: string[] } | undefined;
    if (settings.redactionEnabled) {
      const rd = await this.applyRedaction(ctx, contentWithAttachments, settings.redactionPatterns);
      processedContent = rd.redacted;
      if (rd.wasModified) {
        redactionInfo = { count: rd.detections.length, types: [...new Set(rd.detections.map((d: any) => d.type))] };
      }
    }

    // Discover skills from the user request and auto-enable their associated tools.
    const skillContext = await this.discoverSkillsForInput(processedContent);
    const skillPrompt = applySkillsToPrompt(resolvedPrompt, skillContext.matches);
    const enabledTools = Array.from(new Set([...settings.enabledTools, ...skillContext.toolNames]));
    const skillTools = enabledTools.filter((tool) => !settings.enabledTools.includes(tool));
    const activeSkills = skillContext.matches.map((m) => ({
      id: m.skill.id,
      name: m.skill.name,
      category: m.skill.category,
      score: Number(m.score.toFixed(3)),
      tools: [...(m.skill.toolNames ?? [])],
    }));

    // Save user message
    const userMsgId = randomUUID();
    const userMetadata = redactionInfo || attachments.length > 0
      ? JSON.stringify({
          redaction: redactionInfo,
          attachments: attachments.length > 0 ? attachments : undefined,
        })
      : undefined;
    await this.db.addMessage({ id: userMsgId, chatId, role: 'user', content, metadata: userMetadata });

    // Pre-execution guardrails
    const preGuardrail = await this.evaluateGuardrails(chatId, userMsgId, processedContent, 'pre-execution');
    if (preGuardrail.decision === 'deny') {
      const denyContent = preGuardrail.reason || 'Your message was blocked by a guardrail policy.';
      const assistMsgId = randomUUID();
      await this.db.addMessage({
        id: assistMsgId,
        chatId,
        role: 'assistant',
        content: denyContent,
        metadata: JSON.stringify({
          guardrail: { decision: 'deny', reason: preGuardrail.reason },
          cognitive: preGuardrail.cognitive,
        }),
      });
      return {
        assistantContent: denyContent,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        cost: 0,
        latencyMs: Date.now() - startMs,
        redaction: redactionInfo,
        guardrail: { decision: 'deny', reason: preGuardrail.reason },
        cognitive: preGuardrail.cognitive,
      };
    }

    const identityRecall = await this.resolveIdentityRecallFromMemory(userId, processedContent);
    if (identityRecall) {
      const latencyMs = Date.now() - startMs;
      const assistMsgId = randomUUID();
      await this.db.addMessage({
        id: assistMsgId,
        chatId,
        role: 'assistant',
        content: identityRecall,
        metadata: JSON.stringify({
          model: 'memory-recall',
          provider: 'local',
          mode: settings.mode,
          memoryRecall: { deterministic: true, identity: true },
          traceId,
        }),
        tokensUsed: 0,
        cost: 0,
        latencyMs,
      });

      await this.db.recordMetric({
        id: randomUUID(), userId, chatId, type: 'generation', provider: 'local', model: 'memory-recall',
        promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, latencyMs,
      });

      return {
        assistantContent: identityRecall,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        cost: 0,
        latencyMs,
        redaction: redactionInfo,
      };
    }

    // Build conversation
    const history = await this.db.getMessages(chatId);
    const messages = historyToMessages(history);
    this.patchLatestUserMessage(messages, processedContent);

    // ── Memory recall ──
    const memoryContext = await this.buildMemoryContext(ctx, model, userId, processedContent);
    const augmentedPrompt = memoryContext
      ? (skillPrompt ? `${skillPrompt}\n\n---\n${memoryContext}` : memoryContext)
      : skillPrompt;
    const memorySettings = {
      ...settings,
      enabledTools,
      systemPrompt: augmentedPrompt,
    };

    let assistantContent: string = '';
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let steps: AgentStep[] | undefined;
    let toolCallEvents: ToolCallObservableEvent[] | undefined;
    let cacheHit = false;
    let contractInfo: PromptContractValidationReport | undefined;

    // ── Cache lookup ──
    const allowResponseCache = attachments.length === 0;
    const cachePolicy = allowResponseCache ? await this.resolveActiveCache(settings.mode) : null;
    const cacheKey = this.cacheKeyBuilder.build({ model: modelId, prompt: processedContent });
    if (cachePolicy && !shouldBypass(cachePolicy, processedContent)) {
      const cached = await this.responseCache.get(cacheKey);
      if (cached) {
        assistantContent = (cached as any).content ?? '';
        usage = (cached as any).usage ?? usage;
        cacheHit = true;
      }
    }

    if (!cacheHit) {
    if (settings.mode === 'agent' || settings.mode === 'supervisor') {
      // ── Agent / Supervisor mode ──
      const telemetry = await this.runAgent(ctx, model, userId, chatId, userPersona, messages, processedContent, memorySettings, attachments);
      assistantContent = telemetry.result.output ?? '';
      usage = {
        promptTokens: telemetry.result.usage.totalTokens,  // agent tracks totalTokens only
        completionTokens: 0,
        totalTokens: telemetry.result.usage.totalTokens,
      };
      steps = [...telemetry.result.steps];
      toolCallEvents = telemetry.toolCallEvents;
    } else {
      // ── Direct mode ──
      const request: ModelRequest = {
        messages: augmentedPrompt
          ? [{ role: 'system', content: augmentedPrompt }, ...messages]
          : messages,
        maxTokens: opts?.maxTokens ?? 4096,
        temperature: opts?.temperature,
      };
      const response = await model.generate(ctx, request);
      assistantContent = response.content ?? '';
      usage = { ...response.usage };
    }
    } // end if (!cacheHit)

    // ── Cache store ──
    if (!cacheHit && cachePolicy && !assistantContent.includes('[Execution guard failure]')) {
      await this.responseCache.set(cacheKey, { content: assistantContent!, usage }, cachePolicy.ttlMs);
    }

    contractInfo = await this.validatePromptContracts(assistantContent);


    const latencyMs = Date.now() - startMs;
    const dbPricing = await this.loadPricing();
    const cost = calculateCost(modelId, usage.promptTokens, usage.completionTokens, dbPricing.get(modelId));

    // Record health outcome
    this.recordModelOutcome(modelId, provider, latencyMs, true);

    // Human-task policy checks on tool calls
    const policyChecks = steps ? await this.evaluateTaskPolicies(steps) : undefined;

    // Post-execution guardrails (must run before eval so the decision feeds into the eval score)
    const SUPERVISOR_INTERNAL_TOOLS = new Set(['think', 'plan', 'synthesize', 'reflect', 'log']);
    const toolEvidence = steps
      ?.filter(s => {
        if (s.type !== 'tool_call' && s.type !== 'delegation') return false;
        const result = (s.toolCall?.result ?? s.delegation?.result ?? '') as string;
        if (!result || result === '(Worker returned no output)') return false;
        if (/^\[(PLANNING|REASONING|SYNTHESIS|REFLECTION)\]/.test(result)) return false;
        if (s.type === 'tool_call' && SUPERVISOR_INTERNAL_TOOLS.has(s.toolCall?.name ?? '')) return false;
        return true;
      })
      .map(s => (s.toolCall?.result ?? s.delegation?.result ?? '') as string)
      .join(' ') || undefined;
    const postGuardrail = await this.evaluateGuardrails(chatId, null, assistantContent, 'post-execution', {
      userInput: processedContent,
      assistantOutput: assistantContent,
      toolEvidence,
    });
    const guardrailInfo = preGuardrail.decision !== 'allow'
      ? { decision: preGuardrail.decision as 'allow' | 'deny' | 'warn', reason: preGuardrail.reason }
      : postGuardrail.decision !== 'allow'
      ? { decision: postGuardrail.decision as 'allow' | 'deny' | 'warn', reason: postGuardrail.reason }
      : undefined;

    // Eval — pass the overall guardrail decision so the score reflects grounding/sycophancy warnings
    const overallGuardrailDecision = guardrailInfo?.decision ?? 'allow';
    let evalInfo: { passed: number; failed: number; total: number; score: number } | undefined;
    evalInfo = await this.runPostEval(ctx, userId, chatId, processedContent, assistantContent, latencyMs, cost, overallGuardrailDecision);

    // Save assistant message
    const assistMsgId = randomUUID();
    await this.db.addMessage({
      id: assistMsgId,
      chatId,
      role: 'assistant',
      content: assistantContent ?? '',
      metadata: JSON.stringify({
        model: modelId, provider,
        mode: settings.mode,
        agentName: settings.mode === 'supervisor' ? 'geneweave-supervisor' : settings.mode === 'agent' ? 'geneweave-agent' : undefined,
        systemPrompt: memorySettings.systemPrompt || undefined,
        enabledTools: memorySettings.enabledTools.length ? memorySettings.enabledTools : undefined,
        activeSkills: activeSkills.length ? activeSkills : undefined,
        skillTools: skillTools.length ? skillTools : undefined,
        skillPromptApplied: activeSkills.length > 0 ? true : undefined,
        redactionEnabled: settings.redactionEnabled || undefined,
        steps: steps ? steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })) : undefined,
        eval: evalInfo,
        guardrail: guardrailInfo,
        cognitive: postGuardrail.cognitive,
        policyChecks: policyChecks?.length ? policyChecks : undefined,
        promptContracts: contractInfo,
        promptStrategy: resolvedSystemPrompt.strategy,
        promptResolution: resolvedSystemPrompt.resolution,
        traceId,
      }),
      tokensUsed: usage.totalTokens,
      cost,
      latencyMs,
    });

    // Persist memory before returning so cross-chat recall is immediately available.
    try {
      await this.saveToMemory(ctx, model, userId, chatId, processedContent, assistantContent);
    } catch {
      // Keep chat success path resilient when memory persistence fails.
    }

    // Record metric
    await this.db.recordMetric({
      id: randomUUID(), userId, chatId, type: 'generation', provider, model: modelId,
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens, cost, latencyMs,
    });

    // Record traces
    await this.recordTraceSpans(userId, chatId, assistMsgId, traceId, settings.mode, startMs, latencyMs, steps, toolCallEvents);

    return {
      assistantContent,
      usage,
      cost,
      latencyMs,
      redaction: redactionInfo,
      eval: evalInfo,
      steps,
      traceId,
      guardrail: guardrailInfo,
      cognitive: postGuardrail.cognitive,
      policyChecks,
      routingDecision: routingInfo,
      activeSkills,
      skillTools,
      enabledTools: memorySettings.enabledTools,
      skillPromptApplied: activeSkills.length > 0,
      contracts: contractInfo,
      promptStrategy: resolvedSystemPrompt.strategy,
      promptResolution: resolvedSystemPrompt.resolution,
    };
  }

  // ── Stream mode ─────────────────────────────────────────────

  async streamMessage(
    res: ServerResponse,
    userId: string,
    chatId: string,
    content: string,
    opts?: { provider?: string; model?: string; maxTokens?: number; temperature?: number; attachments?: ChatAttachment[] },
  ): Promise<void> {
    let provider = opts?.provider ?? this.config.defaultProvider;
    let modelId = opts?.model ?? this.config.defaultModel;
    let providerCfg = this.config.providers[provider];

    // Try routing from DB policy
    const routed = await this.routeModel(opts);
    if (routed && this.config.providers[routed.provider]) {
      provider = routed.provider;
      modelId = routed.modelId;
      providerCfg = this.config.providers[provider];
    }

    if (!providerCfg) {
      // Fall back to default provider when stored provider isn't configured
      provider = this.config.defaultProvider;
      modelId = this.config.defaultModel;
      providerCfg = this.config.providers[provider];
    }
    if (!providerCfg) {
      // Fall back to first available provider
      const first = Object.entries(this.config.providers)[0];
      if (!first) throw new Error(`No providers configured`);
      [provider, providerCfg] = first;
      modelId = this.config.defaultModel;
    }

    const model = await getOrCreateModel(provider, modelId, providerCfg.apiKey);
    const actor = await this.db.getUserById(userId);
    const userPersona = normalizePersona(actor?.persona, 'user');
    const settings = settingsFromRow(await this.db.getChatSettings(chatId));
    const resolvedSystemPrompt = await this.resolveSystemPrompt(settings);
    const resolvedPrompt = await this.withResponseCardFormatPolicy(resolvedSystemPrompt.content);
    const traceId = randomUUID();
    const ctx = weaveContext({ userId, deadline: Date.now() + 120_000, metadata: { traceId, chatId } });

    const attachments = this.normalizeAttachments(opts?.attachments);
    const contentWithAttachments = this.composeUserInput(content, attachments);

    // Redaction
    let processedContent = contentWithAttachments;
    let redactionInfo: { count: number; types: string[] } | undefined;
    if (settings.redactionEnabled) {
      const rd = await this.applyRedaction(ctx, contentWithAttachments, settings.redactionPatterns);
      processedContent = rd.redacted;
      if (rd.wasModified) {
        redactionInfo = { count: rd.detections.length, types: [...new Set(rd.detections.map((d: any) => d.type))] };
      }
    }

    // Discover skills from the user request and auto-enable their associated tools.
    const streamSkillContext = await this.discoverSkillsForInput(processedContent);
    const streamSkillPrompt = applySkillsToPrompt(resolvedPrompt, streamSkillContext.matches);
    const streamEnabledTools = Array.from(new Set([...settings.enabledTools, ...streamSkillContext.toolNames]));
    const streamSkillTools = streamEnabledTools.filter((tool) => !settings.enabledTools.includes(tool));
    const streamActiveSkills = streamSkillContext.matches.map((m) => ({
      id: m.skill.id,
      name: m.skill.name,
      category: m.skill.category,
      score: Number(m.score.toFixed(3)),
      tools: [...(m.skill.toolNames ?? [])],
    }));

    // Save user message
    const userMsgId = randomUUID();
    const userMetadata = redactionInfo || attachments.length > 0
      ? JSON.stringify({
          redaction: redactionInfo,
          attachments: attachments.length > 0 ? attachments : undefined,
        })
      : undefined;
    await this.db.addMessage({ id: userMsgId, chatId, role: 'user', content, metadata: userMetadata });

    // Pre-execution guardrails
    const preGuardrail = await this.evaluateGuardrails(chatId, userMsgId, processedContent, 'pre-execution');
    if (preGuardrail.decision === 'deny') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const denyContent = preGuardrail.reason || 'Your message was blocked by a guardrail policy.';
      res.write(`data: ${JSON.stringify({ type: 'text', text: denyContent })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'guardrail', decision: 'deny', reason: preGuardrail.reason })}\n\n`);
      if (preGuardrail.cognitive) {
        res.write(`data: ${JSON.stringify({ type: 'cognitive', ...preGuardrail.cognitive })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: 'done', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: 0, latencyMs: 0 })}\n\n`);
      res.end();
      await this.db.addMessage({
        id: randomUUID(),
        chatId,
        role: 'assistant',
        content: denyContent,
        metadata: JSON.stringify({ guardrail: { decision: 'deny', reason: preGuardrail.reason }, cognitive: preGuardrail.cognitive }),
      });
      return;
    }

    const identityRecall = await this.resolveIdentityRecallFromMemory(userId, processedContent);
    if (identityRecall) {
      const latencyMs = 0;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (redactionInfo) {
        res.write(`data: ${JSON.stringify({ type: 'redaction', ...redactionInfo })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: 'text', text: identityRecall })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'done',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        cost: 0,
        latencyMs,
        model: 'memory-recall',
        provider: 'local',
        mode: settings.mode,
      })}\n\n`);

      await this.db.addMessage({
        id: randomUUID(),
        chatId,
        role: 'assistant',
        content: identityRecall,
        metadata: JSON.stringify({
          model: 'memory-recall',
          provider: 'local',
          streamed: true,
          mode: settings.mode,
          memoryRecall: { deterministic: true, identity: true },
          traceId,
        }),
        tokensUsed: 0,
        cost: 0,
        latencyMs,
      });

      await this.db.recordMetric({
        id: randomUUID(), userId, chatId, type: 'generation', provider: 'local', model: 'memory-recall',
        promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, latencyMs,
      });

      res.end();
      return;
    }

    // Build conversation
    const history = await this.db.getMessages(chatId);
    const messages = historyToMessages(history);
    this.patchLatestUserMessage(messages, processedContent);

    // ── Memory recall ──
    const streamMemoryContext = await this.buildMemoryContext(ctx, model, userId, processedContent);
    const streamAugmentedPrompt = streamMemoryContext
      ? (streamSkillPrompt ? `${streamSkillPrompt}\n\n---\n${streamMemoryContext}` : streamMemoryContext)
      : streamSkillPrompt;
    const streamMemorySettings = {
      ...settings,
      enabledTools: streamEnabledTools,
      systemPrompt: streamAugmentedPrompt,
    };

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send redaction event
    if (redactionInfo) {
      res.write(`data: ${JSON.stringify({ type: 'redaction', ...redactionInfo })}\n\n`);
    }

    const startMs = Date.now();
    let fullText = '';
    let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let steps: AgentStep[] = [];
    let toolCallEvents: ToolCallObservableEvent[] = [];
    let streamContractInfo: PromptContractValidationReport | undefined;

    try {
      if (settings.mode === 'agent' || settings.mode === 'supervisor') {
        // ── Agent / Supervisor streaming ──
        const telemetry = await this.streamAgent(res, ctx, model, userId, chatId, userPersona, messages, processedContent, streamMemorySettings, attachments);
        fullText = telemetry.result.output ?? '';
        finalUsage = { promptTokens: telemetry.result.usage.totalTokens, completionTokens: 0, totalTokens: telemetry.result.usage.totalTokens };
        steps = [...telemetry.result.steps];
        toolCallEvents = telemetry.toolCallEvents;
      } else {
        // ── Direct streaming ──
        const request: ModelRequest = {
          messages: streamAugmentedPrompt
            ? [{ role: 'system', content: streamAugmentedPrompt }, ...messages]
            : messages,
          maxTokens: opts?.maxTokens ?? 4096,
          temperature: opts?.temperature,
          stream: true,
        };

        if (model.stream) {
          const stream = model.stream(ctx, request);
          for await (const chunk of stream) {
            if (chunk.type === 'text' && chunk.text) {
              fullText += chunk.text;
              res.write(`data: ${JSON.stringify({ type: 'text', text: chunk.text })}\n\n`);
            } else if (chunk.type === 'reasoning' && chunk.reasoning) {
              res.write(`data: ${JSON.stringify({ type: 'reasoning', text: chunk.reasoning })}\n\n`);
            } else if (chunk.type === 'usage' && chunk.usage) {
              finalUsage = { promptTokens: chunk.usage.promptTokens, completionTokens: chunk.usage.completionTokens, totalTokens: chunk.usage.totalTokens };
            } else if (chunk.type === 'done') {
              break;
            }
          }
        } else {
          const response = await model.generate(ctx, request);
          fullText = response.content;
          finalUsage = { ...response.usage };
          res.write(`data: ${JSON.stringify({ type: 'text', text: response.content })}\n\n`);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Stream error';
      res.write(`data: ${JSON.stringify({ type: 'error', error: errMsg })}\n\n`);
    }

    const latencyMs = Date.now() - startMs;
    const streamDbPricing = await this.loadPricing();
    const cost = calculateCost(modelId, finalUsage.promptTokens, finalUsage.completionTokens, streamDbPricing.get(modelId));

    // Record health outcome
    this.recordModelOutcome(modelId, provider, latencyMs, true);

    // Human-task policy checks on tool calls
    const policyChecks = steps.length ? await this.evaluateTaskPolicies(steps) : undefined;
    if (policyChecks?.length) {
      res.write(`data: ${JSON.stringify({ type: 'policy_checks', checks: policyChecks })}\n\n`);
    }

    // Post-execution guardrails (must run before eval so the decision feeds into the eval score)
    const STREAM_SUPERVISOR_INTERNAL_TOOLS = new Set(['think', 'plan', 'synthesize', 'reflect', 'log']);
    const streamToolEvidence = steps
      ?.filter(s => {
        if (s.type !== 'tool_call' && s.type !== 'delegation') return false;
        const result = (s.toolCall?.result ?? s.delegation?.result ?? '') as string;
        if (!result || result === '(Worker returned no output)') return false;
        if (/^\[(PLANNING|REASONING|SYNTHESIS|REFLECTION)\]/.test(result)) return false;
        if (s.type === 'tool_call' && STREAM_SUPERVISOR_INTERNAL_TOOLS.has(s.toolCall?.name ?? '')) return false;
        return true;
      })
      .map(s => (s.toolCall?.result ?? s.delegation?.result ?? '') as string)
      .join(' ') || undefined;
    const postGuardrail = await this.evaluateGuardrails(chatId, null, fullText, 'post-execution', {
      userInput: processedContent,
      assistantOutput: fullText,
      toolEvidence: streamToolEvidence,
    });
    if (postGuardrail.cognitive) {
      res.write(`data: ${JSON.stringify({ type: 'cognitive', ...postGuardrail.cognitive })}\n\n`);
    }
    if (postGuardrail.decision !== 'allow') {
      res.write(`data: ${JSON.stringify({ type: 'guardrail', decision: postGuardrail.decision, reason: postGuardrail.reason })}\n\n`);
    }

    // Eval — pass guardrail decision so the score reflects grounding/sycophancy warnings
    const streamGuardrailDecision = postGuardrail.decision as 'allow' | 'warn' | 'deny';
    const evalInfo = await this.runPostEval(ctx, userId, chatId, processedContent, fullText, latencyMs, cost, streamGuardrailDecision);
    if (evalInfo) {
      res.write(`data: ${JSON.stringify({ type: 'eval', ...evalInfo })}\n\n`);
    }

    streamContractInfo = await this.validatePromptContracts(fullText);
    if (streamContractInfo) {
      res.write(`data: ${JSON.stringify({ type: 'contracts', ...streamContractInfo })}\n\n`);
    }

    // Done event
    res.write(`data: ${JSON.stringify({
      type: 'done',
      usage: finalUsage,
      cost,
      latencyMs,
      model: modelId,
      provider,
      mode: settings.mode,
      activeSkills: streamActiveSkills,
      skillTools: streamSkillTools,
      enabledTools: streamMemorySettings.enabledTools,
      skillPromptApplied: streamActiveSkills.length > 0,
      steps: steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })),
      cognitive: postGuardrail.cognitive,
      contracts: streamContractInfo,
      promptStrategy: resolvedSystemPrompt.strategy,
      promptResolution: resolvedSystemPrompt.resolution,
      traceId,
    })}\n\n`);

    // Persist before closing the stream so immediate follow-up chats can recall memory.
    const assistMsgId = randomUUID();
    await this.db.addMessage({
      id: assistMsgId, chatId, role: 'assistant', content: fullText,
      metadata: JSON.stringify({
        model: modelId, provider, streamed: true, mode: settings.mode,
        agentName: settings.mode === 'supervisor' ? 'geneweave-supervisor' : settings.mode === 'agent' ? 'geneweave-agent' : undefined,
        systemPrompt: streamMemorySettings.systemPrompt || undefined,
        enabledTools: streamMemorySettings.enabledTools.length ? streamMemorySettings.enabledTools : undefined,
        activeSkills: streamActiveSkills.length ? streamActiveSkills : undefined,
        skillTools: streamSkillTools.length ? streamSkillTools : undefined,
        skillPromptApplied: streamActiveSkills.length > 0 ? true : undefined,
        redactionEnabled: settings.redactionEnabled || undefined,
        steps: steps.length ? steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })) : undefined,
        eval: evalInfo,
        guardrail: postGuardrail.decision !== 'allow' ? { decision: postGuardrail.decision, reason: postGuardrail.reason } : undefined,
        cognitive: postGuardrail.cognitive,
        policyChecks: policyChecks?.length ? policyChecks : undefined,
        promptContracts: streamContractInfo,
        promptStrategy: resolvedSystemPrompt.strategy,
        promptResolution: resolvedSystemPrompt.resolution,
        traceId,
      }),
      tokensUsed: finalUsage.totalTokens, cost, latencyMs,
    });

    // Persist memory before completing request lifecycle to reduce write/read races across chats.
    try {
      await this.saveToMemory(ctx, model, userId, chatId, processedContent, fullText);
    } catch {
      // Keep chat success path resilient when memory persistence fails.
    }

    await this.db.recordMetric({
      id: randomUUID(), userId, chatId, type: 'generation', provider, model: modelId,
      promptTokens: finalUsage.promptTokens, completionTokens: finalUsage.completionTokens,
      totalTokens: finalUsage.totalTokens, cost, latencyMs,
    });

    await this.recordTraceSpans(userId, chatId, assistMsgId, traceId, settings.mode, startMs, latencyMs, steps, toolCallEvents);
    res.end();
  }

  private async validatePromptContracts(output: string): Promise<PromptContractValidationReport | undefined> {
    if (!output.trim()) return undefined;
    try {
      const rows = await this.db.listPromptContracts();
      const enabledRows = rows.filter((row) => row.enabled);
      if (enabledRows.length === 0) return undefined;

      const parsed = enabledRows
        .map((row) => ({
          row,
          contract: contractFromRecord({
            id: row.id,
            key: row.key,
            name: row.name,
            description: row.description ?? '',
            contract_type: row.contract_type,
            schema: row.schema ?? undefined,
            config: row.config,
            enabled: row.enabled,
          }),
        }))
        .filter((entry): entry is { row: typeof enabledRows[number]; contract: NonNullable<ReturnType<typeof contractFromRecord>> } => !!entry.contract);

      if (parsed.length === 0) return undefined;

      const registry = new InMemoryContractRegistry(parsed.map((entry) => entry.contract));
      const results: PromptContractCheckResult[] = parsed.map(({ row }) => {
        const contract = registry.get(row.key);
        if (!contract) {
          return {
            key: row.key,
            name: row.name,
            contractType: row.contract_type,
            valid: false,
            severity: 'error',
            message: 'Contract could not be loaded from registry',
            errorCount: 1,
          };
        }
        const validation = validateContract(output, contract);
        return {
          key: row.key,
          name: row.name,
          contractType: row.contract_type,
          valid: validation.valid,
          severity: validation.severity,
          message: validation.message,
          errorCount: validation.errors.length,
          repairSuggestion: validation.repairSuggestion,
        };
      });

      const summary: PromptContractValidationSummary = {
        total: results.length,
        passed: results.filter((r) => r.valid).length,
        failed: results.filter((r) => !r.valid).length,
        error: results.filter((r) => r.severity === 'error').length,
        warning: results.filter((r) => r.severity === 'warning').length,
        info: results.filter((r) => r.severity === 'info').length,
      };

      return { summary, results };
    } catch {
      return undefined;
    }
  }

  // ── Enterprise tools loader ─────────────────────────────────

  /**
   * Auto-refresh OAuth2 token if it expires within 60 seconds.
   * Mutates the row's access_token in-place and persists to DB.
   */
  private async refreshTokenIfNeeded(row: import('./db-types.js').EnterpriseConnectorRow): Promise<void> {
    if (row.auth_type !== 'oauth2' || !row.refresh_token || !row.token_expires_at) return;
    const expiresAt = new Date(row.token_expires_at).getTime();
    const now = Date.now();
    // Refresh if token expires within 60 seconds
    if (expiresAt - now > 60_000) return;

    const authConfig = row.auth_config ? (JSON.parse(row.auth_config) as Record<string, string>) : {};
    const clientId = authConfig['clientId'] ?? authConfig['client_id'];
    const clientSecret = authConfig['clientSecret'] ?? authConfig['client_secret'];
    if (!clientId || !clientSecret || !row.base_url) return;

    console.log(`[chat] OAuth token for ${row.connector_type}/${row.name} expires soon — refreshing...`);
    const provider = new ServiceNowProvider();
    const result = await provider.refreshOAuthToken(row.base_url, clientId, clientSecret, row.refresh_token);
    if (!result) {
      console.error(`[chat] Token refresh failed for connector ${row.id}`);
      return;
    }

    const newExpiresAt = new Date(now + result.expiresIn * 1000).toISOString();
    await this.db.updateEnterpriseConnector(row.id, {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      token_expires_at: newExpiresAt,
    });
    // Mutate the row so callers pick up the fresh token
    row.access_token = result.accessToken;
    row.refresh_token = result.refreshToken;
    row.token_expires_at = newExpiresAt;
    console.log(`[chat] Token refreshed for ${row.connector_type}/${row.name}, expires ${newExpiresAt}`);
  }

  private async loadEnterpriseTools(): Promise<import('@weaveintel/core').Tool[]> {
    try {
      const rows = await this.db.listEnterpriseConnectors();
      const enabled = rows.filter((r) => r.enabled === 1 && r.status === 'connected');
      if (enabled.length === 0) return [];

      // Auto-refresh expired OAuth tokens before building configs
      await Promise.all(enabled.map((r) => this.refreshTokenIfNeeded(r)));

      const configs: EnterpriseConnectorConfig[] = enabled.map((row) => {
        const authConfig: Record<string, string> = row.auth_config
          ? (JSON.parse(row.auth_config) as Record<string, string>)
          : {};
        // Inject access_token from the DB column into authConfig for oauth2/bearer
        if (row.access_token && !authConfig['accessToken']) {
          authConfig['accessToken'] = row.access_token;
        }
        return {
          name: row.name,
          type: row.connector_type,
          enabled: true,
          baseUrl: row.base_url ?? '',
          authType: (row.auth_type ?? 'bearer') as EnterpriseConnectorConfig['authType'],
          authConfig,
          options: row.options ? (JSON.parse(row.options) as Record<string, string>) : undefined,
        };
      });

      return createEnterpriseTools(configs, undefined, { includeExtended: false });
    } catch (err) {
      console.error('[chat] Failed to load enterprise tools:', err);
      return [];
    }
  }

  private async loadEnterpriseToolGroups(): Promise<EnterpriseToolGroup[]> {
    try {
      const rows = await this.db.listEnterpriseConnectors();
      const enabled = rows.filter((r) => r.enabled === 1 && r.status === 'connected');
      if (enabled.length === 0) return [];

      // Auto-refresh expired OAuth tokens before building configs
      await Promise.all(enabled.map((r) => this.refreshTokenIfNeeded(r)));

      const configs: EnterpriseConnectorConfig[] = enabled.map((row) => {
        const authConfig: Record<string, string> = row.auth_config
          ? (JSON.parse(row.auth_config) as Record<string, string>)
          : {};
        if (row.access_token && !authConfig['accessToken']) {
          authConfig['accessToken'] = row.access_token;
        }
        return {
          name: row.name,
          type: row.connector_type,
          enabled: true,
          baseUrl: row.base_url ?? '',
          authType: (row.auth_type ?? 'bearer') as EnterpriseConnectorConfig['authType'],
          authConfig,
          options: row.options ? (JSON.parse(row.options) as Record<string, string>) : undefined,
        };
      });

      return createEnterpriseToolGroups(configs);
    } catch (err) {
      console.error('[chat] Failed to load enterprise tool groups:', err);
      return [];
    }
  }

  // ── Agent execution (non-streaming) ─────────────────────────

  private async runAgent(
    ctx: ExecutionContext,
    model: Model,
    userId: string,
    chatId: string,
    userPersona: string,
    messages: Message[],
    userContent: string,
    settings: ChatSettings,
    attachments?: ChatAttachment[],
  ): Promise<AgentRunTelemetry> {
    const enterpriseToolGroups = await this.loadEnterpriseToolGroups();
    const hasEnterprise = enterpriseToolGroups.length > 0;
    // Flat enterprise tools for backward compat (base tools only, no extended)
    const enterpriseTools = hasEnterprise ? await this.loadEnterpriseTools() : [];
    const toolOptions: ToolRegistryOptions = {
      ...this.toolOptions,
      defaultTimezone: settings.timezone,
      currentUserId: userId,
      currentChatId: chatId,
      currentAttachments: attachments,
      actorPersona: userPersona,
      memoryRecall: async ({ userId: recallUserId, query, limit }) => {
        const boundedLimit = Math.max(1, Math.min(20, limit ?? 5));
        const [semantic, entityRows] = await Promise.all([
          this.db.searchSemanticMemory({ userId: recallUserId, query, limit: boundedLimit }),
          this.db.searchEntities(recallUserId, query),
        ]);
        return {
          semantic: semantic.map((m) => ({ content: m.content, source: m.source })),
          entities: entityRows.map((e) => ({
            entityType: e.entity_type,
            entityName: e.entity_name,
            facts: (this.safeParseJson(e.facts) as Record<string, unknown>) ?? {},
          })),
        };
      },
    };
    const customTools = enterpriseTools.length > 0 ? enterpriseTools : undefined;
    const tools = settings.enabledTools.length
      ? createToolRegistry(settings.enabledTools, customTools, toolOptions)
      : customTools?.length ? createToolRegistry([], customTools, toolOptions) : undefined;

    const agentBus = weaveEventBus();
    const toolCallObserver = this.observeToolCallEvents(agentBus);

    try {
      let agent;
      const forceWorkerDataAnalysis = this.shouldForceWorkerDataAnalysis(userContent, attachments);
      const forceWorkerRequirement = await this.getPolicyPromptTemplate(
        POLICY_PROMPT_FORCED_WORKER_REQUIREMENT,
        FORCED_WORKER_REQUIREMENT,
      );
      const effectiveGoal = forceWorkerDataAnalysis
        ? `${userContent}\n\n${forceWorkerRequirement}`
        : userContent;

      // Load DB-driven worker agents for supervisor mode
      const dbWorkerRows = (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise))
        ? await this.db.listEnabledWorkerAgents()
        : [];

      const routedGoal = effectiveGoal;

      // Auto-upgrade to supervisor when enterprise tools are available
      if (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise)) {
        const baseWorkers = settings.workers.length > 0
          ? settings.workers.map((w) => ({
              name: w.name,
              description: w.description,
              systemPrompt: this.withTemporalToolPolicy(undefined, w.tools),
              model,
              tools: w.tools.length
                ? createToolRegistry(w.tools, customTools, { ...toolOptions, actorPersona: normalizePersona(w.persona, 'agent') })
                : customTools?.length
                  ? createToolRegistry([], customTools, { ...toolOptions, actorPersona: normalizePersona(w.persona, 'agent') })
                  : undefined,
            }))
          : this.buildWorkersFromDb(dbWorkerRows, model, toolOptions, customTools);
        // Build enterprise domain workers from tool groups
        const enterpriseWorkers = await Promise.all(enterpriseToolGroups.map(async (g) => {
          const registry = createToolRegistry([], g.tools, { ...toolOptions, actorPersona: 'agent_researcher' });
          return {
            name: g.name,
            description: g.description,
            systemPrompt: await this.renderPolicyPromptTemplate(
              POLICY_PROMPT_ENTERPRISE_WORKER_SYSTEM,
              ENTERPRISE_WORKER_SYSTEM_PROMPT,
              { description: g.description },
            ),
            model,
            tools: registry,
          };
        }));
        const allWorkers = [...baseWorkers, ...enterpriseWorkers];
        console.log(`[chat] Supervisor with ${allWorkers.length} workers (${baseWorkers.length} base + ${enterpriseWorkers.length} enterprise)`);
        const supervisorCseTools = forceWorkerDataAnalysis
          ? undefined
          : createToolRegistry(
              ['cse_run_code', 'cse_session_status', 'cse_end_session'],
              undefined,
              { ...toolOptions, actorPersona: 'agent_worker' },
            );

        const supervisorInstructions = await this.buildSupervisorInstructions(settings.systemPrompt, forceWorkerDataAnalysis, dbWorkerRows);

        agent = weaveSupervisor({
          model,
          workers: allWorkers,
          maxSteps: 20,
          name: 'geneweave-supervisor',
          instructions: supervisorInstructions,
          additionalTools: supervisorCseTools,
          bus: agentBus,
        });
      } else {
        const policyPrompt = await this.withResponseCardFormatPolicy(this.withTemporalToolPolicy(settings.systemPrompt, settings.enabledTools));
        agent = weaveAgent({
          model,
          tools,
          systemPrompt: policyPrompt,
          maxSteps: 15,
          name: 'geneweave-agent',
          bus: agentBus,
        });
      }

      const result = await this.runWithCseSuccessGuard(
        agent,
        ctx,
        messages,
        routedGoal,
        forceWorkerDataAnalysis,
      );
      return { result, toolCallEvents: toolCallObserver.events };
    } finally {
      toolCallObserver.dispose();
    }
  }

  // ── Agent streaming ─────────────────────────────────────────

  private async streamAgent(
    res: ServerResponse,
    ctx: ExecutionContext,
    model: Model,
    userId: string,
    chatId: string,
    userPersona: string,
    messages: Message[],
    userContent: string,
    settings: ChatSettings,
    attachments?: ChatAttachment[],
  ): Promise<AgentRunTelemetry> {
    const enterpriseToolGroups = await this.loadEnterpriseToolGroups();
    const hasEnterprise = enterpriseToolGroups.length > 0;
    const enterpriseTools = hasEnterprise ? await this.loadEnterpriseTools() : [];
    const toolOptions: ToolRegistryOptions = {
      ...this.toolOptions,
      defaultTimezone: settings.timezone,
      currentUserId: userId,
      currentChatId: chatId,
      currentAttachments: attachments,
      actorPersona: userPersona,
      memoryRecall: async ({ userId: recallUserId, query, limit }) => {
        const boundedLimit = Math.max(1, Math.min(20, limit ?? 5));
        const [semantic, entityRows] = await Promise.all([
          this.db.searchSemanticMemory({ userId: recallUserId, query, limit: boundedLimit }),
          this.db.searchEntities(recallUserId, query),
        ]);
        return {
          semantic: semantic.map((m) => ({ content: m.content, source: m.source })),
          entities: entityRows.map((e) => ({
            entityType: e.entity_type,
            entityName: e.entity_name,
            facts: (this.safeParseJson(e.facts) as Record<string, unknown>) ?? {},
          })),
        };
      },
    };
    const customTools = enterpriseTools.length > 0 ? enterpriseTools : undefined;
    const tools = settings.enabledTools.length
      ? createToolRegistry(settings.enabledTools, customTools, toolOptions)
      : customTools?.length ? createToolRegistry([], customTools, toolOptions) : undefined;

    // Create event bus to capture sub-agent events (e.g. screenshots from workers)
    const agentBus = weaveEventBus();
    const toolCallObserver = this.observeToolCallEvents(agentBus);
    let screenshotUnsub: (() => void) | undefined;

    // Listen for browser_screenshot tool results from any worker and forward via SSE
    screenshotUnsub = agentBus.on(EventTypes.ToolCallEnd, (event) => {
      if (event.data['tool'] === 'browser_screenshot' && typeof event.data['result'] === 'string') {
        try {
          const parsed = JSON.parse(event.data['result'] as string);
          if (parsed.base64) {
            res.write(`data: ${JSON.stringify({ type: 'screenshot', base64: parsed.base64, format: parsed.format || 'png' })}\n\n`);
          }
        } catch { /* not JSON or no base64 — ignore */ }
      }
    });

    try {
      const forceWorkerDataAnalysis = this.shouldForceWorkerDataAnalysis(userContent, attachments);
      const forceWorkerRequirement = await this.getPolicyPromptTemplate(
        POLICY_PROMPT_FORCED_WORKER_REQUIREMENT,
        FORCED_WORKER_REQUIREMENT,
      );
      const effectiveGoal = forceWorkerDataAnalysis
        ? `${userContent}\n\n${forceWorkerRequirement}`
        : userContent;
      const dbWorkerRows = (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise))
        ? await this.db.listEnabledWorkerAgents()
        : [];
      const routedGoal = effectiveGoal;
      let agent;
      if (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise)) {
        const baseWorkers = settings.workers.length > 0
          ? settings.workers.map((w) => ({
              name: w.name,
              description: w.description,
              systemPrompt: this.withTemporalToolPolicy(undefined, w.tools),
              model,
              tools: w.tools.length
                ? createToolRegistry(w.tools, customTools, { ...toolOptions, actorPersona: normalizePersona(w.persona, 'agent') })
                : customTools?.length
                  ? createToolRegistry([], customTools, { ...toolOptions, actorPersona: normalizePersona(w.persona, 'agent') })
                  : undefined,
            }))
          : this.buildWorkersFromDb(dbWorkerRows, model, toolOptions, customTools);
        const enterpriseWorkers = await Promise.all(enterpriseToolGroups.map(async (g) => {
          const registry = createToolRegistry([], g.tools, { ...toolOptions, actorPersona: 'agent_researcher' });
          return {
            name: g.name,
            description: g.description,
            systemPrompt: await this.renderPolicyPromptTemplate(
              POLICY_PROMPT_ENTERPRISE_WORKER_SYSTEM,
              ENTERPRISE_WORKER_SYSTEM_PROMPT,
              { description: g.description },
            ),
            model,
            tools: registry,
          };
        }));
        const allWorkers = [...baseWorkers, ...enterpriseWorkers];
        const supervisorCseToolsStream = forceWorkerDataAnalysis
          ? undefined
          : createToolRegistry(
              ['cse_run_code', 'cse_session_status', 'cse_end_session'],
              undefined,
              { ...toolOptions, actorPersona: 'agent_worker' },
            );

        const supervisorInstructions = await this.buildSupervisorInstructions(settings.systemPrompt, forceWorkerDataAnalysis, dbWorkerRows);
        agent = weaveSupervisor({
          model,
          workers: allWorkers,
          maxSteps: 20,
          name: 'geneweave-supervisor',
          instructions: supervisorInstructions,
          additionalTools: supervisorCseToolsStream,
          bus: agentBus,
        });
      } else {
        const policyPrompt = await this.withResponseCardFormatPolicy(this.withTemporalToolPolicy(settings.systemPrompt, settings.enabledTools));
        agent = weaveAgent({
          model,
          tools,
          systemPrompt: policyPrompt,
          maxSteps: 15,
          name: 'geneweave-agent',
        });
      }

    if (forceWorkerDataAnalysis) {
      const guarded = await this.runWithCseSuccessGuard(agent, ctx, messages, routedGoal, true);
      res.write(`data: ${JSON.stringify({ type: 'text', text: guarded.output })}\n\n`);
      for (const step of guarded.steps) {
        res.write(`data: ${JSON.stringify({
          type: 'step',
          step: { index: step.index, type: step.type, content: step.content, toolCall: step.toolCall, delegation: step.delegation, durationMs: step.durationMs },
          phase: 'step_end',
        })}\n\n`);
      }
      return { result: guarded, toolCallEvents: toolCallObserver.events };
    }

    // Try streaming mode first
    if (agent.runStream) {
      const stream = agent.runStream(ctx, { messages, goal: routedGoal });
      let finalResult: AgentResult | undefined;

      for await (const event of stream) {
        switch (event.type) {
          case 'step_start':
          case 'step_end':
            if (event.step) {
              res.write(`data: ${JSON.stringify({
                type: 'step',
                step: {
                  index: event.step.index,
                  type: event.step.type,
                  content: event.step.content,
                  toolCall: event.step.toolCall,
                  delegation: event.step.delegation,
                  durationMs: event.step.durationMs,
                },
                phase: event.type,
              })}\n\n`);
            }
            break;
          case 'text_chunk':
            if (event.text) {
              res.write(`data: ${JSON.stringify({ type: 'text', text: event.text })}\n\n`);
            }
            break;
          case 'tool_start':
            if (event.step?.toolCall) {
              res.write(`data: ${JSON.stringify({
                type: 'tool_start',
                name: event.step.toolCall.name,
                arguments: event.step.toolCall.arguments,
              })}\n\n`);
            }
            break;
          case 'tool_end':
            if (event.step?.toolCall) {
              res.write(`data: ${JSON.stringify({
                type: 'tool_end',
                name: event.step.toolCall.name,
                result: event.step.toolCall.result,
                durationMs: event.step.durationMs,
              })}\n\n`);
            }
            break;
          case 'done':
            finalResult = event.result;
            break;
        }
      }

      if (finalResult) return { result: finalResult, toolCallEvents: toolCallObserver.events };
    }

    // Fallback: non-streaming agent run, send result as single text event
    const result = await agent.run(ctx, { messages, goal: routedGoal });
    res.write(`data: ${JSON.stringify({ type: 'text', text: result.output })}\n\n`);

    // Send step summaries
    for (const step of result.steps) {
      res.write(`data: ${JSON.stringify({
        type: 'step',
        step: { index: step.index, type: step.type, content: step.content, toolCall: step.toolCall, delegation: step.delegation, durationMs: step.durationMs },
        phase: 'step_end',
      })}\n\n`);
    }

    return { result, toolCallEvents: toolCallObserver.events };
    } finally {
      screenshotUnsub?.();
      toolCallObserver.dispose();
    }
  }

  // ── Redaction ───────────────────────────────────────────────

  private async applyRedaction(
    ctx: ExecutionContext,
    text: string,
    patterns: string[],
  ): Promise<{ redacted: string; wasModified: boolean; detections: Array<{ type: string; start: number; end: number }> }> {
    try {
      const redactor = weaveRedactor({
        patterns: patterns.map((p) => ({ name: p, type: 'builtin' as const, builtinType: p })),
        reversible: true,
      });
      const result = await redactor.redact(ctx, text);
      return {
        redacted: result.redacted,
        wasModified: result.wasModified,
        detections: result.detections.map((d) => ({ type: d.type, start: d.start, end: d.end })),
      };
    } catch {
      return { redacted: text, wasModified: false, detections: [] };
    }
  }

  // ── Post-eval ───────────────────────────────────────────────

  private async runPostEval(
    ctx: ExecutionContext,
    userId: string,
    chatId: string,
    input: string,
    output: string,
    latencyMs: number,
    cost: number,
    guardrailDecision?: 'allow' | 'warn' | 'deny',
  ): Promise<{ passed: number; failed: number; total: number; score: number } | undefined> {
    try {
      const runner = weaveEvalRunner({
        executor: async (_ctx, inp) => ({
          output: inp['output'] as string,
          guardrailDecision: inp['guardrailDecision'] as string,
        }),
      });

      const result = await runner.run(ctx, {
        name: 'chat_response_quality',
        description: 'Quick quality check on chat response',
        type: 'model',
        assertions: [
          { name: 'not_empty', type: 'regex', config: { pattern: '.+' } },
          { name: 'latency_ok', type: 'latency_threshold', config: { maxMs: 30_000 } },
          { name: 'cost_ok', type: 'cost_threshold', config: { maxCostUsd: 1.0 } },
          { name: 'safety', type: 'safety', config: { blockedPhrases: [] } },
          { name: 'guardrail_ok', type: 'guardrail_decision', config: { warnPenalty: 0.25, denyPenalty: 1.0 } },
        ],
      }, [
        { id: 'msg', input: { output, latencyMs, costUsd: cost, guardrailDecision: guardrailDecision ?? 'allow' }, expected: {} },
      ]);

      const info = {
        passed: result.passed,
        failed: result.failed,
        total: result.totalCases * result.results[0]!.assertions.length,
        score: result.avgScore ?? (result.passed / (result.passed + result.failed || 1)),
      };

      // Persist
      await this.db.recordEval({
        id: randomUUID(), userId, chatId,
        evalName: 'chat_response_quality',
        score: info.score, passed: info.passed, failed: info.failed, total: info.total,
        details: JSON.stringify(result.results[0]?.assertions),
      });

      return info;
    } catch {
      return undefined;
    }
  }

  private parseGuardrailConfig(raw: string | null): Record<string, unknown> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private normalizeAttachments(input: ChatAttachment[] | undefined): ChatAttachment[] {
    if (!Array.isArray(input) || input.length === 0) return [];

    const maxCount = 8;
    const maxBytes = 4 * 1024 * 1024;
    const sanitized: ChatAttachment[] = [];

    for (const item of input.slice(0, maxCount)) {
      if (!item || typeof item !== 'object') continue;
      const rawName = typeof item.name === 'string' ? item.name.trim() : '';
      const rawMime = typeof item.mimeType === 'string' ? item.mimeType.trim() : '';
      if (!rawName || !rawMime) continue;

      const normalizedBase64 = typeof item.dataBase64 === 'string'
        ? item.dataBase64.replace(/\s+/g, '')
        : undefined;
      if (normalizedBase64 && !/^[A-Za-z0-9+/=]+$/.test(normalizedBase64)) continue;

      const approximateSize = normalizedBase64
        ? Math.floor((normalizedBase64.length * 3) / 4)
        : (typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0);
      if (approximateSize <= 0 || approximateSize > maxBytes) continue;

      const transcript = typeof item.transcript === 'string' && item.transcript.trim()
        ? item.transcript.trim().slice(0, 12_000)
        : undefined;

      // Strip raw audio bytes — the LLM cannot process audio directly.
      // Only the transcript (if present) is forwarded to the model context.
      const isAudio = rawMime.toLowerCase().startsWith('audio/');
      sanitized.push({
        name: rawName.slice(0, 180),
        mimeType: rawMime.slice(0, 120),
        size: approximateSize,
        dataBase64: isAudio ? undefined : normalizedBase64,
        transcript,
      });
    }

    return sanitized;
  }

  private composeUserInput(content: string, attachments: ChatAttachment[]): string {
    if (attachments.length === 0) return content;
    const attachmentContext = this.buildAttachmentContext(attachments);
    if (!attachmentContext) return content;
    return `${content}\n\n[User attachments]\n${attachmentContext}`;
  }

  private buildAttachmentContext(attachments: ChatAttachment[]): string {
    const lines: string[] = [];
    const maxInlineChars = 12_000;

    for (const attachment of attachments) {
      lines.push(`- ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)`);
      if (attachment.transcript) {
        lines.push(`  transcript: ${attachment.transcript.slice(0, maxInlineChars)}`);
        continue;
      }

      const lowerMime = attachment.mimeType.toLowerCase();
      const maybeText =
        lowerMime.startsWith('text/') ||
        lowerMime === 'application/json' ||
        lowerMime === 'application/xml' ||
        lowerMime === 'application/javascript' ||
        lowerMime === 'application/x-javascript' ||
        lowerMime === 'application/csv' ||
        lowerMime.includes('markdown');

      if (maybeText && attachment.dataBase64) {
        try {
          const decoded = Buffer.from(attachment.dataBase64, 'base64').toString('utf8');
          const compact = decoded.replace(/\r\n/g, '\n').trim();
          if (compact) {
            lines.push(`  content:\n${compact.slice(0, maxInlineChars)}`);
          }
        } catch {
          lines.push('  content: [unable to decode text attachment]');
        }
      }
    }

    return lines.join('\n');
  }

  private patchLatestUserMessage(messages: Message[], content: string): void {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === 'user') {
        messages[i] = { ...msg, content };
        return;
      }
    }
  }

  private stageMatches(rowStage: string, stage: GuardrailStage): boolean {
    if (rowStage === 'both') return true;
    if (rowStage === 'pre' || rowStage === 'pre-execution') return stage === 'pre-execution';
    if (rowStage === 'post' || rowStage === 'post-execution') return stage === 'post-execution';
    return rowStage === stage;
  }

  private normalizeGuardrailStage(rowStage: string, stage: GuardrailStage): GuardrailStage {
    if (rowStage === 'pre') return 'pre-execution';
    if (rowStage === 'post') return 'post-execution';
    if (rowStage === 'both') return stage;
    return rowStage as GuardrailStage;
  }

  private inferRuleName(row: GuardrailRow, config: Record<string, unknown>): string | undefined {
    const explicit = typeof config['check'] === 'string' ? config['check'].trim().toLowerCase() : '';
    const source = explicit || `${row.id} ${row.name}`.toLowerCase();
    if (source.includes('pre') && source.includes('sycoph')) return 'input-pattern';
    if (source.includes('pre') && source.includes('confidence')) return 'risk-confidence-gate';
    if (source.includes('post') && source.includes('ground')) return 'grounding-overlap';
    if (source.includes('post') && source.includes('sycoph')) return 'output-pattern';
    if (source.includes('post') && (source.includes('devil') || source.includes('counterpoint'))) return 'decision-balance';
    if (source.includes('post') && source.includes('confidence')) return 'aggregate-confidence-gate';
    return undefined;
  }

  private patternConfigFromNames(patterns: unknown): Record<string, unknown> {
    if (!Array.isArray(patterns)) return {};
    const library: Record<string, string> = {
      email: '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}',
      phone: '\\+?\\d[\\d(). -]{7,}\\d',
      ssn: '\\b\\d{3}-\\d{2}-\\d{4}\\b',
      credit_card: '\\b(?:\\d[ -]*?){13,16}\\b',
    };
    const parts = patterns
      .map((value) => typeof value === 'string' ? library[value] : undefined)
      .filter((value): value is string => !!value);
    return parts.length ? { pattern: `(${parts.join('|')})`, action: 'warn' } : {};
  }

  private normalizeGuardrail(row: GuardrailRow, stage: GuardrailStage): Guardrail {
    const config = this.parseGuardrailConfig(row.config);
    const normalizedStage = this.normalizeGuardrailStage(row.stage, stage);

    if (row.type === 'cognitive' || row.type === 'cognitive_check') {
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        type: 'custom',
        stage: normalizedStage,
        enabled: !!row.enabled,
        priority: row.priority,
        config: {
          ...config,
          category: 'cognitive',
          rule: this.inferRuleName(row, config),
          pattern_target: typeof config['check'] === 'string' && String(config['check']).includes('post_') ? 'output' : 'input',
        },
      };
    }

    if (row.type === 'factuality') {
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        type: 'custom',
        stage: normalizedStage,
        enabled: !!row.enabled,
        priority: row.priority,
        config: {
          ...config,
          category: 'verification',
          rule: 'grounding-overlap',
          min_overlap: typeof config['confidence_threshold'] === 'number' ? Number(config['confidence_threshold']) / 10 : config['min_overlap'],
        },
      };
    }

    if (row.type === 'budget') {
      const maxInputTokens = typeof config['max_input_tokens'] === 'number' ? Number(config['max_input_tokens']) : undefined;
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        type: 'length',
        stage: normalizedStage,
        enabled: !!row.enabled,
        priority: row.priority,
        config: {
          ...config,
          maxLength: typeof config['maxLength'] === 'number' ? config['maxLength'] : maxInputTokens ? maxInputTokens * 4 : undefined,
          action: config['action'] === 'deny' || config['action'] === 'warn' ? config['action'] : 'warn',
        },
      };
    }

    if (row.type === 'redaction' || row.type === 'pii_detection') {
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        type: 'regex',
        stage: normalizedStage,
        enabled: !!row.enabled,
        priority: row.priority,
        config: {
          ...this.patternConfigFromNames(config['patterns']),
          ...config,
        },
      };
    }

    if (row.type === 'content_filter') {
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? undefined,
        type: 'blocklist',
        stage: normalizedStage,
        enabled: !!row.enabled,
        priority: row.priority,
        config: {
          ...config,
          words: Array.isArray(config['words']) ? config['words'] : Array.isArray(config['categories']) ? config['categories'] : [],
          action: config['action'] === 'deny' || config['action'] === 'warn' ? config['action'] : 'warn',
        },
      };
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      type: row.type as Guardrail['type'],
      stage: normalizedStage,
      enabled: !!row.enabled,
      config,
      priority: row.priority,
    };
  }

  // ── Trace persistence ───────────────────────────────────────

  private observeToolCallEvents(eventBus: EventBus): { events: ToolCallObservableEvent[]; dispose: () => void } {
    const events: ToolCallObservableEvent[] = [];
    const unsubscribers: Array<() => void> = [];

    unsubscribers.push(eventBus.on(EventTypes.ToolCallStart, (event) => {
      events.push({
        phase: 'start',
        timestamp: event.timestamp,
        executionId: event.executionId,
        spanId: event.spanId,
        data: event.data,
      });
    }));

    unsubscribers.push(eventBus.on(EventTypes.ToolCallEnd, (event) => {
      events.push({
        phase: 'end',
        timestamp: event.timestamp,
        executionId: event.executionId,
        spanId: event.spanId,
        data: event.data,
      });
    }));

    unsubscribers.push(eventBus.on(EventTypes.ToolCallError, (event) => {
      events.push({
        phase: 'error',
        timestamp: event.timestamp,
        executionId: event.executionId,
        spanId: event.spanId,
        data: event.data,
      });
    }));

    return {
      events,
      dispose: () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      },
    };
  }

  private async recordTraceSpans(
    userId: string,
    chatId: string,
    messageId: string,
    traceId: string,
    mode: string,
    startMs: number,
    latencyMs: number,
    steps?: AgentStep[],
    toolCallEvents?: ToolCallObservableEvent[],
  ): Promise<void> {
    try {
      // Root span
      const rootSpanId = randomUUID();
      await this.db.saveTrace({
        id: randomUUID(), userId, chatId, messageId,
        traceId, spanId: rootSpanId,
        name: `chat.${mode}`,
        startTime: startMs, endTime: startMs + latencyMs,
        status: 'ok',
        attributes: JSON.stringify({ mode }),
      });

      // Child spans for agent steps
      if (steps) {
        let offset = startMs;
        for (const step of steps) {
          await this.db.saveTrace({
            id: randomUUID(), userId, chatId, messageId,
            traceId, spanId: randomUUID(), parentSpanId: rootSpanId,
            name: `step.${step.type}${step.toolCall ? `.${step.toolCall.name}` : ''}`,
            startTime: offset, endTime: offset + step.durationMs,
            status: 'ok',
            attributes: JSON.stringify({
              stepIndex: step.index,
              type: step.type,
              toolCall: step.toolCall,
              delegation: step.delegation,
              tokenUsage: step.tokenUsage,
            }),
          });
          offset += step.durationMs;
        }
      }

      if (toolCallEvents?.length) {
        const starts = new Map<string, ToolCallObservableEvent[]>();
        const pending: ToolCallObservableEvent[] = [];

        const keyFor = (event: ToolCallObservableEvent, toolName: string): string =>
          `${event.executionId ?? ''}|${event.spanId ?? ''}|${toolName}`;

        const toolNameFor = (event: ToolCallObservableEvent): string => {
          const fromData = event.data['tool'];
          if (typeof fromData === 'string' && fromData.trim()) return fromData;
          const fromName = event.data['name'];
          if (typeof fromName === 'string' && fromName.trim()) return fromName;
          return 'unknown';
        };

        for (const event of toolCallEvents) {
          const toolName = toolNameFor(event);
          const key = keyFor(event, toolName);
          if (event.phase === 'start') {
            const arr = starts.get(key) ?? [];
            arr.push(event);
            starts.set(key, arr);
            continue;
          }

          const arr = starts.get(key);
          const start = arr?.shift();
          if (arr && arr.length === 0) starts.delete(key);

          const spanStart = start?.timestamp ?? event.timestamp;
          const spanEnd = Math.max(event.timestamp, spanStart + 1);
          pending.push({
            ...event,
            timestamp: spanEnd,
            data: {
              ...event.data,
              _toolName: toolName,
              _startTime: spanStart,
            },
          });
        }

        for (const event of pending) {
          const toolName = (typeof event.data['_toolName'] === 'string' && event.data['_toolName']) ? event.data['_toolName'] as string : 'unknown';
          const spanStart = typeof event.data['_startTime'] === 'number' ? event.data['_startTime'] as number : event.timestamp;
          const status = event.phase === 'error' ? 'error' : 'ok';
          const attributes = { ...event.data };
          delete (attributes as Record<string, unknown>)['_toolName'];
          delete (attributes as Record<string, unknown>)['_startTime'];

          await this.db.saveTrace({
            id: randomUUID(), userId, chatId, messageId,
            traceId,
            spanId: event.spanId ?? randomUUID(),
            parentSpanId: rootSpanId,
            name: `tool_call.${toolName}`,
            startTime: spanStart,
            endTime: event.timestamp,
            status,
            attributes: JSON.stringify({
              phase: event.phase,
              executionId: event.executionId,
              tool: toolName,
              data: attributes,
            }),
          });
        }
      }
    } catch {
      // Trace recording is best-effort
    }
  }

  /** Available models based on configured providers + DB pricing table */
  async getAvailableModels(): Promise<Array<{ id: string; provider: string }>> {
    const seen = new Set<string>();
    const models: Array<{ id: string; provider: string }> = [];
    const configuredProviders = new Set(Object.keys(this.config.providers));

    // First, pull enabled models from the DB pricing table
    try {
      const rows = await this.db.listModelPricing();
      for (const row of rows) {
        if (row.enabled && configuredProviders.has(row.provider)) {
          const key = `${row.provider}:${row.model_id}`;
          if (!seen.has(key)) {
            seen.add(key);
            models.push({ id: row.model_id, provider: row.provider });
          }
        }
      }
    } catch {
      // DB lookup is best-effort; fall through to hardcoded fallback
    }

    // Merge hardcoded fallback models (for providers with no DB rows yet)
    const FALLBACK_MODELS: Record<string, string[]> = {
      anthropic: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-4-20250414'],
      openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o4-mini'],
    };
    for (const provider of configuredProviders) {
      const fallback = FALLBACK_MODELS[provider];
      if (fallback) {
        for (const id of fallback) {
          const key = `${provider}:${id}`;
          if (!seen.has(key)) {
            seen.add(key);
            models.push({ id, provider });
          }
        }
      }
    }
    return models;
  }

  // ── Guardrail evaluation ────────────────────────────────────

  private async evaluateGuardrails(
    chatId: string,
    messageId: string | null,
    input: string,
    stage: GuardrailStage,
    refs?: { userInput?: string; assistantOutput?: string; toolEvidence?: string },
  ): Promise<{ decision: 'allow' | 'deny' | 'warn'; reason?: string; results: GuardrailResult[]; cognitive?: CognitiveCheckSummary }> {
    try {
      const rows = await this.db.listGuardrails();
      const enabledRows = rows.filter(r => r.enabled && this.stageMatches(r.stage, stage));
      const guardrails: Guardrail[] = enabledRows.map(r => this.normalizeGuardrail(r, stage));

      const pipeline = createGuardrailPipeline(guardrails, { shortCircuitOnDeny: true });
      const results = guardrails.length > 0
        ? await pipeline.evaluate(input, stage, {
            userInput: refs?.userInput ?? input,
            assistantOutput: refs?.assistantOutput,
            toolEvidence: refs?.toolEvidence,
            action: refs?.userInput ?? input,
          })
        : [];
      const cognitive = summarizeGuardrailResults(results, 'cognitive') ?? undefined;

      const decision = hasDeny(results) ? 'deny' as const : hasWarning(results) ? 'warn' as const : 'allow' as const;
      const reason = getDenyReason(results);

      // Persist evaluation
      await this.db.createGuardrailEval({
        id: randomUUID(),
        chat_id: chatId,
        message_id: messageId,
        stage,
        input_preview: input.slice(0, 100),
        results: JSON.stringify(results),
        overall_decision: decision,
      });

      return { decision, reason, results, cognitive };
    } catch {
      return { decision: 'allow', results: [] };
    }
  }

  // ── Human-task policy evaluation ────────────────────────────

  private async evaluateTaskPolicies(
    steps: AgentStep[],
  ): Promise<Array<{ tool: string; policy: string; taskType: string; priority: string }>> {
    try {
      const rows = await this.db.listHumanTaskPolicies();
      const enabledRows = rows.filter(r => r.enabled);
      if (enabledRows.length === 0) return [];

      const evaluator = new PolicyEvaluator();
      for (const row of enabledRows) {
        evaluator.addPolicy(createPolicy({
          name: row.name,
          description: row.description ?? undefined,
          trigger: row.trigger,
          taskType: row.task_type as any,
          defaultPriority: row.default_priority as any,
          slaHours: row.sla_hours ?? undefined,
          autoEscalateAfterHours: row.auto_escalate_after_hours ?? undefined,
          assignmentStrategy: row.assignment_strategy as any,
          assignTo: row.assign_to ?? undefined,
          enabled: true,
        }));
      }

      const checks: Array<{ tool: string; policy: string; taskType: string; priority: string }> = [];
      for (const step of steps) {
        if (step.toolCall) {
          const result = evaluator.check({ trigger: step.toolCall.name });
          if (result.required && result.policy) {
            checks.push({
              tool: step.toolCall.name,
              policy: result.policy.name,
              taskType: result.policy.taskType,
              priority: result.policy.defaultPriority,
            });
          }
        }
      }

      return checks;
    } catch {
      return [];
    }
  }

  // ── Prompt resolution from DB ───────────────────────────────

  /**
   * Resolve system prompt: if the settings reference a prompt by name/id,
   * look it up in the prompts table and render its template. Falls back to
   * the plain system_prompt string.
   */
  private async resolveSystemPrompt(settings: ChatSettings): Promise<ResolvedSystemPrompt> {
    if (!settings.systemPrompt) return { content: undefined };

    try {
      // Check if the system prompt references a DB prompt by name
      const rows = await this.db.listPrompts();
      const match = rows.find(
        r => r.enabled && (r.id === settings.systemPrompt || r.name === settings.systemPrompt),
      );
      if (match) {
        const versions = await this.db.listPromptVersions(match.id);
        const experiments = await this.db.listPromptExperiments(match.id);
        const resolved = resolvePromptRecordForExecution({
          prompt: match,
          versions,
          experiments,
          options: {
            assignmentKey: match.id,
          },
        });

        const vars: Record<string, unknown> = {};
        const promptVersion = createPromptVersionFromRecord(resolved.record);
        if ('variables' in promptVersion) {
          for (const variable of promptVersion.variables) {
            vars[variable.name] = variable.defaultValue ?? `[${variable.name}]`;
          }
        }

        // Build a fragment registry from enabled DB fragments, then pre-expand
        // {{>key}} inclusions in the template before passing to renderPromptRecord.
        // This lets prompt authors compose templates from reusable fragment blocks
        // without requiring any change to the base rendering pipeline.
        let resolvedMatch = resolved.record;
        try {
          const fragmentRows = await this.db.listPromptFragments();
          const enabledFragments = fragmentRows.filter(f => f.enabled);
          if (enabledFragments.length > 0) {
            const fragmentRegistry = new InMemoryFragmentRegistry();
            for (const row of enabledFragments) {
              fragmentRegistry.register(fragmentFromRecord(row));
            }
            const baseTemplate = resolved.record.template ?? '';
            const expandedTemplate = resolveFragments(baseTemplate, fragmentRegistry);
            if (expandedTemplate !== baseTemplate) {
              // Create a shallow copy with the expanded template for rendering
              resolvedMatch = { ...resolved.record, template: expandedTemplate };
            }
          }
        } catch {
          // Fragment expansion failure is non-fatal — fall through to raw template
        }

        // Build strategy registry from built-in shared strategies plus enabled
        // DB-defined overlays so behavior stays package-driven and DB-configurable.
        const strategyRegistry = new InMemoryPromptStrategyRegistry(defaultPromptStrategyRegistry.list());
        try {
          const strategyRows = await this.db.listPromptStrategies();
          for (const row of strategyRows) {
            if (!row.enabled) continue;
            strategyRegistry.register(strategyFromRecord(row));
          }
        } catch {
          // Strategy loading failure is non-fatal — fallback to built-ins only.
        }

        const executed = executePromptRecord(resolvedMatch, vars, {
          strategyRegistry,
          evaluations: [
            {
              id: 'prompt_not_empty',
              description: 'Rendered system prompt should not be empty to avoid unbounded model behavior.',
              evaluate: ({ content }) => ({
                passed: content.trim().length > 0,
                score: content.trim().length > 0 ? 1 : 0,
                reason: content.trim().length > 0 ? undefined : 'Rendered prompt content is empty',
              }),
            },
          ],
        });

        return {
          content: executed.content,
          strategy: this.toPromptStrategyInfo(executed),
          resolution: resolved.meta,
        };
      }
    } catch {
      // Fall through to plain text
    }

    return { content: settings.systemPrompt };
  }

  private toPromptStrategyInfo(result: PromptRecordExecutionResult): PromptStrategyInfo {
    return {
      requestedKey: result.strategy.requestedKey,
      resolvedKey: result.strategy.resolvedKey,
      usedFallback: result.strategy.usedFallback,
      name: result.strategy.name,
      description: result.strategy.description,
      metadata: result.strategy.metadata,
    };
  }

  // ── Model routing from DB ───────────────────────────────────

  /**
   * Select model + provider using the active routing policy from the DB.
   * Returns null if no enabled policy exists (caller falls back to default).
   */
  private async routeModel(opts?: { provider?: string; model?: string }): Promise<{ provider: string; modelId: string } | null> {
    try {
      const policies = await this.db.listRoutingPolicies();
      const active = policies.find(p => p.enabled);
      if (!active) return null;

      // Build candidate list from configured providers
      const candidates = (await this.getAvailableModels()).map(m => ({
        modelId: m.id,
        providerId: m.provider,
      }));

      if (candidates.length === 0) return null;

      // Load pricing & quality from DB (falls back to hardcoded if DB is empty)
      const pricingRows = await this.db.listModelPricing();
      const pricingMap = new Map(pricingRows.filter(r => r.enabled).map(r => [`${r.provider}:${r.model_id}`, r]));

      // Cost data from DB model_pricing table
      const costs: ModelCostInfo[] = candidates.map(c => {
        const row = pricingMap.get(`${c.providerId}:${c.modelId}`);
        const fb = FALLBACK_PRICING[c.modelId];
        return {
          modelId: c.modelId,
          providerId: c.providerId,
          inputCostPer1M: row ? row.input_cost_per_1m : fb ? fb.input : 10,
          outputCostPer1M: row ? row.output_cost_per_1m : fb ? fb.output : 30,
        };
      });

      // Quality scores from DB model_pricing table
      const qualities: ModelQualityInfo[] = candidates.map(c => {
        const row = pricingMap.get(`${c.providerId}:${c.modelId}`);
        return {
          modelId: c.modelId,
          providerId: c.providerId,
          qualityScore: row ? row.quality_score : 0.7,
        };
      });

      const router = new SmartModelRouter({ candidates, costs, qualities });

      // Copy health data
      for (const h of this.healthTracker.listHealth()) {
        router.recordOutcome(
          { modelId: h.modelId, providerId: h.providerId, reason: '', scores: {}, alternatives: [], timestamp: '' },
          { latencyMs: h.avgLatencyMs, success: h.errorRate < 0.5 },
        );
      }

      const decision = await router.route(
        { prompt: '' },
        {
          id: active.id,
          name: active.name,
          strategy: active.strategy as any,
          constraints: active.constraints ? JSON.parse(active.constraints) : undefined,
          weights: active.weights ? JSON.parse(active.weights) : undefined,
          fallbackModelId: active.fallback_model ?? undefined,
          fallbackProviderId: active.fallback_provider ?? undefined,
          enabled: true,
        },
      );

      return { provider: decision.providerId, modelId: decision.modelId };
    } catch {
      return null;
    }
  }

  // ── Memory helpers ─────────────────────────────────────────────────────────

  private async loadExtractionRules(): Promise<MemoryExtractionRule[]> {
    const rows = await this.db.listMemoryExtractionRules();
    return rows.map((r) => {
      let factsTemplate: Record<string, unknown> | null = null;
      try {
        factsTemplate = r.facts_template ? JSON.parse(r.facts_template) as Record<string, unknown> : null;
      } catch {
        factsTemplate = null;
      }
      return {
        id: r.id,
        ruleType: r.rule_type as MemoryExtractionRule['ruleType'],
        entityType: r.entity_type,
        pattern: r.pattern,
        flags: r.flags,
        factsTemplate,
        priority: r.priority,
        enabled: !!r.enabled,
      };
    });
  }

  private safeParseJson(text: string): unknown {
    const trimmed = text.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const raw = fenced?.[1] ?? trimmed;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private sanitizeExtractedEntities(raw: unknown): Array<{ name: string; type: string; facts: Record<string, unknown> }> {
    if (!Array.isArray(raw)) return [];
    const allowedTypes = new Set(['person', 'location', 'organization', 'preference', 'topic', 'general']);
    const out: Array<{ name: string; type: string; facts: Record<string, unknown> }> = [];
    for (const item of raw.slice(0, 8)) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { name?: unknown; type?: unknown; facts?: unknown };
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      if (!name || name.length > 120) continue;
      const typeRaw = typeof row.type === 'string' ? row.type.toLowerCase().trim() : 'general';
      const type = allowedTypes.has(typeRaw) ? typeRaw : 'general';
      const facts = (row.facts && typeof row.facts === 'object' && !Array.isArray(row.facts))
        ? (row.facts as Record<string, unknown>)
        : {};
      out.push({ name, type, facts });
    }
    return out;
  }

  private async extractEntitiesWithModel(
    ctx: ExecutionContext,
    model: Model,
    userContent: string,
    assistantContent: string,
  ): Promise<ExtractedEntity[]> {
    const request: ModelRequest = {
      messages: [
        {
          role: 'system',
          content: [
            'You extract durable user profile entities from a conversation turn.',
            'Think carefully about stable facts, but output JSON only.',
            'Return a JSON array, each item as: {"name": string, "type": "person|location|organization|preference|topic|general", "facts": object}.',
            'Only include entities that are explicitly stated or strongly implied by the user.',
            'Do not include temporary tasks or speculative details.',
            'If nothing durable is present, return [].',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `User message: ${userContent}`,
            `Assistant response: ${assistantContent.slice(0, 600)}`,
            'Return JSON array only.',
          ].join('\n\n'),
        },
      ],
      maxTokens: 500,
      temperature: 0,
    };
    const res = await model.generate(ctx, request);
    const parsed = this.safeParseJson(res.content);
    return this.sanitizeExtractedEntities(parsed).map((e) => ({
      ...e,
      confidence: 0.78,
      source: 'llm' as const,
    }));
  }

  private async classifyIdentityRecallIntent(ctx: ExecutionContext, model: Model, query: string): Promise<boolean> {
    const regexSignal = /\b(name|who\s+am\s+i|who\s+i\s+am|what\s+am\s+i\s+called|what'?s\s+my\s+name|remember\s+my\s+name|do\s+you\s+know\s+who\s+i\s+am)\b/i.test(query);
    if (regexSignal) return true;

    // Avoid model classification for long prompts where identity intent is unlikely.
    if (query.length > 180) return false;

    try {
      const request: ModelRequest = {
        messages: [
          {
            role: 'system',
            content: [
              'Classify whether the user is asking the assistant to recall who the user is based on prior memory.',
              'Return ONLY one token: YES or NO.',
              'Use YES for questions about identity, name, personal profile, or remembered user details from prior chats.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: query,
          },
        ],
        maxTokens: 3,
        temperature: 0,
      };
      const res = await model.generate(ctx, request);
      return /^\s*yes\b/i.test(res.content);
    } catch {
      return false;
    }
  }

  private isIdentityRecallQuery(query: string): boolean {
    return /\b(do\s+you\s+know\s+who\s+i\s+am|who\s+am\s+i|who\s+i\s+am|do\s+you\s+remember\s+me|do\s+you\s+know\s+my\s+name|what(?:'|\s+)?s\s+my\s+name|remember\s+my\s+name)\b/i.test(query);
  }

  private async resolveIdentityRecallFromMemory(userId: string, query: string): Promise<string | null> {
    if (!this.isIdentityRecallQuery(query)) return null;

    const [entities, semanticRows] = await Promise.all([
      this.db.listEntities(userId),
      this.db.listSemanticMemory(userId, 24),
    ]);

    let name: string | null = null;
    let location: string | null = null;

    const personEntity = entities.find((e) => e.entity_type.toLowerCase() === 'person');
    if (personEntity?.entity_name) {
      name = personEntity.entity_name.trim();
    }
    const locationEntity = entities.find((e) => e.entity_type.toLowerCase() === 'location');
    if (locationEntity?.entity_name) {
      location = locationEntity.entity_name.trim();
    }

    const semanticPriority = semanticRows
      .filter((m) => m.memory_type === 'user_fact' || m.source === 'user')
      .concat(semanticRows.filter((m) => !(m.memory_type === 'user_fact' || m.source === 'user')));

    for (const m of semanticPriority) {
      if (!name) {
        const nm = m.content.match(/\b(?:my\s+name\s+is|i\s+am|i'?m\s+called|call\s+me)\s+([A-Za-z][A-Za-z\-']{1,39})\b/i);
        if (nm?.[1]) name = nm[1].trim();
      }
      if (!location) {
        const lm = m.content.match(/\b(?:i\s+live\s+in|i'?m\s+from|i\s+am\s+from|i\s+reside\s+in)\s+([A-Za-z][A-Za-z\s\-']{1,50}?)(?=\s+(?:and|but)\b|[,.!?]|$)/i);
        if (lm?.[1]) location = lm[1].trim();
      }
      if (name && location) break;
    }

    if (name && location) {
      return `From our previous chats, you are ${name} and you live in ${location}.`;
    }
    if (name) {
      return `From our previous chats, you are ${name}.`;
    }
    if (location) {
      return `From our previous chats, I remember that you live in ${location}.`;
    }
    return null;
  }

  private async buildMemoryContext(ctx: ExecutionContext, model: Model, userId: string, query: string): Promise<string | null> {
    try {
      const identityQuery = await this.classifyIdentityRecallIntent(ctx, model, query);
      const entityPromise = identityQuery
        ? this.db.listEntities(userId).then((rows) => rows.slice(0, 10))
        : this.db.searchEntities(userId, query);
      const [semanticMatches, entityMatches, recentSemantic] = await Promise.all([
        this.db.searchSemanticMemory({ userId, query, limit: 5 }),
        entityPromise,
        identityQuery ? this.db.listSemanticMemory(userId, 12) : Promise.resolve([]),
      ]);

      const semanticForContext = semanticMatches.length > 0
        ? semanticMatches
        : (identityQuery
          ? recentSemantic.filter((m) => m.memory_type === 'user_fact' || m.source === 'user').slice(0, 5)
          : []);

      if (semanticForContext.length === 0 && entityMatches.length === 0) return null;
      const parts: string[] = ['[Long-term memory from past conversations]'];

      let inferredIdentityName: string | null = null;
      if (identityQuery) {
        const person = entityMatches.find((e) => e.entity_type.toLowerCase() === 'person');
        if (person?.entity_name) {
          inferredIdentityName = person.entity_name;
        } else {
          for (const m of semanticForContext) {
            const nameMatch = m.content.match(/\bmy\s+name\s+is\s+([A-Za-z][A-Za-z\-']{1,39})\b/i);
            if (nameMatch?.[1]) {
              inferredIdentityName = nameMatch[1];
              break;
            }
          }
        }
      }

      if (identityQuery) {
        parts.push('Identity recall request detected. Use these memories to identify the user when possible.');
        parts.push('If a name or identity fact is present below, answer directly from memory and do not claim you lack memory.');
        if (inferredIdentityName) {
          parts.push(`Most likely user name from memory: "${inferredIdentityName}".`);
        }
      }
      if (entityMatches.length > 0) {
        parts.push('Known facts about this user:');
        for (const e of entityMatches) {
          const factsObj = JSON.parse(e.facts) as Record<string, unknown>;
          const factsStr = Object.entries(factsObj)
            .filter(([k]) => !k.startsWith('noted_'))
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
          parts.push(`  • ${e.entity_type} "${e.entity_name}"${factsStr ? ' — ' + factsStr : ''}`);
        }
      }
      if (semanticForContext.length > 0) {
        parts.push('Relevant memories:');
        for (const m of semanticForContext) {
          const label = m.source === 'user' ? 'User stated' : 'Previously discussed';
          parts.push(`  • [${label}] ${m.content.slice(0, 200)}`);
        }
      }
      return parts.join('\n');
    } catch {
      return null;
    }
  }

  private async saveToMemory(
    ctx: ExecutionContext,
    model: Model,
    userId: string,
    chatId: string,
    userContent: string,
    assistantContent: string,
  ): Promise<void> {
    const rules = await this.loadExtractionRules();
    const extraction = await runHybridMemoryExtraction({
      ctx,
      input: { userContent, assistantContent },
      rules,
      llmExtractor: async (innerCtx, input) => this.extractEntitiesWithModel(innerCtx, model, input.userContent, input.assistantContent ?? ''),
    });

    if (extraction.selfDisclosure && userContent.length > 5) {
      await this.db.saveSemanticMemory({
        id: randomUUID(),
        userId,
        chatId,
        content: userContent.slice(0, 600),
        memoryType: 'user_fact',
        source: 'user',
      });
    }
    if (assistantContent.length > 100) {
      await this.db.saveSemanticMemory({
        id: randomUUID(),
        userId,
        chatId,
        content: assistantContent.slice(0, 600),
        memoryType: 'summary',
        source: 'assistant',
      });
    }

    for (const e of extraction.entities) {
      await this.db.upsertEntity({
        userId,
        entityName: e.name,
        entityType: e.type,
        facts: e.facts,
        confidence: e.confidence,
        source: e.source,
        chatId,
      });
    }

    const regexEntitiesCount = extraction.entities.filter((e) => e.source === 'regex').length;
    const llmEntitiesCount = extraction.entities.filter((e) => e.source === 'llm').length;
    await this.db.recordMemoryExtractionEvent({
      id: randomUUID(),
      userId,
      chatId,
      selfDisclosure: extraction.selfDisclosure,
      regexEntitiesCount,
      llmEntitiesCount,
      mergedEntitiesCount: extraction.entities.length,
      events: JSON.stringify(extraction.events),
    });
  }

  /**
   * Resolve the best-matching cache policy from admin-configured policies.
   */
  private async resolveActiveCache(mode: string): Promise<CachePolicy | null> {
    try {
      const rows = await this.db.listCachePolicies();
      const enabled = rows.filter(r => r.enabled);
      if (!enabled.length) return null;
      const policies: CachePolicy[] = enabled.map(r => ({
        id: r.id,
        name: r.name,
        scope: (r.scope as CachePolicy['scope']) ?? 'global',
        ttlMs: r.ttl_ms ?? 300_000,
        maxEntries: r.max_entries ?? 1000,
        bypassPatterns: r.bypass_patterns ? JSON.parse(r.bypass_patterns) : [],
        invalidateOnEvents: r.invalidate_on ? JSON.parse(r.invalidate_on) : [],
        enabled: true,
      }));
      return resolvePolicy(policies, {}) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Record model outcome for health tracking.
   */
  recordModelOutcome(modelId: string, providerId: string, latencyMs: number, success: boolean): void {
    this.healthTracker.record(modelId, providerId, { latencyMs, success });
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function historyToMessages(rows: MessageRow[]): Message[] {
  return rows.map((r) => ({
    role: r.role as Message['role'],
    content: r.content,
  }));
}
