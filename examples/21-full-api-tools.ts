/**
 * Example 21 — Full API Tool Ecosystem
 *
 * Demonstrates the extended tool ecosystem with full API coverage:
 *
 *  • Universal auth profiles (OAuth 2.0, basic auth, client credentials)
 *  • AuthManager — token lifecycle (acquire, refresh, revoke)
 *  • Jira full connector — issues, transitions, comments, attachments, boards, sprints
 *  • ServiceNow connector — table CRUD, incidents, change requests, CMDB, catalog
 *  • Facebook connector — posts, comments, photos, insights, page management
 *  • Instagram connector — media, comments, stories, hashtags, insights, publishing
 *  • Canva connector — designs, assets, folders, exports, brand templates, comments
 *  • MCP factory wiring — all APIs exposed as granular MCP tools
 *
 * WeaveIntel packages used:
 *   @weaveintel/tools-enterprise — Jira, ServiceNow, Canva + Universal Auth
 *   @weaveintel/tools-social     — Facebook, Instagram
 *   @weaveintel/core             — ExecutionContext, weaveTool()
 *
 * Run: npx tsx examples/21-full-api-tools.ts
 */

import {
  createEnterpriseTools,
  AuthManager,
  jiraBasicAuth,
  jiraOAuth2,
  serviceNowBasicAuth,
  serviceNowOAuth2,
  canvaOAuth2,
  facebookOAuth2,
  instagramOAuth2,
} from '@weaveintel/tools-enterprise';

import {
  createSocialTools,
} from '@weaveintel/tools-social';

import type { ExecutionContext, ToolInput, ToolOutput } from '@weaveintel/core';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function section(s: string) {
  console.log(`\n  ── ${s} ──`);
}

async function main() {

  /* ══════════════════════════════════════════════════════
   * 1. Universal Auth Profiles
   * ══════════════════════════════════════════════════════ */

  header('1. Universal Auth Profiles');

  const auth = new AuthManager();

  // Register pre-built auth profiles (user supplies domain)
  auth.register(jiraBasicAuth('jira-basic', 'mycompany.atlassian.net'));
  auth.register(jiraOAuth2('jira-oauth2', 'mycompany.atlassian.net'));
  auth.register(serviceNowBasicAuth('servicenow-basic', 'mycompany.service-now.com'));
  auth.register(serviceNowOAuth2('servicenow-oauth2', 'mycompany.service-now.com'));
  auth.register(canvaOAuth2('canva-oauth2', 'canva.com'));
  auth.register(facebookOAuth2('facebook-oauth2', 'facebook.com'));
  auth.register(instagramOAuth2('instagram-oauth2', 'instagram.com'));

  console.log('Registered auth profiles:');
  for (const p of auth.list()) {
    console.log(`  • ${p.id} (${p.method}) — ${p.label}`);
  }

  // Demo: build an OAuth 2.0 authorization URL for Jira
  section('OAuth 2.0 Authorization URL (Jira)');
  const jiraAuthUrl = auth.buildAuthorizationUrl('jira-oauth2', 'random-state-123');
  console.log(`  URL: ${jiraAuthUrl}`);

  // Demo: get auth headers for basic-auth profile
  section('Auth Headers (ServiceNow basic)');
  const snHeaders = auth.getHeaders('servicenow-basic');
  console.log(`  Headers: ${JSON.stringify(snHeaders)}`);

  /* ══════════════════════════════════════════════════════
   * 2. Enterprise Tool Generation — Jira (Full API)
   * ══════════════════════════════════════════════════════ */

  header('2. Jira Full API Tools');

  const jiraTools = createEnterpriseTools([
    {
      type: 'jira',
      name: 'jira-prod',
      enabled: true,
      baseUrl: 'https://mycompany.atlassian.net',
      authType: 'basic',
      authConfig: { username: 'admin@mycompany.com', token: 'API_TOKEN' },
    },
  ]);

  console.log(`Generated ${jiraTools.length} Jira tools:`);
  for (const t of jiraTools) {
    console.log(`  • ${t.schema.name} — ${t.schema.description}`);
  }

  /* ══════════════════════════════════════════════════════
   * 3. Enterprise Tool Generation — ServiceNow (Full API)
   * ══════════════════════════════════════════════════════ */

  header('3. ServiceNow Full API Tools');

  const snTools = createEnterpriseTools([
    {
      type: 'servicenow',
      name: 'snow-prod',
      enabled: true,
      baseUrl: 'https://mycompany.service-now.com',
      authType: 'basic',
      authConfig: { username: 'admin', password: 'PASSWORD' },
    },
  ]);

  console.log(`Generated ${snTools.length} ServiceNow tools:`);
  for (const t of snTools) {
    console.log(`  • ${t.schema.name} — ${t.schema.description}`);
  }

  /* ══════════════════════════════════════════════════════
   * 4. Enterprise Tool Generation — Canva (Full API)
   * ══════════════════════════════════════════════════════ */

  header('4. Canva Full API Tools');

  const canvaTools = createEnterpriseTools([
    {
      type: 'canva',
      name: 'canva-prod',
      enabled: true,
      baseUrl: 'https://api.canva.com/rest/v1',
      authType: 'oauth2',
      authConfig: { accessToken: 'CANVA_ACCESS_TOKEN' },
    },
  ]);

  console.log(`Generated ${canvaTools.length} Canva tools:`);
  for (const t of canvaTools) {
    console.log(`  • ${t.schema.name} — ${t.schema.description}`);
  }

  /* ══════════════════════════════════════════════════════
   * 5. Social Tool Generation — Facebook (Full Graph API)
   * ══════════════════════════════════════════════════════ */

  header('5. Facebook Full API Tools');

  const fbTools = createSocialTools([
    {
      platform: 'facebook',
      accountName: 'My Page',
      enabled: true,
      authType: 'oauth2',
      accessToken: 'FB_PAGE_ACCESS_TOKEN',
      options: { pageId: '123456789' },
    },
  ]);

  console.log(`Generated ${fbTools.length} Facebook tools:`);
  for (const t of fbTools) {
    console.log(`  • ${t.schema.name} — ${t.schema.description}`);
  }

  /* ══════════════════════════════════════════════════════
   * 6. Social Tool Generation — Instagram (Full IG API)
   * ══════════════════════════════════════════════════════ */

  header('6. Instagram Full API Tools');

  const igTools = createSocialTools([
    {
      platform: 'instagram',
      accountName: 'My IG',
      enabled: true,
      authType: 'oauth2',
      accessToken: 'IG_ACCESS_TOKEN',
      options: { igUserId: '17841400000000' },
    },
  ]);

  console.log(`Generated ${igTools.length} Instagram tools:`);
  for (const t of igTools) {
    console.log(`  • ${t.schema.name} — ${t.schema.description}`);
  }

  /* ══════════════════════════════════════════════════════
   * 7. Combined Tool Roster
   * ══════════════════════════════════════════════════════ */

  header('7. Combined Tool Roster (All Services)');

  const allTools = [...jiraTools, ...snTools, ...canvaTools, ...fbTools, ...igTools];
  console.log(`\nTotal tools across all services: ${allTools.length}`);

  const bySvc = new Map<string, number>();
  for (const t of allTools) {
    const svc = t.schema.name.split('.')[1];
    bySvc.set(svc, (bySvc.get(svc) ?? 0) + 1);
  }
  console.log('\nBreakdown:');
  for (const [svc, count] of Array.from(bySvc.entries())) {
    console.log(`  ${svc}: ${count} tools`);
  }

  /* ══════════════════════════════════════════════════════
   * 8. Auth Profile Lifecycle Demo
   * ══════════════════════════════════════════════════════ */

  header('8. Auth Profile Lifecycle');

  // Simulate token storage after OAuth flow
  section('Simulating token exchange');
  auth.setTokenState('jira-oauth2', {
    accessToken: 'eyJ_simulated_access_token',
    refreshToken: 'eyJ_simulated_refresh_token',
    expiresAt: Date.now() + 3600_000,
    scope: 'read:jira-work write:jira-work',
  });
  console.log('  Token stored for jira-oauth2');

  const jiraHeaders = await auth.getHeaders('jira-oauth2');
  console.log(`  Authorization: ${jiraHeaders['Authorization']?.slice(0, 30)}...`);

  // List all profiles with their status
  section('Auth profile summary');
  for (const p of auth.list()) {
    const hasToken = p.tokenState?.accessToken ? '✓ token' : '✗ no token';
    console.log(`  ${p.id}: ${hasToken}`);
  }

  console.log('\n✅ All tool ecosystem demos complete.');
}

main().catch(console.error);
