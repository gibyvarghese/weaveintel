/**
 * Example 68 - unified model-attention for research topics
 *
 * Demonstrates live-agents aligned with weaveAgent's model handling:
 *   1. Model is selected externally (direct or routed via SmartModelRouter)
 *   2. Model is passed to createHeartbeat (required, like weaveAgent)
 *   3. Attention policy receives model in context and can use it
 *
 * Simulated topic inputs into a live-agents mesh (no Gmail required).
 *
 * Run:
 *   npx tsx examples/68-live-agents-routed-attention-research-topics.ts
 */

import 'dotenv/config';

import {
  weaveContext,
  type Tool,
  type ExecutionContext,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from '@weaveintel/core';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';
import { createSearchRouter, createSearchTools, type SearchResult } from '@weaveintel/tools-search';
import { ComputeSandboxEngine, createCSETools } from '@weaveintel/sandbox';
import {
  createActionExecutor,
  createHeartbeat,
  createModelAttentionPolicy,
  weaveInMemoryStateStore,
  type ActionExecutionContext,
  type ActionExecutionResult,
  type ActionExecutor,
  type AgentContract,
  type HeartbeatTick,
  type LiveAgent,
  type Mesh,
  type Message,
} from '@weaveintel/live-agents';

const REAL_LLM_FLAG = process.env['LIVE_AGENTS_REAL_LLM'];
const REAL_LLM_MODEL = process.env['LIVE_AGENTS_REAL_LLM_MODEL'] ?? 'gpt-4o-mini';

type SearchToolSet = {
  router: ReturnType<typeof createSearchRouter>;
  tools: Tool[];
  enabledProviderNames: string[];
};

type CseToolSet = {
  engine: ComputeSandboxEngine;
  tools: ReturnType<typeof createCSETools>;
};

type ResearchTooling = {
  search: SearchToolSet;
  cse: CseToolSet | null;
  availableToolNames: string[];
};

function shouldUseRealLlm(): boolean {
  if (REAL_LLM_FLAG === '1') return true;
  if (REAL_LLM_FLAG === '0') return false;
  return Boolean(process.env['OPENAI_API_KEY']);
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function flow(step: string, detail: string): void {
  console.log(`[FLOW] ${step} :: ${detail}`);
}

function nextTickIso(nowIso: string, minutes: number): string {
  return new Date(Date.parse(nowIso) + minutes * 60_000).toISOString();
}

function parseContextJsonFromModelRequest(request: ModelRequest): Record<string, unknown> | null {
  const userMessage = request.messages.find((m) => m.role === 'user');
  if (!userMessage || typeof userMessage.content !== 'string') {
    return null;
  }
  const marker = 'Context JSON:\n';
  const idx = userMessage.content.indexOf(marker);
  if (idx < 0) return null;
  const jsonText = userMessage.content.slice(idx + marker.length).trim();
  try {
    return JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseTopicFromPrompt(request: ModelRequest): string | null {
  const userMessage = request.messages.find((m) => m.role === 'user');
  if (!userMessage || typeof userMessage.content !== 'string') {
    return null;
  }
  const match = userMessage.content.match(/Topic:\s*(.+)/i);
  return match?.[1]?.trim() ?? null;
}

function createResearchTopicModel(modelId: string): Model {
  return {
    info: {
      provider: 'demo',
      modelId,
      capabilities: new Set(),
    },
    capabilities: new Set(),
    hasCapability: () => false,
    async generate(_ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      const payload = parseContextJsonFromModelRequest(request);
      if (!payload) {
        const topic = parseTopicFromPrompt(request) ?? 'Unknown topic';
        return {
          id: `resp-${modelId}-${Date.now()}`,
          content: [
            `Research brief for ${topic}`,
            '',
            `Summary: ${topic} remains a high-signal area worth monitoring for policy, technical, and market shifts.`,
            'Key points:',
            `- Recent activity indicates meaningful progress and unresolved risk around ${topic}.`,
            `- Teams should track regulation, supply-chain dependencies, and validation evidence relevant to ${topic}.`,
            `- Near-term action: assign an owner, watch new primary sources, and refresh the brief weekly.`,
          ].join('\n'),
          finishReason: 'stop',
          usage: { promptTokens: 80, completionTokens: 70, totalTokens: 150 },
          model: modelId,
        };
      }
      const inbox = Array.isArray(payload?.['inbox']) ? payload['inbox'] as Array<Record<string, unknown>> : [];
      const backlog = Array.isArray(payload?.['backlog']) ? payload['backlog'] as Array<Record<string, unknown>> : [];
      const nowIso = typeof payload?.['nowIso'] === 'string' ? payload['nowIso'] : new Date().toISOString();

      const pending = inbox.find((m) => m['status'] === 'PENDING' || m['status'] === 'DELIVERED');
      const inProgress = backlog.find((b) => b['status'] === 'IN_PROGRESS');
      const accepted = backlog.find((b) => b['status'] === 'ACCEPTED' || b['status'] === 'PROPOSED');

      let action: Record<string, unknown>;
      if (pending && typeof pending['id'] === 'string') {
        action = { type: 'ProcessMessage', messageId: pending['id'] };
      } else if (inProgress && typeof inProgress['id'] === 'string') {
        action = { type: 'ContinueTask', backlogItemId: inProgress['id'] };
      } else if (accepted && typeof accepted['id'] === 'string') {
        action = { type: 'StartTask', backlogItemId: accepted['id'] };
      } else {
        action = { type: 'CheckpointAndRest', nextTickAt: nextTickIso(nowIso, 10) };
      }

      return {
        id: `resp-${modelId}-${Date.now()}`,
        content: JSON.stringify({ action, reason: `simulated:${modelId}` }),
        finishReason: 'stop',
        usage: { promptTokens: 40, completionTokens: 12, totalTokens: 52 },
        model: modelId,
      };
    },
  };
}

function createOpenAIResearchTopicModel(modelId: string): Model {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required when LIVE_AGENTS_REAL_LLM=1');
  }
  return weaveOpenAIModel(modelId, { apiKey });
}

function buildSearchToolSet(): SearchToolSet {
  const configs = {
    duckduckgo: { name: 'duckduckgo', enabled: true, priority: 50 },
    ...(process.env['TAVILY_API_KEY']
      ? { tavily: { name: 'tavily', enabled: true, apiKey: process.env['TAVILY_API_KEY'], priority: 5 } }
      : {}),
    ...(process.env['BRAVE_API_KEY']
      ? { brave: { name: 'brave', enabled: true, apiKey: process.env['BRAVE_API_KEY'], priority: 10 } }
      : {}),
    ...(process.env['GOOGLE_PSE_KEY'] && process.env['GOOGLE_PSE_CX']
      ? {
          'google-pse': {
            name: 'google-pse',
            enabled: true,
            apiKey: process.env['GOOGLE_PSE_KEY'],
            priority: 15,
            options: { cx: process.env['GOOGLE_PSE_CX'] },
          },
        }
      : {}),
    ...(process.env['SERPER_API_KEY']
      ? { serper: { name: 'serper', enabled: true, apiKey: process.env['SERPER_API_KEY'], priority: 20 } }
      : {}),
    ...(process.env['EXA_API_KEY']
      ? { exa: { name: 'exa', enabled: true, apiKey: process.env['EXA_API_KEY'], priority: 25 } }
      : {}),
  };

  const router = createSearchRouter({
    fallback: true,
    configs,
  });

  return {
    router,
    tools: createSearchTools(router),
    enabledProviderNames: Object.values(configs).map((config) => config.name),
  };
}

async function buildResearchTooling(userId: string): Promise<ResearchTooling> {
  const search = buildSearchToolSet();
  let cse: CseToolSet | null = null;

  try {
    const engine = await ComputeSandboxEngine.create();
    cse = {
      engine,
      tools: createCSETools({ cse: engine, userId, chatId: 'example-68-research' }),
    };
  } catch (error) {
    flow('tools', `cse unavailable (${error instanceof Error ? error.message : String(error)})`);
  }

  return {
    search,
    cse,
    availableToolNames: [
      'search.query',
      'search.all',
      ...search.enabledProviderNames.map((providerName) => `search.${providerName}`),
      ...(cse ? cse.tools.map((tool) => tool.name) : []),
    ],
  };
}

async function collectWebEvidence(
  tooling: ResearchTooling,
  topic: string,
  ctx: ExecutionContext,
): Promise<{ summary: string; results: SearchResult[] }> {
  const searchAllTool = tooling.search.tools.find((tool) => tool.schema.name === 'search.all');
  if (!searchAllTool) {
    return { summary: 'No search tool configured.', results: [] };
  }

  const output = await searchAllTool.invoke(ctx, {
    name: 'search.all',
    arguments: { query: topic, limit: 5 },
  });

  const parsed = JSON.parse(output.content) as Array<{
    provider: string;
    results: SearchResult[];
    latencyMs: number;
    error?: string;
  }>;
  flow('web_search', `${topic} :: ${parsed.map((entry) => `${entry.provider}=${entry.results.length}`).join(', ')}`);

  const flattened = parsed.flatMap((entry) => entry.results.map((result) => ({ ...result, source: entry.provider })));
  const uniqueResults: SearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const result of flattened) {
    if (seenUrls.has(result.url)) continue;
    seenUrls.add(result.url);
    uniqueResults.push(result);
    if (uniqueResults.length >= 5) break;
  }

  const providerSummary = parsed
    .map((entry) => `${entry.provider}:${entry.results.length}${entry.error ? ` (error: ${entry.error})` : ''}`)
    .join(', ');
  const resultSummary = uniqueResults.length
    ? uniqueResults
        .map((result, index) => `${index + 1}. ${result.title} | ${result.url} | ${result.snippet}`)
        .join('\n')
    : 'No search results returned.';

  return {
    summary: `Providers: ${providerSummary}\nResults:\n${resultSummary}`,
    results: uniqueResults,
  };
}

async function runCseAnalysis(
  tooling: ResearchTooling,
  topic: string,
  results: SearchResult[],
): Promise<string> {
  if (!tooling.cse) {
    return 'CSE unavailable.';
  }

  const runCodeTool = tooling.cse.tools.find((tool) => tool.name === 'cse_run_code');
  if (!runCodeTool) {
    return 'CSE tool handler unavailable.';
  }

  const script = [
    'import json',
    'from urllib.parse import urlparse',
    '',
    "with open('/workspace/search_results.json', 'r', encoding='utf-8') as f:",
    '    rows = json.load(f)',
    '',
    'domains = []',
    'for row in rows:',
    "    url = row.get('url', '')",
    '    if not url:',
    '        continue',
    '    domains.append(urlparse(url).netloc)',
    '',
    'domain_counts = {}',
    'for domain in domains:',
    '    domain_counts[domain] = domain_counts.get(domain, 0) + 1',
    '',
    'summary = {',
    `    'topic': ${JSON.stringify(topic)},`,
    "    'result_count': len(rows),",
    "    'unique_domains': len(domain_counts),",
    "    'top_domains': sorted(domain_counts.items(), key=lambda item: (-item[1], item[0]))[:5],",
    "    'titles': [row.get('title', '') for row in rows[:5]],",
    '}',
    'print(json.dumps(summary))',
  ].join('\n');

  const response = await runCodeTool.handler({
    code: script,
    language: 'python',
    chatId: `example-68-${topic.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    files: [
      {
        name: 'search_results.json',
        content: JSON.stringify(results, null, 2),
      },
    ],
    timeoutMs: 15000,
    networkAccess: false,
  }) as { output?: unknown; stdout?: string; error?: string; status?: string };
  flow('cse', `${topic} :: ${response.status ?? (response.error ? 'error' : 'ok')}`);

  if (response.error) {
    return `CSE error: ${response.error}`;
  }
  if (response.output) {
    return JSON.stringify(response.output);
  }
  return response.stdout?.trim() || `CSE status: ${response.status ?? 'unknown'}`;
}

function buildContract(agentId: string, createdAt: string): AgentContract {
  return {
    id: 'contract-research-sim-v1',
    agentId,
    version: 1,
    persona: 'You are a research-topic coordinator.',
    objectives: 'Process inbound research topics and keep queue flowing.',
    successIndicators: 'All inbound topic messages are processed promptly.',
    budget: {
      monthlyUsdCap: 50,
      perActionUsdCap: 5,
    },
    workingHoursSchedule: {
      timezone: 'UTC',
      cronActive: '* * * * *',
    },
    grantAuthority: null,
    contractAuthority: null,
    breakGlass: null,
    accountBindingRefs: [],
    attentionPolicyRef: 'routed-model-research-topics-v1',
    reviewCadence: 'P1D',
    contextPolicy: {
      compressors: [],
      weighting: [],
      budgets: {
        attentionTokensMax: 1000,
        actionTokensMax: 800,
        handoffTokensMax: 400,
        reportTokensMax: 300,
        monthlyCompressionUsdCap: 3,
      },
      defaultsProfile: 'knowledge-worker',
    },
    createdAt,
  };
}

function extractTopic(message: Message): string {
  const prefix = 'Research Topic: ';
  if (message.subject.startsWith(prefix)) {
    return message.subject.slice(prefix.length).trim();
  }
  return message.subject.trim();
}

async function generateResearchBrief(
  model: Model,
  ctx: ExecutionContext,
  message: Message,
  tooling: ResearchTooling,
): Promise<string> {
  const topic = extractTopic(message);
  const webEvidence = await collectWebEvidence(tooling, topic, ctx);
  const cseAnalysis = await runCseAnalysis(tooling, topic, webEvidence.results);
  const response = await model.generate(ctx, {
    messages: [
      {
        role: 'system',
        content: [
          'You are a concise research analyst.',
          'Produce a short actionable brief with these sections: Summary, Signals, Risks, Next steps, Sources.',
          'Use plain text only.',
          'Ground the brief in the provided web-search and CSE evidence.',
          'If the evidence is weak or conflicting, say so explicitly.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          `Topic: ${topic}`,
          `Original request: ${message.body}`,
          'Prepare a research brief using the evidence below plus general model knowledge where needed.',
          'If you are uncertain, say so clearly and avoid fabricated citations.',
          '',
          'Web search evidence:',
          webEvidence.summary,
          '',
          'CSE analysis:',
          cseAnalysis,
        ].join('\n'),
      },
    ],
  });
  return typeof response.content === 'string' ? response.content.trim() : JSON.stringify(response.content);
}

function createResearchActionExecutor(model: Model, tooling: ResearchTooling): ActionExecutor {
  const baseExecutor = createActionExecutor();

  return {
    async execute(action, context: ActionExecutionContext, ctx: ExecutionContext): Promise<ActionExecutionResult> {
      if (action.type !== 'ProcessMessage') {
        return baseExecutor.execute(action, context, ctx);
      }

      const sourceMessage = await context.stateStore.loadMessage(action.messageId);
      if (!sourceMessage) {
        return baseExecutor.execute(action, context, ctx);
      }

  const baseResult = await baseExecutor.execute(action, context, ctx);
  const brief = await generateResearchBrief(model, ctx, sourceMessage, tooling);
      const replyId = makeId('msg-research-brief');
      const reply: Message = {
        id: replyId,
        meshId: sourceMessage.meshId,
        fromType: 'AGENT',
        fromId: context.agent.id,
        fromMeshId: null,
        toType: 'HUMAN',
        toId: sourceMessage.fromId,
        topic: sourceMessage.topic,
        kind: 'REPLY',
        replyToMessageId: sourceMessage.id,
        threadId: sourceMessage.threadId,
        contextRefs: [sourceMessage.id],
        contextPacketRef: null,
        expiresAt: null,
        priority: 'NORMAL',
        status: 'DELIVERED',
        deliveredAt: context.nowIso,
        readAt: null,
        processedAt: null,
        createdAt: context.nowIso,
        subject: `Research Brief: ${extractTopic(sourceMessage)}`,
        body: brief,
      };
      await context.stateStore.saveMessage(reply);
      console.log(`\n[RESEARCH OUTPUT] ${reply.subject}\n${brief}\n`);

      return {
        ...baseResult,
        summaryProse: `${baseResult.summaryProse}; generated research brief ${replyId}`,
        createdMessageIds: [...baseResult.createdMessageIds, replyId],
      };
    },
  };
}

async function queueTick(store: ReturnType<typeof weaveInMemoryStateStore>, agent: LiveAgent, workerId: string): Promise<void> {
  const tick: HeartbeatTick = {
    id: makeId('tick'),
    agentId: agent.id,
    scheduledFor: new Date().toISOString(),
    pickedUpAt: null,
    completedAt: null,
    workerId,
    leaseExpiresAt: null,
    actionChosen: null,
    actionOutcomeProse: null,
    actionOutcomeStatus: null,
    status: 'SCHEDULED',
  };
  await store.saveHeartbeatTick(tick);
}

async function saveTopicMessage(
  store: ReturnType<typeof weaveInMemoryStateStore>,
  mesh: Mesh,
  agent: LiveAgent,
  topic: string,
): Promise<Message> {
  const now = new Date().toISOString();
  const message: Message = {
    id: makeId('msg-topic'),
    meshId: mesh.id,
    fromType: 'HUMAN',
    fromId: 'human-research-ops',
    fromMeshId: null,
    toType: 'AGENT',
    toId: agent.id,
    topic: 'research-topic',
    kind: 'ASK',
    replyToMessageId: null,
    threadId: makeId('thread-topic'),
    contextRefs: [],
    contextPacketRef: null,
    expiresAt: null,
    priority: 'HIGH',
    status: 'PENDING',
    deliveredAt: null,
    readAt: null,
    processedAt: null,
    createdAt: now,
    subject: `Research Topic: ${topic}`,
    body: `Investigate and summarize latest developments for: ${topic}`,
  };
  await store.saveMessage(message);
  return message;
}

async function main() {
  const useRealLlm = shouldUseRealLlm();
  const tooling = await buildResearchTooling('human-research-ops');

  // Step 1: Select model externally (direct or routed)
  // This aligns with weaveAgent's pattern: model selection is external
  const attentionModel = useRealLlm
    ? createOpenAIResearchTopicModel(REAL_LLM_MODEL)
    : createResearchTopicModel('research-simulated');

  console.log(`Attention model mode: ${useRealLlm ? `real-llm (${REAL_LLM_MODEL})` : 'simulated'}`);
  flow('tools', `available ${tooling.availableToolNames.join(', ')}`);

  // Step 2: Create runtime (mesh, agent, store)
  const store = weaveInMemoryStateStore();
  const now = new Date().toISOString();

  const mesh: Mesh = {
    id: 'mesh-research-topics-sim',
    tenantId: 'tenant-research-topics',
    name: 'Research Topic Simulation Mesh',
    charter: 'Simulate model-driven attention with research topic ingress.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  const agent: LiveAgent = {
    id: 'agent-topic-manager',
    meshId: mesh.id,
    name: 'Topic Manager',
    role: 'Research Coordinator',
    contractVersionId: 'contract-research-sim-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  await store.saveMesh(mesh);
  await store.saveAgent(agent);
  await store.saveContract(buildContract(agent.id, now));

  // Step 3: Create heartbeat with selected model (required, like weaveAgent)
  const heartbeat = createHeartbeat({
    stateStore: store,
    workerId: 'worker-topic-sim',
    concurrency: 1,
    model: attentionModel,
    attentionPolicy: createModelAttentionPolicy({
      // Policy receives model via context, uses it for attention decisions
      systemPrompt: 'You are a research-topic attention planner. Decide what action to take next.',
      maxInboxItems: 10,
      maxBacklogItems: 10,
    }),
    actionExecutor: createResearchActionExecutor(attentionModel, tooling),
  });

  const topics = [
    'CRISPR base-editing safety trends',
    'Battery supply chain risk in 2026',
    'EU AI Act compliance for clinical copilots',
  ];

  const ctx = weaveContext({
    userId: 'human-research-ops',
    tenantId: mesh.tenantId,
  });

  console.log(`\nProcessing ${topics.length} research topics through mesh...`);

  for (const topic of topics) {
    const msg = await saveTopicMessage(store, mesh, agent, topic);
    flow('ingress', `queued topic message ${msg.id} for: ${topic}`);

    await queueTick(store, agent, 'scheduler-topic-sim');
    const tickResult = await heartbeat.tick(ctx);
    flow('tick', `processed=${tickResult.processed} after topic ingress`);

    const updated = await store.loadMessage(msg.id);
    flow('status', `${msg.id} -> ${updated?.status ?? 'missing'}`);
  }

  const inbox = await store.listMessagesForRecipient('AGENT', agent.id);
  const processed = inbox.filter((m) => m.status === 'PROCESSED').length;
  const humanMessages = await store.listMessagesForRecipient('HUMAN', 'human-research-ops');
  const researchReplies = humanMessages.filter((m) => m.subject.startsWith('Research Brief: '));

  console.log(`\n✓ Processed topic messages: ${processed}/${topics.length}`);
  console.log(`✓ Generated research briefs: ${researchReplies.length}/${topics.length}`);

  await tooling.cse?.engine.shutdown();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
