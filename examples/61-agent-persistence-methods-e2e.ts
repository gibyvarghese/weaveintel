/**
 * Example 61 — Tool-Calling Agent Persistence Backends End-to-End
 *
 * This example shows Phase 6 cross-runtime adoption outside live-agents.
 * It uses @weaveintel/agents + @weaveintel/memory with the same persistence
 * methods implemented earlier so a non-live tool-calling agent can retain
 * conversation history across restarts.
 *
 * Scenarios:
 * 1) in-memory
 * 2) postgres
 * 3) redis
 * 4) sqlite
 * 5) mongodb
 * 6) cloud-nosql via DynamoDB Local
 */

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { weaveAgent } from '@weaveintel/agents';
import {
  createConfiguredConversationMemory,
  type ConfiguredConversationMemory,
} from '@weaveintel/memory';
import { weaveContext, type Model, type ModelGenerateResult } from '@weaveintel/core';

const POSTGRES_URL = process.env['WEAVE_AGENT_EXAMPLE_POSTGRES_URL'];
const REDIS_URL = process.env['WEAVE_AGENT_EXAMPLE_REDIS_URL'];
const SQLITE_PATH = process.env['WEAVE_AGENT_EXAMPLE_SQLITE_PATH'];
const MONGODB_URL = process.env['WEAVE_AGENT_EXAMPLE_MONGODB_URL'];
const MONGODB_DATABASE = process.env['WEAVE_AGENT_EXAMPLE_MONGODB_DATABASE'] ?? 'weave_agent_example';
const DYNAMODB_ENDPOINT = process.env['WEAVE_AGENT_EXAMPLE_DYNAMODB_ENDPOINT'];
const DYNAMODB_REGION = process.env['WEAVE_AGENT_EXAMPLE_DYNAMODB_REGION'] ?? 'us-east-1';
const DYNAMODB_TABLE = process.env['WEAVE_AGENT_EXAMPLE_DYNAMODB_TABLE'] ?? 'weave_agent_memory';

function createEchoModel(tag: string): Model {
  return {
    id: `echo:${tag}`,
    async generate(_ctx, input): Promise<ModelGenerateResult> {
      const lastUserMessage = [...input.messages].reverse().find((message) => message.role === 'user');
      return {
        content: `[${tag}] ${typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : ''}`,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  } as Model;
}

async function runScenario(
  label: string,
  memory: ConfiguredConversationMemory,
  ctxSeed: { tenantId: string; userId: string; metadata: { sessionId: string } },
): Promise<void> {
  const ctx = weaveContext(ctxSeed);
  const agent = weaveAgent({ model: createEchoModel(label), memory });

  const first = await agent.run(ctx, {
    goal: `${label} first run`,
    messages: [{ role: 'user', content: `${label} hello` }],
  });
  if (!first.output?.includes(`${label} hello`)) {
    throw new Error(`${label} first run output did not include the user prompt`);
  }

  const history = await memory.getMessages(ctx);
  if (history.length < 2) {
    throw new Error(`${label} memory history was not persisted after first run`);
  }

  console.log(`  ✓ ${label} preserved ${history.length} messages`);
}

async function main(): Promise<void> {
  console.log('Tool-calling agent persistence backend E2E scenarios');

  console.log('\n[1/6] in-memory');
  await runScenario(
    'memory',
    createConfiguredConversationMemory({ backend: 'in-memory' }),
    {
      tenantId: 'agent-memory-tenant',
      userId: 'agent-memory-user',
      metadata: { sessionId: 'agent-memory-session' },
    },
  );

  if (POSTGRES_URL) {
    console.log('\n[2/6] postgres');
    const memory = createConfiguredConversationMemory({ backend: 'postgres', postgresUrl: POSTGRES_URL });
    await runScenario('postgres', memory, {
      tenantId: 'agent-postgres-tenant',
      userId: 'agent-postgres-user',
      metadata: { sessionId: 'agent-postgres-session' },
    });
    await memory.close();
  } else {
    console.log('\n[2/6] postgres');
    console.log('  - skipped (WEAVE_AGENT_EXAMPLE_POSTGRES_URL not set)');
  }

  if (REDIS_URL) {
    console.log('\n[3/6] redis');
    const memory = createConfiguredConversationMemory({
      backend: 'redis',
      redisUrl: REDIS_URL,
      redisKeyPrefix: `weave:agent-memory:${Date.now()}`,
    });
    await runScenario('redis', memory, {
      tenantId: 'agent-redis-tenant',
      userId: 'agent-redis-user',
      metadata: { sessionId: 'agent-redis-session' },
    });
    await memory.close();
  } else {
    console.log('\n[3/6] redis');
    console.log('  - skipped (WEAVE_AGENT_EXAMPLE_REDIS_URL not set)');
  }

  console.log('\n[4/6] sqlite');
  const sqlitePath = SQLITE_PATH ?? join(tmpdir(), `weave-agent-memory-${Date.now()}.db`);
  rmSync(sqlitePath, { force: true });
  const sqliteMemory = createConfiguredConversationMemory({ backend: 'sqlite', sqlitePath });
  await runScenario('sqlite', sqliteMemory, {
    tenantId: 'agent-sqlite-tenant',
    userId: 'agent-sqlite-user',
    metadata: { sessionId: 'agent-sqlite-session' },
  });
  await sqliteMemory.close();
  rmSync(sqlitePath, { force: true });

  if (MONGODB_URL) {
    console.log('\n[5/6] mongodb');
    const memory = createConfiguredConversationMemory({
      backend: 'mongodb',
      mongoUrl: MONGODB_URL,
      mongoDatabaseName: MONGODB_DATABASE,
      mongoCollectionName: 'memory_entries',
    });
    await runScenario('mongodb', memory, {
      tenantId: 'agent-mongo-tenant',
      userId: 'agent-mongo-user',
      metadata: { sessionId: 'agent-mongo-session' },
    });
    await memory.close();
  } else {
    console.log('\n[5/6] mongodb');
    console.log('  - skipped (WEAVE_AGENT_EXAMPLE_MONGODB_URL not set)');
  }

  if (DYNAMODB_ENDPOINT) {
    console.log('\n[6/6] cloud-nosql dynamodb');
    const memory = createConfiguredConversationMemory({
      backend: 'cloud-nosql',
      cloudNoSqlProvider: 'dynamodb',
      dynamoDbEndpoint: DYNAMODB_ENDPOINT,
      dynamoDbRegion: DYNAMODB_REGION,
      dynamoDbTableName: DYNAMODB_TABLE,
    });
    await runScenario('cloud-nosql', memory, {
      tenantId: 'agent-ddb-tenant',
      userId: 'agent-ddb-user',
      metadata: { sessionId: 'agent-ddb-session' },
    });
    await memory.close();
  } else {
    console.log('\n[6/6] cloud-nosql dynamodb');
    console.log('  - skipped (WEAVE_AGENT_EXAMPLE_DYNAMODB_ENDPOINT not set)');
  }

  console.log('\nAll tool-calling agent persistence scenarios completed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});