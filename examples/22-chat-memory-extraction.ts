/**
 * Example 22: Chat-Style Memory Extraction (No DB)
 *
 * Mirrors geneWeave chat pipeline memory behavior in a DB-free setup:
 * - Detect self-disclosure signals from user text
 * - Extract durable entities (name, location, preferences) with regex rules
 * - Merge optional LLM extraction results (hybrid extraction)
 * - Execute tools in the chat turn (datetime, calculator, duckduckgo search)
 * - Save results into in-memory semantic + entity stores
 * - Build lightweight "memory context" for future turns
 *
 * Run: npx tsx examples/22-chat-memory-extraction.ts
 */
import {
  weaveContext,
  weaveTool,
  weaveToolRegistry,
  type ExecutionContext,
  type MemoryEntry,
  type ToolRegistry,
} from '@weaveintel/core';
import {
  weaveMemoryStore,
  runHybridMemoryExtraction,
  type LlmEntityExtractor,
  type MemoryExtractionRule,
} from '@weaveintel/memory';

const rules: MemoryExtractionRule[] = [
  {
    id: 'self-disclosure-profile',
    ruleType: 'self_disclosure',
    pattern: String.raw`\b(my name is|i am|i'm|call me|i live in|i like|i prefer)\b`,
    flags: 'i',
    priority: 100,
    enabled: true,
  },
  {
    id: 'entity-name',
    ruleType: 'entity_extraction',
    entityType: 'person',
    pattern: String.raw`\b(?:my name is|i am|i'm|call me)\s+([A-Za-z][A-Za-z\-']{1,39})\b`,
    flags: 'i',
    factsTemplate: { source: 'self_disclosure' },
    priority: 90,
    enabled: true,
  },
  {
    id: 'entity-location',
    ruleType: 'entity_extraction',
    entityType: 'location',
    pattern: String.raw`\b(?:i live in|i'm from|i am from)\s+([A-Za-z][A-Za-z\s\-']{1,40}?)(?=\s+(?:and|but)\b|[,.!?]|$)`,
    flags: 'i',
    factsTemplate: { relation: 'home' },
    priority: 80,
    enabled: true,
  },
  {
    id: 'entity-preference',
    ruleType: 'entity_extraction',
    entityType: 'preference',
    pattern: String.raw`\b(?:i like|i prefer|my favorite)\s+([A-Za-z][A-Za-z\s\-']{1,60})\b`,
    flags: 'i',
    factsTemplate: { relation: 'stated_preference' },
    priority: 70,
    enabled: true,
  },
];

const semanticMemories: MemoryEntry[] = [];
const entityMemory = new Map<string, { type: string; facts: Record<string, unknown>; confidence: number; source: string }>();

function entityKey(type: string, name: string): string {
  return `${type.toLowerCase()}::${name.toLowerCase()}`;
}

async function saveTurnToMemory(args: {
  userId: string;
  chatId: string;
  userContent: string;
  assistantContent: string;
  llmExtractor?: LlmEntityExtractor;
}) {
  const { userId, chatId, userContent, assistantContent, llmExtractor } = args;
  const ctx = weaveContext({ userId });

  const extraction = await runHybridMemoryExtraction({
    ctx,
    input: { userContent, assistantContent },
    rules,
    llmExtractor,
  });

  if (extraction.selfDisclosure) {
    semanticMemories.push({
      id: `sem-${semanticMemories.length + 1}`,
      type: 'semantic',
      content: userContent,
      metadata: { chatId, memoryType: 'user_fact', source: 'user' },
      createdAt: new Date().toISOString(),
      userId,
    });
  }

  if (assistantContent.length > 40) {
    semanticMemories.push({
      id: `sem-${semanticMemories.length + 1}`,
      type: 'semantic',
      content: assistantContent,
      metadata: { chatId, memoryType: 'summary', source: 'assistant' },
      createdAt: new Date().toISOString(),
      userId,
    });
  }

  for (const e of extraction.entities) {
    entityMemory.set(entityKey(e.type, e.name), {
      type: e.type,
      facts: e.facts,
      confidence: e.confidence,
      source: e.source,
    });
  }

  return extraction;
}

function buildMemoryContext(userQuestion: string): string {
  const chunks: string[] = ['[Long-term memory from past conversations]'];

  if (/name|who am i|called/i.test(userQuestion)) {
    const personRows = Array.from(entityMemory.entries()).filter(([k]) => k.startsWith('person::'));
    if (personRows.length > 0) {
      chunks.push('Known identity facts:');
      for (const [k] of personRows) {
        const name = k.split('::')[1];
        chunks.push(`  - person \"${name}\"`);
      }
    }
  }

  if (semanticMemories.length > 0) {
    chunks.push('Relevant memories:');
    for (const m of semanticMemories.slice(-3)) {
      chunks.push(`  - ${m.content}`);
    }
  }

  return chunks.join('\n');
}

function createLocalTools(): ToolRegistry {
  const tools = weaveToolRegistry();

  tools.register(
    weaveTool({
      name: 'datetime',
      description: 'Get current date and time details.',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['weekday', 'date', 'iso'] },
        },
      },
      execute: async (args: { format?: string }) => {
        const now = new Date('2026-04-12T10:00:00Z');
        switch (args.format) {
          case 'weekday':
            return 'Sunday';
          case 'date':
            return now.toLocaleDateString('en-US', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            });
          default:
            return now.toISOString();
        }
      },
    }),
  );

  tools.register(
    weaveTool({
      name: 'calculator',
      description: 'Evaluate simple arithmetic expressions.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string' },
        },
        required: ['expression'],
      },
      execute: async (args: { expression: string }) => {
        const result = Function(`"use strict"; return (${args.expression})`)();
        return String(result);
      },
    }),
  );

  tools.register(
    weaveTool({
      name: 'duckduckgo_search',
      description: 'Return web snippets for a query (mocked for local demo).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
      execute: async (args: { query: string }) => {
        const q = args.query.toLowerCase();
        if (q.includes('matcha')) {
          return 'DuckDuckGo: Matcha tea is high in antioxidants and contains L-theanine.';
        }
        return `DuckDuckGo: Top results for "${args.query}"`;
      },
    }),
  );

  return tools;
}

async function runTool(
  ctx: ExecutionContext,
  tools: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  const output = await tool.invoke(ctx, { name, arguments: args });
  return output.content;
}

async function main() {
  console.log('\n=== Example 22: Chat-Style Memory Extraction (No DB) ===\n');

  const userId = 'alice-user';
  const chatId = 'chat-1';
  const ctx = weaveContext({ userId });
  const tools = createLocalTools();

  const weekday = await runTool(ctx, tools, 'datetime', { format: 'weekday' });
  const calc = await runTool(ctx, tools, 'calculator', { expression: '2 + 2 * 5' });
  const search = await runTool(ctx, tools, 'duckduckgo_search', { query: 'matcha tea benefits' });

  const toolTrace = [
    `datetime(format=weekday) => ${weekday}`,
    `calculator(expression=2 + 2 * 5) => ${calc}`,
    `duckduckgo_search(query=matcha tea benefits) => ${search}`,
  ];

  const turn1 = {
    userContent: 'Hi, my name is Alice. I live in Seattle, I work at Contoso, and I like matcha tea.',
    assistantContent: [
      `Nice to meet you, Alice. Today is ${weekday}.`,
      `Quick math check: 2 + 2 * 5 = ${calc}.`,
      `Web note: ${search}`,
      'I can remember your profile details for later context.',
    ].join(' '),
  };

  const llmExtractor: LlmEntityExtractor = async () => {
    const organizationMatch = turn1.userContent.match(/\bwork at\s+([A-Za-z][A-Za-z\-']{1,39})\b/i);
    if (!organizationMatch) return [];
    return [
      {
        name: organizationMatch[1]!,
        type: 'organization',
        facts: { source: 'llm_inference' },
        confidence: 0.78,
        source: 'llm',
      },
    ];
  };

  const extraction = await saveTurnToMemory({ userId, chatId, ...turn1, llmExtractor });

  console.log('Tool calls in this chat turn:');
  for (const trace of toolTrace) {
    console.log(`  - ${trace}`);
  }

  console.log('User turn:');
  console.log(`  ${turn1.userContent}`);
  console.log('\nExtraction events:');
  for (const ev of extraction.events) {
    console.log(`  [${ev.stage}] ${ev.message}`);
  }

  console.log('\nExtracted entities:');
  for (const e of extraction.entities) {
    console.log(`  - ${e.type}: ${e.name} (confidence=${e.confidence.toFixed(2)}, source=${e.source})`);
  }
  const regexCount = extraction.entities.filter((e) => e.source === 'regex').length;
  const llmCount = extraction.entities.filter((e) => e.source === 'llm').length;
  console.log(`\nHybrid extraction mix: regex=${regexCount}, llm=${llmCount}`);

  const recallQuestion = 'Do you remember my name?';
  const memoryContext = buildMemoryContext(recallQuestion);

  console.log('\nFollow-up question:');
  console.log(`  ${recallQuestion}`);
  console.log('\nMemory context assembled for chat pipeline:');
  console.log(memoryContext);

  // Optional: demonstrate store/query against the memory package in-memory store.
  const store = weaveMemoryStore();
  await store.write(ctx, semanticMemories);
  const recalled = await store.query(ctx, {
    type: 'semantic',
    query: 'Alice',
    topK: 5,
    filter: { userId },
  });

  console.log('\nSemantic recall sample:');
  for (const m of recalled) {
    console.log(`  - ${m.content}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
