#!/usr/bin/env npx tsx
/**
 * ServiceNow Integration Test
 *
 * Tests OAuth2 client_credentials flow → token acquisition → basic API calls.
 * Reads credentials from .env:
 *   SERVICENOW_INSTANCE, SERVICENOW_CLIENT_ID, SERVICENOW_CLIENT_SECRET
 *
 * Usage:  npx tsx scripts/test-servicenow.ts
 */
import 'dotenv/config';
import {
  ServiceNowProvider,
} from '@weaveintel/tools-enterprise';
import type { EnterpriseConnectorConfig } from '@weaveintel/tools-enterprise';

/* ---------- env check ---------- */
const instance = process.env['SERVICENOW_INSTANCE'];
const clientId = process.env['SERVICENOW_CLIENT_ID'];
const clientSecret = process.env['SERVICENOW_CLIENT_SECRET'];
const username = process.env['SERVICENOW_USERNAME'];
const password = process.env['SERVICENOW_PASSWORD'];

if (!instance || !clientId || !clientSecret || !username || !password) {
  console.error('❌  Missing env vars. Set SERVICENOW_INSTANCE, SERVICENOW_CLIENT_ID, SERVICENOW_CLIENT_SECRET, SERVICENOW_USERNAME, SERVICENOW_PASSWORD in .env');
  process.exit(1);
}

const baseUrl = `https://${instance}.service-now.com`;

/* ---------- helpers ---------- */
function ok(label: string) { console.log(`  ✅  ${label}`); }
function fail(label: string, err: unknown) { console.error(`  ❌  ${label}:`, err instanceof Error ? err.message : err); }

/** Acquire a token via OAuth2 password grant (the standard ServiceNow approach). */
async function acquireToken(): Promise<string> {
  const tokenUrl = `${baseUrl}/oauth_token.do`;
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: clientId!,
    client_secret: clientSecret!,
    username: username!,
    password: password!,
  });
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token request failed (${resp.status}): ${text}`);
  }
  const data = await resp.json() as { access_token: string; expires_in: number; token_type: string };
  return data.access_token;
}

/* ---------- tests ---------- */
async function main() {
  console.log(`\n🔗  ServiceNow instance: ${baseUrl}`);
  console.log('─'.repeat(60));

  // 1. Acquire token
  console.log('\n1️⃣  OAuth2 Password Grant — Token Acquisition');
  let accessToken: string;
  try {
    accessToken = await acquireToken();
    ok(`Token acquired (${accessToken.slice(0, 12)}...${accessToken.slice(-6)})`);
  } catch (err) {
    fail('Token acquisition failed', err);
    console.error('\n⚠️  Cannot proceed without a token. Check client_id / client_secret / instance.');
    process.exit(1);
  }

  // Build connector config using the acquired token
  const config: EnterpriseConnectorConfig = {
    baseUrl,
    authType: 'oauth2',
    authConfig: { accessToken },
  };

  const sn = new ServiceNowProvider();

  // 2. List incidents (read-only, low risk)
  console.log('\n2️⃣  Table API — List recent incidents (limit 5)');
  try {
    const incidents = await sn.query(
      { query: 'ORDERBYDESCsys_created_on', limit: 5, table: 'incident' } as any,
      config,
    );
    ok(`${incidents.length} incident(s) returned`);
    for (const inc of incidents.slice(0, 3)) {
      console.log(`     • ${inc.id} — ${inc.data['short_description'] ?? '(no description)'}`);
    }
  } catch (err) {
    fail('List incidents', err);
  }

  // 3. List users (read-only)
  console.log('\n3️⃣  Table API — List users (limit 3)');
  try {
    const users = await sn.query(
      { query: 'active=true', limit: 3, table: 'sys_user' } as any,
      config,
    );
    ok(`${users.length} user(s) returned`);
    for (const u of users) {
      console.log(`     • ${u.id} — ${u.data['user_name']} (${u.data['email']})`);
    }
  } catch (err) {
    fail('List users', err);
  }

  // 4. List change requests (read-only)
  console.log('\n4️⃣  Table API — List change requests (limit 3)');
  try {
    const changes = await sn.query(
      { query: 'ORDERBYDESCsys_created_on', limit: 3, table: 'change_request' } as any,
      config,
    );
    ok(`${changes.length} change request(s) returned`);
    for (const c of changes) {
      console.log(`     • ${c.id} — ${c.data['short_description'] ?? '(no description)'}`);
    }
  } catch (err) {
    fail('List change requests', err);
  }

  // 5. Knowledge Base articles (read-only)
  console.log('\n5️⃣  Table API — List knowledge articles (limit 3)');
  try {
    const kbs = await sn.query(
      { query: 'workflow_state=published', limit: 3, table: 'kb_knowledge' } as any,
      config,
    );
    ok(`${kbs.length} article(s) returned`);
    for (const kb of kbs) {
      console.log(`     • ${kb.id} — ${kb.data['short_description'] ?? kb.data['title'] ?? '(no title)'}`);
    }
  } catch (err) {
    fail('List knowledge articles', err);
  }

  // 6. Service Catalog items (read-only, uses catalog API)
  console.log('\n6️⃣  Service Catalog API — List catalog items (limit 3)');
  try {
    const items = await sn.listCatalogItems(config, 3);
    ok(`${items.length} catalog item(s) returned`);
    for (const item of items) {
      console.log(`     • ${item.id} — ${item.data['name'] ?? '(unnamed)'}`);
    }
  } catch (err) {
    fail('List catalog items', err);
  }

  console.log('\n' + '─'.repeat(60));
  console.log('🏁  ServiceNow integration test complete.\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
