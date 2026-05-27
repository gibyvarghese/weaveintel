/**
 * @weaveintel/routing — Default seed data
 *
 * Exports:
 *   DEFAULT_ROUTING_POLICIES   — 3 routing strategy rows
 *   DEFAULT_MODEL_PRICING      — 23 model pricing rows (all providers)
 *   DEFAULT_TASK_TYPES         — 16 anyWeave task taxonomy rows
 *   DEFAULT_PROVIDER_ADAPTERS  — 4 provider tool adapter rows (openai, anthropic, google, ollama)
 *
 * All rows are plain typed objects. Import in your app seed and call the
 * appropriate `db.createXxx()` method for each row.
 *
 * @example
 * ```ts
 * import { DEFAULT_MODEL_PRICING } from '@weaveintel/routing';
 * const existing = await db.listModelPricing();
 * if (existing.length === 0) {
 *   for (const p of DEFAULT_MODEL_PRICING) await db.createModelPricing(p);
 * }
 * ```
 */

// ── Routing Policies ─────────────────────────────────────────────────────────

export type RoutingPolicySeedRow = {
  id: string;
  name: string;
  description: string;
  strategy: string;
  constraints: string | null;
  weights: string;
  fallback_model: string;
  fallback_provider: string;
  enabled: 0 | 1;
};

export const DEFAULT_ROUTING_POLICIES: RoutingPolicySeedRow[] = [
  {
    id: 'a2cdb3b9-cd89-48d8-884d-ce617a9ca328',
    name: 'Cost Optimized',
    description: 'Route to the cheapest model that meets quality thresholds',
    strategy: 'cost',
    constraints: JSON.stringify({ min_quality_score: 0.7 }),
    weights: JSON.stringify({ cost: 0.7, quality: 0.2, latency: 0.1 }),
    fallback_model: 'gpt-4o-mini', fallback_provider: 'openai', enabled: 1,
  },
  {
    id: 'eea58ad8-5c94-4aba-98ce-850c4a567e31',
    name: 'Quality First',
    description: 'Always route to the highest quality model available',
    strategy: 'quality',
    constraints: null,
    weights: JSON.stringify({ cost: 0.1, quality: 0.8, latency: 0.1 }),
    fallback_model: 'claude-sonnet-4-6', fallback_provider: 'anthropic', enabled: 1,
  },
  {
    id: 'b6bcb4e8-16e2-4c40-b5a6-50bc15912c23',
    name: 'Balanced',
    description: 'Balance between cost, quality and speed',
    strategy: 'balanced',
    constraints: null,
    weights: JSON.stringify({ cost: 0.33, quality: 0.34, latency: 0.33 }),
    fallback_model: 'gpt-4o', fallback_provider: 'openai', enabled: 1,
  },
];

// ── Model Pricing ─────────────────────────────────────────────────────────────

export type ModelPricingSeedRow = {
  id: string;
  model_id: string;
  provider: string;
  display_name: string;
  input_cost_per_1m: number;
  output_cost_per_1m: number;
  quality_score: number;
  source: string;
  last_synced_at: null;
  enabled: 0 | 1;
};

export const DEFAULT_MODEL_PRICING: ModelPricingSeedRow[] = [
  // Anthropic — public list prices from anthropic.com/pricing
  { id: '24c261e4-3cd0-48da-aba5-ad65cdc4ba84', model_id: 'claude-sonnet-4-6',         provider: 'anthropic', display_name: 'Claude Sonnet 4.6',         input_cost_per_1m: 3.00,  output_cost_per_1m: 15.00, quality_score: 0.87, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: '3a01332c-7062-46f4-ac27-23718d0b7e11', model_id: 'claude-opus-4-7',           provider: 'anthropic', display_name: 'Claude Opus 4.7',           input_cost_per_1m: 15.00, output_cost_per_1m: 75.00, quality_score: 0.95, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: '7a159bca-cd4a-4008-9adf-537d3f9087a5', model_id: 'claude-haiku-4-5-20251001', provider: 'anthropic', display_name: 'Claude Haiku 4.5', input_cost_per_1m: 0.80,  output_cost_per_1m: 4.00,  quality_score: 0.72, source: 'seed', last_synced_at: null, enabled: 1 },
  // OpenAI — public list prices from platform.openai.com/docs/pricing
  { id: 'd544e807-dd8b-45fc-8d7c-4c35b00fe34c', model_id: 'gpt-4o',                   provider: 'openai',    display_name: 'GPT-4o',                   input_cost_per_1m: 2.50,  output_cost_per_1m: 10.00, quality_score: 0.90, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: '453e9a1e-b374-436b-bbed-58ba0a0db737', model_id: 'gpt-4o-mini',               provider: 'openai',    display_name: 'GPT-4o Mini',               input_cost_per_1m: 0.15,  output_cost_per_1m: 0.60,  quality_score: 0.75, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: '5a851707-9a6f-434f-9c8f-e6bc02647e90', model_id: 'gpt-4.1',                   provider: 'openai',    display_name: 'GPT-4.1',                   input_cost_per_1m: 2.00,  output_cost_per_1m: 8.00,  quality_score: 0.90, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: 'b2c6d495-f58e-40f1-aff2-d58050aabedb', model_id: 'gpt-4.1-mini',              provider: 'openai',    display_name: 'GPT-4.1 Mini',              input_cost_per_1m: 0.40,  output_cost_per_1m: 1.60,  quality_score: 0.75, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: 'bf5734a5-3552-4068-a80d-457c25f927ab', model_id: 'gpt-4.1-nano',              provider: 'openai',    display_name: 'GPT-4.1 Nano',              input_cost_per_1m: 0.10,  output_cost_per_1m: 0.40,  quality_score: 0.60, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: '5190bfc2-0601-4153-8563-a6f5811bdcae', model_id: 'o3',                        provider: 'openai',    display_name: 'o3',                        input_cost_per_1m: 2.00,  output_cost_per_1m: 8.00,  quality_score: 0.85, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: 'f7c3f6b4-f3de-4070-a547-f37359aa0ca4', model_id: 'o4-mini',                   provider: 'openai',    display_name: 'o4 Mini',                   input_cost_per_1m: 1.10,  output_cost_per_1m: 4.40,  quality_score: 0.75, source: 'seed', last_synced_at: null, enabled: 1 },
  // Google Gemini — public list prices from ai.google.dev/pricing
  { id: 'a1b2c3d4-0001-4000-8000-000000000001', model_id: 'gemini-2.5-pro',            provider: 'google',    display_name: 'Gemini 2.5 Pro',            input_cost_per_1m: 1.25,  output_cost_per_1m: 10.00, quality_score: 0.92, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: 'a1b2c3d4-0001-4000-8000-000000000002', model_id: 'gemini-2.5-flash',          provider: 'google',    display_name: 'Gemini 2.5 Flash',          input_cost_per_1m: 0.30,  output_cost_per_1m: 2.50,  quality_score: 0.82, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: 'a1b2c3d4-0001-4000-8000-000000000003', model_id: 'gemini-2.5-flash-lite',     provider: 'google',    display_name: 'Gemini 2.5 Flash Lite',     input_cost_per_1m: 0.10,  output_cost_per_1m: 0.40,  quality_score: 0.72, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: 'a1b2c3d4-0001-4000-8000-000000000004', model_id: 'gemini-1.5-pro',            provider: 'google',    display_name: 'Gemini 1.5 Pro',            input_cost_per_1m: 1.25,  output_cost_per_1m: 5.00,  quality_score: 0.85, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: 'a1b2c3d4-0001-4000-8000-000000000005', model_id: 'gemini-1.5-flash',          provider: 'google',    display_name: 'Gemini 1.5 Flash',          input_cost_per_1m: 0.075, output_cost_per_1m: 0.30,  quality_score: 0.72, source: 'seed', last_synced_at: null, enabled: 1 },
  // Ollama (local) — zero cost; quality is a heuristic operators can override
  { id: 'a1b2c3d4-0002-4000-8000-000000000001', model_id: 'llama3.1',                  provider: 'ollama',    display_name: 'Llama 3.1 (local)',         input_cost_per_1m: 0,     output_cost_per_1m: 0,     quality_score: 0.72, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: 'a1b2c3d4-0002-4000-8000-000000000002', model_id: 'llama3',                    provider: 'ollama',    display_name: 'Llama 3 (local)',           input_cost_per_1m: 0,     output_cost_per_1m: 0,     quality_score: 0.70, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: 'a1b2c3d4-0002-4000-8000-000000000003', model_id: 'qwen2.5',                   provider: 'ollama',    display_name: 'Qwen 2.5 (local)',          input_cost_per_1m: 0,     output_cost_per_1m: 0,     quality_score: 0.74, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: 'a1b2c3d4-0002-4000-8000-000000000004', model_id: 'mistral',                   provider: 'ollama',    display_name: 'Mistral (local)',           input_cost_per_1m: 0,     output_cost_per_1m: 0,     quality_score: 0.68, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: 'a1b2c3d4-0002-4000-8000-000000000005', model_id: 'phi3',                      provider: 'ollama',    display_name: 'Phi 3 (local)',             input_cost_per_1m: 0,     output_cost_per_1m: 0,     quality_score: 0.65, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: 'a1b2c3d4-0002-4000-8000-000000000006', model_id: 'gemma2',                    provider: 'ollama',    display_name: 'Gemma 2 (local)',           input_cost_per_1m: 0,     output_cost_per_1m: 0,     quality_score: 0.66, source: 'seed', last_synced_at: null, enabled: 1 },
  { id: 'a1b2c3d4-0002-4000-8000-000000000007', model_id: 'deepseek-r1',               provider: 'ollama',    display_name: 'DeepSeek R1 (local)',       input_cost_per_1m: 0,     output_cost_per_1m: 0,     quality_score: 0.80, source: 'seed', last_synced_at: null, enabled: 1 },
  // llama.cpp — direct local inference without Ollama
  { id: 'a1b2c3d4-0003-4000-8000-000000000001', model_id: 'local',                     provider: 'llamacpp',  display_name: 'Local Model (llama.cpp)',   input_cost_per_1m: 0,     output_cost_per_1m: 0,     quality_score: 0.65, source: 'seed', last_synced_at: null, enabled: 0 },
];

// ── anyWeave Task Type Definitions ────────────────────────────────────────────

export type TaskTypeSeedRow = {
  task_key: string;
  display_name: string;
  category: string;
  description: string;
  output_modality: string;
  default_strategy: string;
  default_weights: { cost: number; speed: number; quality: number; capability: number };
  inference_hints: Record<string, unknown>;
};

export const DEFAULT_TASK_TYPES: TaskTypeSeedRow[] = [
  { task_key: 'reasoning',          display_name: 'Reasoning',               category: 'cognitive',          description: 'Multi-step deduction, planning, math word problems.',       output_modality: 'text',      default_strategy: 'quality',    default_weights: { cost: 0.10, speed: 0.10, quality: 0.50, capability: 0.30 }, inference_hints: { keywords: ['why', 'explain', 'prove', 'solve', 'plan', 'derive'] } },
  { task_key: 'summarization',      display_name: 'Summarization',           category: 'text-transform',     description: 'Condense long input into shorter form.',                    output_modality: 'text',      default_strategy: 'cost',       default_weights: { cost: 0.45, speed: 0.30, quality: 0.20, capability: 0.05 }, inference_hints: { keywords: ['summarize', 'tl;dr', 'condense', 'short version'] } },
  { task_key: 'translation',        display_name: 'Translation',             category: 'text-transform',     description: 'Convert text between natural languages.',                   output_modality: 'text',      default_strategy: 'balanced',   default_weights: { cost: 0.30, speed: 0.30, quality: 0.30, capability: 0.10 }, inference_hints: { keywords: ['translate', 'in french', 'in spanish', 'in chinese'] } },
  { task_key: 'classification',     display_name: 'Classification',          category: 'text-transform',     description: 'Assign labels / categories to input.',                      output_modality: 'text',      default_strategy: 'cost',       default_weights: { cost: 0.50, speed: 0.30, quality: 0.15, capability: 0.05 }, inference_hints: { keywords: ['classify', 'categorize', 'label', 'tag'] } },
  { task_key: 'extraction',         display_name: 'Information Extraction',  category: 'text-transform',     description: 'Pull structured fields from unstructured text.',            output_modality: 'text',      default_strategy: 'balanced',   default_weights: { cost: 0.30, speed: 0.20, quality: 0.40, capability: 0.10 }, inference_hints: { keywords: ['extract', 'parse', 'pull out', 'find all'] } },
  { task_key: 'qa',                 display_name: 'Question Answering',      category: 'cognitive',          description: 'Answer factual / contextual questions.',                    output_modality: 'text',      default_strategy: 'balanced',   default_weights: { cost: 0.25, speed: 0.25, quality: 0.40, capability: 0.10 }, inference_hints: { keywords: ['what', 'who', 'when', 'where', 'how many'] } },
  { task_key: 'code_generation',    display_name: 'Code Generation',         category: 'code',               description: 'Write new code from a natural language spec.',              output_modality: 'code',      default_strategy: 'quality',    default_weights: { cost: 0.15, speed: 0.15, quality: 0.50, capability: 0.20 }, inference_hints: { keywords: ['write a function', 'generate code', 'implement', 'build a'] } },
  { task_key: 'code_debug',         display_name: 'Code Debugging',          category: 'code',               description: 'Diagnose and fix existing code.',                           output_modality: 'code',      default_strategy: 'quality',    default_weights: { cost: 0.10, speed: 0.10, quality: 0.55, capability: 0.25 }, inference_hints: { keywords: ['fix this', 'debug', 'why does this fail', 'error in'] } },
  { task_key: 'code_review',        display_name: 'Code Review',             category: 'code',               description: 'Critique style, correctness, security of code.',            output_modality: 'text',      default_strategy: 'quality',    default_weights: { cost: 0.15, speed: 0.15, quality: 0.50, capability: 0.20 }, inference_hints: { keywords: ['review', 'audit', 'critique', 'lgtm', 'pr feedback'] } },
  { task_key: 'creative_writing',   display_name: 'Creative Writing',        category: 'generative-text',    description: 'Stories, poems, marketing copy, ideation.',                 output_modality: 'text',      default_strategy: 'quality',    default_weights: { cost: 0.20, speed: 0.10, quality: 0.50, capability: 0.20 }, inference_hints: { keywords: ['write a story', 'poem', 'tagline', 'ad copy', 'creative'] } },
  { task_key: 'conversation',       display_name: 'Conversation',            category: 'generative-text',    description: 'Open-ended chat / assistant-style dialogue.',               output_modality: 'text',      default_strategy: 'balanced',   default_weights: { cost: 0.30, speed: 0.30, quality: 0.30, capability: 0.10 }, inference_hints: { keywords: ['chat', 'talk', 'tell me', 'help me'] } },
  { task_key: 'tool_use',           display_name: 'Tool / Function Calling', category: 'agentic',            description: 'Multi-turn function calling, agent loops.',                 output_modality: 'text',      default_strategy: 'capability', default_weights: { cost: 0.15, speed: 0.20, quality: 0.30, capability: 0.35 }, inference_hints: { keywords: ['call api', 'use tool', 'fetch', 'search the web', 'lookup'] } },
  { task_key: 'vision_understanding', display_name: 'Vision Understanding',  category: 'multimodal-input',   description: 'Read / describe images and screenshots.',                   output_modality: 'text',      default_strategy: 'capability', default_weights: { cost: 0.15, speed: 0.15, quality: 0.40, capability: 0.30 }, inference_hints: { requiresVision: true, keywords: ['image', 'screenshot', 'photo', 'describe this picture'] } },
  { task_key: 'image_generation',   display_name: 'Image Generation',        category: 'generative-image',   description: 'Create images from text prompts.',                          output_modality: 'image',     default_strategy: 'quality',    default_weights: { cost: 0.20, speed: 0.15, quality: 0.45, capability: 0.20 }, inference_hints: { keywords: ['draw', 'generate image', 'illustrate', 'render'] } },
  { task_key: 'speech_to_text',     display_name: 'Speech-to-Text',          category: 'multimodal-input',   description: 'Transcribe audio into text.',                               output_modality: 'text',      default_strategy: 'capability', default_weights: { cost: 0.30, speed: 0.30, quality: 0.30, capability: 0.10 }, inference_hints: { keywords: ['transcribe', 'audio', 'voice', 'recording'] } },
  { task_key: 'embedding',          display_name: 'Embedding',               category: 'representation',     description: 'Generate fixed-length vector representations.',             output_modality: 'embedding', default_strategy: 'cost',       default_weights: { cost: 0.50, speed: 0.30, quality: 0.15, capability: 0.05 }, inference_hints: { keywords: ['embed', 'vector', 'semantic search'] } },
];

// ── Provider Tool Adapters ───────────────────────────────────────────────────

export type ProviderAdapterSeedRow = {
  provider: string;
  display_name: string;
  adapter_module: string;
  tool_format: string;
  tool_call_response_format: string;
  tool_result_format: string;
  system_prompt_location: string;
  name_validation_regex: string;
  max_tool_count: number;
  enabled: 0 | 1;
};

export const DEFAULT_PROVIDER_ADAPTERS: ProviderAdapterSeedRow[] = [
  {
    provider: 'openai',
    display_name: 'OpenAI Chat Completions / Responses',
    adapter_module: '@weaveintel/tool-schema/openai',
    tool_format: 'openai_json',
    tool_call_response_format: 'tool_calls_array',
    tool_result_format: 'tool_message',
    system_prompt_location: 'system_message',
    name_validation_regex: '^[a-zA-Z0-9_-]{1,64}$',
    max_tool_count: 128,
    enabled: 1,
  },
  {
    provider: 'anthropic',
    display_name: 'Anthropic Messages',
    adapter_module: '@weaveintel/tool-schema/anthropic',
    tool_format: 'anthropic_xml',
    tool_call_response_format: 'tool_use_block',
    tool_result_format: 'tool_result_block',
    system_prompt_location: 'separate_field',
    name_validation_regex: '^[a-zA-Z0-9_-]{1,64}$',
    max_tool_count: 64,
    enabled: 1,
  },
  {
    provider: 'google',
    display_name: 'Google Gemini',
    adapter_module: '@weaveintel/tool-schema/google',
    tool_format: 'google_function',
    tool_call_response_format: 'function_call',
    tool_result_format: 'function_response',
    system_prompt_location: 'system_message',
    name_validation_regex: '^[a-zA-Z][a-zA-Z0-9_]{0,63}$',
    max_tool_count: 64,
    enabled: 1,
  },
  {
    provider: 'ollama',
    display_name: 'Ollama (OpenAI-compatible)',
    adapter_module: '@weaveintel/tool-schema/openai',
    tool_format: 'openai_json',
    tool_call_response_format: 'tool_calls_array',
    tool_result_format: 'tool_message',
    system_prompt_location: 'system_message',
    name_validation_regex: '^[a-zA-Z0-9_-]{1,64}$',
    max_tool_count: 64,
    enabled: 1,
  },
];
