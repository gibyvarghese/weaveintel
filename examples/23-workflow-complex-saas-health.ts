/**
 * Example 23 — Complex SaaS Customer Health Intelligence Platform
 *
 * Multi-dimensional account health scoring with conditional branching,
 * nested data structures, and agent-driven portfolio analysis.
 *
 * ┌─ Scenario A: Direct workflow execution per account ────────────────────────┐
 * │  Runs account-health-check for 4 accounts with varying health profiles.   │
 * │  Verifies condition branch: low-health → intervention, healthy → expansion │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ Scenario B: weaveAgent drives portfolio analysis ─────────────────────────┐
 * │  Agent receives "find at-risk accounts and recommend actions" from user.   │
 * │  Uses analyze_account, get_at_risk_accounts, compare_accounts tools.       │
 * │  Synthesises CSM action plan across all accounts.                          │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ Scenario C: Portfolio parent workflow invokes child health checks ─────────┐
 * │  portfolio-review workflow iterates over account IDs, invokes              │
 * │  account-health-check per account via inline handler, ranks by score.      │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Run:
 *   npx tsx examples/23-workflow-complex-saas-health.ts
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

function header(title: string) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(72));
}
function sub(title: string) {
  console.log(`\n  ── ${title}`);
}
function ok(msg: string)   { console.log(`  ✓ ${msg}`); }
function info(msg: string) { console.log(`  → ${msg}`); }
function warn(msg: string) { console.log(`  ⚠ ${msg}`); }
function fail(msg: string) { console.log(`  ✗ ${msg}`); throw new Error(msg); }

// ── Data Model ────────────────────────────────────────────────────────────

interface AccountUser {
  id: string;
  role: 'admin' | 'power' | 'standard' | 'viewer';
  lastSeenDaysAgo: number;
  sessionsThisMonth: number;
  featuresUsed: string[];
}

interface Invoice {
  id: string;
  amount: number;
  status: 'paid' | 'overdue' | 'pending';
  daysOverdue: number;
  dueDate: string;
}

interface SupportTicket {
  id: string;
  type: 'bug' | 'feature' | 'question' | 'escalation';
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'in-progress' | 'resolved' | 'closed';
  resolvedInDays: number | null;
  createdDaysAgo: number;
  escalated: boolean;
}

interface Account {
  id: string;
  name: string;
  plan: 'starter' | 'growth' | 'enterprise';
  industry: string;
  region: string;
  contractEndDays: number;
  totalSeats: number;
  activeUsers: number;
  mauLast30Days: number;
  totalFeatures: number;
  users: AccountUser[];
  invoices: Invoice[];
  tickets: SupportTicket[];
  arr: { previous: number; current: number };
  featureFlags: Record<string, boolean>;
}

// ── Account Database ──────────────────────────────────────────────────────

const ACCOUNT_DB: Record<string, Account> = {
  'startup-alpha': {
    id: 'startup-alpha',
    name: 'Alpha Dynamics',
    plan: 'growth',
    industry: 'fintech',
    region: 'EMEA',
    contractEndDays: 220,
    totalSeats: 10,
    activeUsers: 8,
    mauLast30Days: 6,
    totalFeatures: 12,
    users: [
      { id: 'u1', role: 'admin',    lastSeenDaysAgo: 0,  sessionsThisMonth: 24, featuresUsed: ['dashboard','reports','api','alerts','exports','integrations'] },
      { id: 'u2', role: 'power',    lastSeenDaysAgo: 1,  sessionsThisMonth: 18, featuresUsed: ['dashboard','reports','api','alerts'] },
      { id: 'u3', role: 'power',    lastSeenDaysAgo: 2,  sessionsThisMonth: 15, featuresUsed: ['dashboard','reports','exports'] },
      { id: 'u4', role: 'standard', lastSeenDaysAgo: 3,  sessionsThisMonth: 9,  featuresUsed: ['dashboard','reports'] },
      { id: 'u5', role: 'standard', lastSeenDaysAgo: 5,  sessionsThisMonth: 7,  featuresUsed: ['dashboard'] },
      { id: 'u6', role: 'standard', lastSeenDaysAgo: 12, sessionsThisMonth: 4,  featuresUsed: ['dashboard'] },
      { id: 'u7', role: 'viewer',   lastSeenDaysAgo: 18, sessionsThisMonth: 2,  featuresUsed: ['dashboard'] },
      { id: 'u8', role: 'viewer',   lastSeenDaysAgo: 25, sessionsThisMonth: 0,  featuresUsed: [] },
    ],
    invoices: [
      { id: 'inv-1', amount: 4800,  status: 'paid',    daysOverdue: 0,  dueDate: '2026-01-15' },
      { id: 'inv-2', amount: 4800,  status: 'paid',    daysOverdue: 0,  dueDate: '2026-02-15' },
      { id: 'inv-3', amount: 4800,  status: 'pending', daysOverdue: 0,  dueDate: '2026-03-15' },
    ],
    tickets: [
      { id: 't1', type: 'question', priority: 'low',    status: 'resolved', resolvedInDays: 1,   createdDaysAgo: 45, escalated: false },
      { id: 't2', type: 'feature',  priority: 'medium', status: 'in-progress', resolvedInDays: null, createdDaysAgo: 20, escalated: false },
      { id: 't3', type: 'bug',      priority: 'low',    status: 'resolved', resolvedInDays: 3,   createdDaysAgo: 10, escalated: false },
    ],
    arr: { previous: 52_000, current: 60_480 },
    featureFlags: { advancedReports: true, apiAccess: true, ssoEnabled: false, customDashboards: false, aiInsights: false },
  },

  'enterprise-beta': {
    id: 'enterprise-beta',
    name: 'Beta Global Corp',
    plan: 'enterprise',
    industry: 'healthcare',
    region: 'AMER',
    contractEndDays: 310,
    totalSeats: 10,
    activeUsers: 10,
    mauLast30Days: 10,
    totalFeatures: 12,
    users: [
      { id: 'u1', role: 'admin',    lastSeenDaysAgo: 0, sessionsThisMonth: 31, featuresUsed: ['dashboard','reports','api','alerts','exports','integrations','sso','aiInsights','customDash','auditLog'] },
      { id: 'u2', role: 'power',    lastSeenDaysAgo: 0, sessionsThisMonth: 28, featuresUsed: ['dashboard','reports','api','alerts','exports','aiInsights','customDash'] },
      { id: 'u3', role: 'power',    lastSeenDaysAgo: 1, sessionsThisMonth: 25, featuresUsed: ['dashboard','reports','api','aiInsights','customDash'] },
      { id: 'u4', role: 'power',    lastSeenDaysAgo: 1, sessionsThisMonth: 22, featuresUsed: ['dashboard','reports','api','aiInsights'] },
      { id: 'u5', role: 'standard', lastSeenDaysAgo: 2, sessionsThisMonth: 18, featuresUsed: ['dashboard','reports','aiInsights'] },
      { id: 'u6', role: 'standard', lastSeenDaysAgo: 2, sessionsThisMonth: 16, featuresUsed: ['dashboard','reports'] },
      { id: 'u7', role: 'standard', lastSeenDaysAgo: 3, sessionsThisMonth: 14, featuresUsed: ['dashboard','reports'] },
      { id: 'u8', role: 'standard', lastSeenDaysAgo: 4, sessionsThisMonth: 12, featuresUsed: ['dashboard'] },
      { id: 'u9', role: 'standard', lastSeenDaysAgo: 5, sessionsThisMonth: 10, featuresUsed: ['dashboard'] },
      { id: 'u10',role: 'viewer',   lastSeenDaysAgo: 6, sessionsThisMonth: 8,  featuresUsed: ['dashboard'] },
    ],
    invoices: [
      { id: 'inv-1', amount: 24_000, status: 'paid', daysOverdue: 0, dueDate: '2026-01-01' },
      { id: 'inv-2', amount: 24_000, status: 'paid', daysOverdue: 0, dueDate: '2026-02-01' },
      { id: 'inv-3', amount: 24_000, status: 'paid', daysOverdue: 0, dueDate: '2026-03-01' },
    ],
    tickets: [
      { id: 't1', type: 'feature',  priority: 'high',   status: 'in-progress', resolvedInDays: null, createdDaysAgo: 14, escalated: false },
      { id: 't2', type: 'question', priority: 'low',    status: 'resolved',    resolvedInDays: 1,    createdDaysAgo: 30, escalated: false },
    ],
    arr: { previous: 264_000, current: 288_000 },
    featureFlags: { advancedReports: true, apiAccess: true, ssoEnabled: true, customDashboards: true, aiInsights: true },
  },

  'midmarket-gamma': {
    id: 'midmarket-gamma',
    name: 'Gamma Solutions Ltd',
    plan: 'growth',
    industry: 'logistics',
    region: 'APAC',
    contractEndDays: 45,
    totalSeats: 8,
    activeUsers: 6,
    mauLast30Days: 3,
    totalFeatures: 12,
    users: [
      { id: 'u1', role: 'admin',    lastSeenDaysAgo: 8,  sessionsThisMonth: 6,  featuresUsed: ['dashboard','reports'] },
      { id: 'u2', role: 'standard', lastSeenDaysAgo: 15, sessionsThisMonth: 3,  featuresUsed: ['dashboard'] },
      { id: 'u3', role: 'standard', lastSeenDaysAgo: 22, sessionsThisMonth: 2,  featuresUsed: ['dashboard'] },
      { id: 'u4', role: 'viewer',   lastSeenDaysAgo: 29, sessionsThisMonth: 0,  featuresUsed: [] },
      { id: 'u5', role: 'viewer',   lastSeenDaysAgo: 31, sessionsThisMonth: 0,  featuresUsed: [] },
      { id: 'u6', role: 'viewer',   lastSeenDaysAgo: 45, sessionsThisMonth: 0,  featuresUsed: [] },
    ],
    invoices: [
      { id: 'inv-1', amount: 9_200, status: 'paid',    daysOverdue: 0,  dueDate: '2026-01-10' },
      { id: 'inv-2', amount: 9_200, status: 'overdue', daysOverdue: 22, dueDate: '2026-02-10' },
      { id: 'inv-3', amount: 9_200, status: 'overdue', daysOverdue: 8,  dueDate: '2026-03-10' },
    ],
    tickets: [
      { id: 't1', type: 'bug',       priority: 'critical', status: 'open',        resolvedInDays: null, createdDaysAgo: 12, escalated: true  },
      { id: 't2', type: 'bug',       priority: 'high',     status: 'in-progress', resolvedInDays: null, createdDaysAgo: 8,  escalated: false },
      { id: 't3', type: 'question',  priority: 'medium',   status: 'open',        resolvedInDays: null, createdDaysAgo: 5,  escalated: false },
      { id: 't4', type: 'escalation',priority: 'critical', status: 'open',        resolvedInDays: null, createdDaysAgo: 3,  escalated: true  },
    ],
    arr: { previous: 110_400, current: 98_400 },
    featureFlags: { advancedReports: false, apiAccess: false, ssoEnabled: false, customDashboards: false, aiInsights: false },
  },

  'scaleup-delta': {
    id: 'scaleup-delta',
    name: 'Delta Ventures Inc',
    plan: 'growth',
    industry: 'saas',
    region: 'AMER',
    contractEndDays: 180,
    totalSeats: 10,
    activeUsers: 8,
    mauLast30Days: 8,
    totalFeatures: 12,
    users: [
      { id: 'u1', role: 'admin',    lastSeenDaysAgo: 0, sessionsThisMonth: 30, featuresUsed: ['dashboard','reports','api','alerts','exports','integrations','aiInsights'] },
      { id: 'u2', role: 'power',    lastSeenDaysAgo: 0, sessionsThisMonth: 26, featuresUsed: ['dashboard','reports','api','alerts','exports'] },
      { id: 'u3', role: 'power',    lastSeenDaysAgo: 1, sessionsThisMonth: 22, featuresUsed: ['dashboard','reports','api','alerts'] },
      { id: 'u4', role: 'power',    lastSeenDaysAgo: 1, sessionsThisMonth: 20, featuresUsed: ['dashboard','reports','api'] },
      { id: 'u5', role: 'standard', lastSeenDaysAgo: 2, sessionsThisMonth: 15, featuresUsed: ['dashboard','reports'] },
      { id: 'u6', role: 'standard', lastSeenDaysAgo: 3, sessionsThisMonth: 12, featuresUsed: ['dashboard','reports'] },
      { id: 'u7', role: 'standard', lastSeenDaysAgo: 5, sessionsThisMonth: 8,  featuresUsed: ['dashboard'] },
      { id: 'u8', role: 'standard', lastSeenDaysAgo: 8, sessionsThisMonth: 5,  featuresUsed: ['dashboard'] },
    ],
    invoices: [
      { id: 'inv-1', amount: 14_400, status: 'paid', daysOverdue: 0, dueDate: '2026-01-15' },
      { id: 'inv-2', amount: 14_400, status: 'paid', daysOverdue: 0, dueDate: '2026-02-15' },
      { id: 'inv-3', amount: 18_000, status: 'paid', daysOverdue: 0, dueDate: '2026-03-15' },
    ],
    tickets: [
      { id: 't1', type: 'feature',  priority: 'high',   status: 'resolved',    resolvedInDays: 4,    createdDaysAgo: 20, escalated: false },
      { id: 't2', type: 'question', priority: 'medium', status: 'resolved',    resolvedInDays: 1,    createdDaysAgo: 14, escalated: false },
      { id: 't3', type: 'feature',  priority: 'medium', status: 'in-progress', resolvedInDays: null, createdDaysAgo: 5,  escalated: false },
    ],
    arr: { previous: 148_800, current: 190_800 },
    featureFlags: { advancedReports: true, apiAccess: true, ssoEnabled: false, customDashboards: true, aiInsights: true },
  },
};

// ── Tool Implementations ──────────────────────────────────────────────────

type ToolFn = (input: Record<string, unknown>) => Promise<unknown>;

const loadAccountTool: ToolFn = async (input) => {
  const accountId = input['accountId'] as string;
  const account = ACCOUNT_DB[accountId];
  if (!account) throw new Error(`Account not found: ${accountId}`);
  return account;
};

const computeEngagementTool: ToolFn = async (input) => {
  const account = input['account'] as Account;
  const { users, mauLast30Days, totalSeats, totalFeatures } = account;

  const mauRatio        = Math.min(1, mauLast30Days / totalSeats);
  const allFeatures     = new Set(users.flatMap(u => u.featuresUsed));
  const featureBreadth  = Math.min(1, allFeatures.size / totalFeatures);
  const powerUsers      = users.filter(u => u.role === 'admin' || u.role === 'power');
  const powerUserPct    = powerUsers.length / Math.max(1, users.length);
  const avgSessions     = users.reduce((s, u) => s + u.sessionsThisMonth, 0) / Math.max(1, users.length);
  const sessionDepth    = Math.min(1, avgSessions / 20);

  const engagementScore = Math.round(
    mauRatio * 35 + featureBreadth * 25 + powerUserPct * 25 + sessionDepth * 15,
  );

  return {
    engagementScore,
    engagementDetails: {
      mauRatio:         Math.round(mauRatio * 100),
      featureBreadth:   Math.round(featureBreadth * 100),
      uniqueFeatures:   allFeatures.size,
      powerUserPct:     Math.round(powerUserPct * 100),
      avgSessionsMonth: Math.round(avgSessions * 10) / 10,
      activeLastWeek:   users.filter(u => u.lastSeenDaysAgo <= 7).length,
      dormantUsers:     users.filter(u => u.lastSeenDaysAgo > 30 || u.sessionsThisMonth === 0).length,
    },
  };
};

const computeSupportTool: ToolFn = async (input) => {
  const tickets = input['tickets'] as SupportTicket[];

  const openTickets     = tickets.filter(t => t.status === 'open' || t.status === 'in-progress');
  const openScore       = Math.max(0, 1 - openTickets.length / Math.max(1, tickets.length));
  const resolved        = tickets.filter(t => t.resolvedInDays !== null);
  const avgResDays      = resolved.length > 0
    ? resolved.reduce((s, t) => s + (t.resolvedInDays ?? 0), 0) / resolved.length
    : 0;
  const resolutionScore = resolved.length > 0 ? Math.max(0, 1 - avgResDays / 14) : 1;
  const criticals       = tickets.filter(t => t.priority === 'critical');
  const criticalScore   = Math.max(0, 1 - criticals.length / Math.max(1, tickets.length));
  const escalated       = tickets.filter(t => t.escalated);
  const escalationScore = Math.max(0, 1 - (escalated.length * 2) / Math.max(1, tickets.length));

  const supportScore = Math.round(
    openScore * 35 + resolutionScore * 30 + criticalScore * 20 + escalationScore * 15,
  );

  return {
    supportScore,
    supportDetails: {
      totalTickets:     tickets.length,
      openTickets:      openTickets.length,
      resolvedTickets:  resolved.length,
      criticalCount:    criticals.length,
      escalatedCount:   escalated.length,
      avgResolutionDays: Math.round(avgResDays * 10) / 10,
      openRate:         Math.round((openTickets.length / Math.max(1, tickets.length)) * 100),
    },
  };
};

const computeBillingTool: ToolFn = async (input) => {
  const invoices        = input['invoices'] as Invoice[];
  const arr             = input['arr'] as { previous: number; current: number };
  const contractEndDays = input['contractEndDays'] as number;

  const overdue         = invoices.filter(i => i.status === 'overdue');
  const paymentScore    = Math.max(0, 1 - overdue.length / Math.max(1, invoices.length));
  const arrGrowth       = (arr.current - arr.previous) / Math.max(1, arr.previous);
  const arrTrendScore   = Math.min(1, Math.max(0, 0.5 + arrGrowth));
  const renewalScore    = contractEndDays > 180 ? 1 : contractEndDays > 90 ? 0.7 : contractEndDays > 45 ? 0.4 : 0.15;

  const billingScore = Math.round(
    paymentScore * 40 + arrTrendScore * 30 + renewalScore * 30,
  );

  return {
    billingScore,
    billingDetails: {
      totalInvoices:    invoices.length,
      overdueInvoices:  overdue.length,
      overdueAmount:    overdue.reduce((s, i) => s + i.amount, 0),
      arrPrevious:      arr.previous,
      arrCurrent:       arr.current,
      arrGrowthPct:     Math.round(arrGrowth * 1000) / 10,
      contractEndDays,
      renewalRisk:      contractEndDays <= 45 ? 'critical' : contractEndDays <= 90 ? 'high' : contractEndDays <= 180 ? 'medium' : 'low',
    },
  };
};

const scoreHealthTool: ToolFn = async (input) => {
  const engagementScore = input['engagementScore'] as number;
  const supportScore    = input['supportScore'] as number;
  const billingScore    = input['billingScore'] as number;
  const accountName     = input['accountName'] as string;
  const plan            = input['plan'] as string;

  const isEnterprise    = plan === 'enterprise';
  const engWeight       = isEnterprise ? 0.45 : 0.40;
  const bilWeight       = isEnterprise ? 0.25 : 0.30;
  const healthScore     = Math.round(engagementScore * engWeight + supportScore * 0.30 + billingScore * bilWeight);

  const healthGrade =
    healthScore >= 85 ? 'A' :
    healthScore >= 70 ? 'B' :
    healthScore >= 55 ? 'C' :
    healthScore >= 40 ? 'D' : 'F';

  const riskLevel =
    healthScore >= 75 ? 'low' :
    healthScore >= 60 ? 'medium' :
    healthScore >= 40 ? 'high' : 'critical';

  return {
    healthScore,
    healthGrade,
    riskLevel,
    scoreComponents: {
      accountName,
      plan,
      engagement: { score: engagementScore, weight: Math.round(engWeight * 100) },
      support:    { score: supportScore,    weight: 30 },
      billing:    { score: billingScore,    weight: Math.round(bilWeight * 100) },
    },
  };
};

const generateInterventionTool: ToolFn = async (input) => {
  const eng     = input['engagementDetails'] as Record<string, unknown>;
  const sup     = input['supportDetails']    as Record<string, unknown>;
  const bil     = input['billingDetails']    as Record<string, unknown>;
  const score   = input['healthScore']       as number;

  const recommendations: string[] = [];
  const nextSteps: string[] = [];

  if ((eng['dormantUsers'] as number) > 0) {
    recommendations.push(`Re-engage ${eng['dormantUsers']} dormant users — schedule onboarding refresh call`);
    nextSteps.push('Send re-engagement email campaign within 48h');
  }
  if ((eng['mauRatio'] as number) < 60) {
    recommendations.push('MAU below 60% — identify adoption blockers via user interviews');
    nextSteps.push('Book executive sponsor call to discuss adoption goals');
  }
  if ((sup['escalatedCount'] as number) > 0) {
    recommendations.push(`${sup['escalatedCount']} escalated ticket(s) — CSM to join next support sync`);
    nextSteps.push('Escalation review with engineering lead within 24h');
  }
  if ((sup['criticalCount'] as number) > 0) {
    recommendations.push(`${sup['criticalCount']} critical ticket(s) open — daily status updates required`);
  }
  if ((bil['overdueInvoices'] as number) > 0) {
    recommendations.push(`${bil['overdueInvoices']} overdue invoice(s) totalling $${bil['overdueAmount']} — finance outreach required`);
    nextSteps.push('Finance team to contact AP contact within 24h');
  }
  if ((bil['contractEndDays'] as number) <= 90) {
    recommendations.push(`Contract expires in ${bil['contractEndDays']} days — begin renewal conversation immediately`);
    nextSteps.push('Schedule renewal QBR with decision-maker this week');
  }

  return {
    recommendations,
    nextSteps,
    playbook: 'intervention-v2',
    urgency:  score < 40 ? 'immediate' : 'high',
  };
};

const generateExpansionTool: ToolFn = async (input) => {
  const eng     = input['engagementDetails'] as Record<string, unknown>;
  const bil     = input['billingDetails']    as Record<string, unknown>;
  const score   = input['healthScore']       as number;

  const recommendations: string[] = [];
  const opportunities: string[] = [];

  if ((eng['mauRatio'] as number) >= 80) {
    recommendations.push('High MAU ratio — strong adoption signal, ready for seat expansion pitch');
    opportunities.push('Seat expansion: current usage suggests 2–3 additional seats needed');
  }
  if ((eng['uniqueFeatures'] as number) < 8) {
    recommendations.push('Feature adoption gap — introduce advanced reporting and integrations in next touchpoint');
    opportunities.push('Feature upsell: advancedReports, integrations, aiInsights not yet activated');
  }
  if ((bil['arrGrowthPct'] as number) > 15) {
    recommendations.push('ARR growing >15% — tier upgrade conversation is timely');
    opportunities.push('Plan upgrade: growth signals align with Enterprise tier value props');
  }
  if ((bil['renewalRisk'] as string) === 'low') {
    recommendations.push('Long runway before renewal — ideal time for expansion motion');
  }

  return {
    recommendations,
    opportunities,
    playbook: 'expansion-v3',
    urgency:  score >= 85 ? 'proactive' : 'standard',
  };
};

const buildCsmReportTool: ToolFn = async (input) => {
  const accountName     = input['accountName']       as string;
  const plan            = input['plan']              as string;
  const healthScore     = input['healthScore']       as number;
  const healthGrade     = input['healthGrade']       as string;
  const riskLevel       = input['riskLevel']         as string;
  const scoreComponents = input['scoreComponents']   as Record<string, unknown>;
  const engDet          = input['engagementDetails'] as Record<string, unknown>;
  const supDet          = input['supportDetails']    as Record<string, unknown>;
  const bilDet          = input['billingDetails']    as Record<string, unknown>;
  const recommendations = (input['recommendations']  as string[]) ?? [];
  const nextSteps       = (input['nextSteps']        as string[]) ?? [];
  const opportunities   = (input['opportunities']    as string[]) ?? [];
  const playbook        = input['playbook']          as string;
  const urgency         = input['urgency']           as string;

  const path = (playbook ?? '').includes('intervention') ? 'intervention' : 'expansion';

  const report = {
    generatedAt:  new Date().toISOString(),
    account:      { name: accountName, plan },
    health:       { score: healthScore, grade: healthGrade, riskLevel },
    scores:       scoreComponents,
    engagement:   engDet,
    support:      supDet,
    billing:      bilDet,
    path,
    playbook,
    urgency,
    recommendations,
    nextSteps,
    opportunities,
  };

  const summary =
    path === 'intervention'
      ? `[${healthGrade}] ${accountName} — HEALTH ${healthScore}/100 (${riskLevel} risk). ` +
        `Urgency: ${urgency}. ${recommendations.length} action(s). Next: ${nextSteps[0] ?? 'see report'}`
      : `[${healthGrade}] ${accountName} — HEALTH ${healthScore}/100 (${riskLevel} risk). ` +
        `Expansion: ${urgency}. ${opportunities.length} opportunit(ies). Playbook: ${playbook}`;

  return { report, summary };
};

// ── Tool Registry ─────────────────────────────────────────────────────────

const TOOLS: Record<string, ToolFn> = {
  'load-account':   loadAccountTool,
  'engagement':     computeEngagementTool,
  'support':        computeSupportTool,
  'billing':        computeBillingTool,
  'score-health':   scoreHealthTool,
  'intervention':   generateInterventionTool,
  'expansion':      generateExpansionTool,
  'csm-report':     buildCsmReportTool,
};

// ── Workflow Definition ───────────────────────────────────────────────────

const accountHealthWorkflow: WorkflowDefinition = {
  id: 'account-health-check',
  name: 'Account Health Check',
  description: 'Multi-dimensional SaaS customer health scoring with conditional CSM playbook routing',
  version: '1.0.0',
  entryStepId: 'validate-request',
  steps: [
    {
      id: 'validate-request',
      name: 'Validate Request',
      type: 'deterministic' as const,
      handler: 'script:validate-request',
      config: {
        script: `
          if (!variables.accountId || typeof variables.accountId !== 'string') {
            throw new Error('accountId is required and must be a string');
          }
          return { valid: true, accountId: variables.accountId };
        `,
      },
      outputMap: { accountId: 'accountId' },
    },
    {
      id: 'load-account',
      name: 'Load Account',
      type: 'deterministic' as const,
      handler: 'tool:load-account',
      inputMap:  { accountId: 'accountId' },
      outputMap: { account: '' },
    },
    {
      id: 'compute-engagement',
      name: 'Compute Engagement Score',
      type: 'deterministic' as const,
      handler: 'tool:engagement',
      inputMap:  { account: 'account' },
      outputMap: { engagementScore: 'engagementScore', engagementDetails: 'engagementDetails' },
    },
    {
      id: 'compute-support',
      name: 'Compute Support Score',
      type: 'deterministic' as const,
      handler: 'tool:support',
      inputMap:  { tickets: 'account.tickets' },
      outputMap: { supportScore: 'supportScore', supportDetails: 'supportDetails' },
    },
    {
      id: 'compute-billing',
      name: 'Compute Billing Score',
      type: 'deterministic' as const,
      handler: 'tool:billing',
      inputMap: {
        invoices:        'account.invoices',
        arr:             'account.arr',
        contractEndDays: 'account.contractEndDays',
      },
      outputMap: { billingScore: 'billingScore', billingDetails: 'billingDetails' },
    },
    {
      id: 'score-health',
      name: 'Compute Composite Health Score',
      type: 'deterministic' as const,
      handler: 'tool:score-health',
      inputMap: {
        engagementScore: 'engagementScore',
        supportScore:    'supportScore',
        billingScore:    'billingScore',
        accountName:     'account.name',
        plan:            'account.plan',
      },
      outputMap: {
        healthScore:     'healthScore',
        healthGrade:     'healthGrade',
        riskLevel:       'riskLevel',
        scoreComponents: 'scoreComponents',
      },
    },
    {
      id: 'check-risk',
      name: 'Check Risk Threshold',
      type: 'condition' as const,
      config: { expression: { '<': [{ var: 'healthScore' }, 60] } },
      next: ['generate-intervention', 'generate-expansion'],
    },
    {
      id: 'generate-intervention',
      name: 'Generate Intervention Playbook',
      type: 'deterministic' as const,
      handler: 'tool:intervention',
      inputMap: {
        engagementDetails: 'engagementDetails',
        supportDetails:    'supportDetails',
        billingDetails:    'billingDetails',
        healthScore:       'healthScore',
      },
      outputMap: {
        recommendations: 'recommendations',
        nextSteps:       'nextSteps',
        playbook:        'playbook',
        urgency:         'urgency',
      },
      next: 'build-csm-report',
    },
    {
      id: 'generate-expansion',
      name: 'Generate Expansion Playbook',
      type: 'deterministic' as const,
      handler: 'tool:expansion',
      inputMap: {
        engagementDetails: 'engagementDetails',
        billingDetails:    'billingDetails',
        healthScore:       'healthScore',
      },
      outputMap: {
        recommendations: 'recommendations',
        opportunities:   'opportunities',
        playbook:        'playbook',
        urgency:         'urgency',
      },
      next: 'build-csm-report',
    },
    {
      id: 'build-csm-report',
      name: 'Build CSM Report',
      type: 'deterministic' as const,
      handler: 'tool:csm-report',
      inputMap: {
        accountName:       'account.name',
        plan:              'account.plan',
        healthScore:       'healthScore',
        healthGrade:       'healthGrade',
        riskLevel:         'riskLevel',
        scoreComponents:   'scoreComponents',
        engagementDetails: 'engagementDetails',
        supportDetails:    'supportDetails',
        billingDetails:    'billingDetails',
        recommendations:   'recommendations',
        nextSteps:         'nextSteps',
        opportunities:     'opportunities',
        playbook:          'playbook',
        urgency:           'urgency',
      },
      outputMap: { report: 'report', summary: 'summary' },
    },
  ],
};

// ── Portfolio Workflow Definition ─────────────────────────────────────────

const portfolioReviewWorkflow: WorkflowDefinition = {
  id: 'portfolio-review',
  name: 'CSM Portfolio Review',
  description: 'Runs health checks across all accounts and ranks by risk',
  version: '1.0.0',
  entryStepId: 'validate-portfolio',
  steps: [
    {
      id: 'validate-portfolio',
      name: 'Validate Portfolio Input',
      type: 'deterministic' as const,
      handler: 'script:validate-portfolio',
      config: {
        script: `
          if (!variables.accountIds || !Array.isArray(variables.accountIds)) {
            throw new Error('accountIds array is required');
          }
          return { validated: true, count: variables.accountIds.length };
        `,
      },
    },
    {
      id: 'invoke-health-checks',
      name: 'Invoke Health Checks Per Account',
      type: 'deterministic' as const,
      handler: 'invoke-health-check',
      outputMap: { accountReports: 'accountReports' },
    },
    {
      id: 'rank-by-health',
      name: 'Rank Accounts by Health Score',
      type: 'deterministic' as const,
      handler: 'script:rank-by-health',
      config: {
        script: `
          const reports = variables.accountReports || [];
          const ranked = [...reports].sort((a, b) => a.healthScore - b.healthScore);
          const atRisk = ranked.filter(r => r.healthScore < 60);
          const healthy = ranked.filter(r => r.healthScore >= 60);
          return { rankedAccounts: ranked, atRisk, healthy };
        `,
      },
      outputMap: { rankedAccounts: 'rankedAccounts', atRisk: 'atRisk', healthy: 'healthy' },
    },
  ],
};

// ── Engine Factory ────────────────────────────────────────────────────────

function buildEngine(extraHandlers?: Record<string, (vars: Record<string, unknown>, config?: Record<string, unknown>) => Promise<unknown>>): DefaultWorkflowEngine {
  const registry = new HandlerResolverRegistry();
  registry.register(createNoopResolver());
  registry.register(createScriptResolver());
  registry.register(
    createToolResolver({
      async getTool(toolKey: string) {
        return TOOLS[toolKey];
      },
    }),
  );

  const engine = new DefaultWorkflowEngine({
    resolverRegistry: registry,
    spanEmitter: new InMemorySpanEmitter(),
  });

  if (extraHandlers) {
    for (const [key, fn] of Object.entries(extraHandlers)) {
      engine.registerHandler(key, fn);
    }
  }

  return engine;
}

// ─────────────────────────────────────────────────────────────────────────
//  Scenario A — Direct workflow execution for all 4 accounts
// ─────────────────────────────────────────────────────────────────────────

async function scenarioA() {
  header('Scenario A — Account Health Workflow (4 accounts, condition branching)');

  const engine = buildEngine();
  await engine.createDefinition(accountHealthWorkflow);

  const accounts = [
    { id: 'startup-alpha',    expectedBranch: 'expansion',     minScore: 65, maxScore: 85 },
    { id: 'enterprise-beta',  expectedBranch: 'expansion',     minScore: 75, maxScore: 100 },
    { id: 'midmarket-gamma',  expectedBranch: 'intervention',  minScore: 20, maxScore: 55 },
    { id: 'scaleup-delta',    expectedBranch: 'expansion',     minScore: 70, maxScore: 100 },
  ];

  for (const { id, expectedBranch, minScore, maxScore } of accounts) {
    sub(id);
    const run = await engine.startRun('account-health-check', { accountId: id });

    if (run.status !== 'completed') {
      fail(`${id} run failed: ${run.error ?? '(unknown)'}`);
    }

    const vars    = run.state.variables as Record<string, unknown>;
    const score   = vars['healthScore']  as number;
    const grade   = vars['healthGrade']  as string;
    const risk    = vars['riskLevel']    as string;
    const summary = vars['summary']      as string;
    const steps   = run.state.history.map(h => h.stepId);

    ok(`Health ${score}/100 (Grade ${grade}, ${risk} risk)`);
    info(summary);

    // Verify score in expected band
    if (score < minScore || score > maxScore) {
      fail(`score ${score} outside expected [${minScore}–${maxScore}]`);
    }

    // Verify correct branch was taken
    const tookIntervention = steps.includes('generate-intervention');
    const tookExpansion    = steps.includes('generate-expansion');
    if (expectedBranch === 'intervention' && !tookIntervention) fail(`expected intervention branch for ${id}`);
    if (expectedBranch === 'expansion'    && !tookExpansion)    fail(`expected expansion branch for ${id}`);
    if (tookIntervention && tookExpansion) fail(`both branches taken — logic error`);

    ok(`Correct branch: ${expectedBranch}`);

    // Verify all base steps ran
    const requiredSteps = ['validate-request','load-account','compute-engagement','compute-support','compute-billing','score-health','check-risk','build-csm-report'];
    for (const stepId of requiredSteps) {
      if (!steps.includes(stepId)) fail(`required step "${stepId}" did not execute`);
    }

    // Spot-check variable propagation
    const engDet = vars['engagementDetails'] as Record<string, unknown>;
    const supDet = vars['supportDetails']    as Record<string, unknown>;
    const bilDet = vars['billingDetails']    as Record<string, unknown>;
    if (!engDet || !supDet || !bilDet) fail('sub-score details not propagated to final variables');

    ok(`Steps: ${steps.length}, sub-scores: engagement=${vars['engagementScore']}, support=${vars['supportScore']}, billing=${vars['billingScore']}`);
  }

  ok('All 4 accounts scored and branched correctly');
}

// ─────────────────────────────────────────────────────────────────────────
//  Scenario B — weaveAgent drives portfolio analysis
// ─────────────────────────────────────────────────────────────────────────

async function scenarioB() {
  header('Scenario B — weaveAgent: portfolio analysis via workflow tools');

  const engine = buildEngine();
  await engine.createDefinition(accountHealthWorkflow);

  const tools = weaveToolRegistry();

  tools.register(weaveTool({
    name: 'analyze_account',
    description: 'Run the full health check workflow for a single account and return a structured report.',
    parameters: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: 'The account ID to analyze' },
      },
      required: ['accountId'],
    },
    execute: async (args: { accountId: string }) => {
      const run = await engine.startRun('account-health-check', { accountId: args.accountId });
      if (run.status !== 'completed') {
        return JSON.stringify({ error: run.error, accountId: args.accountId });
      }
      const vars = run.state.variables as Record<string, unknown>;
      return JSON.stringify({
        accountId:    args.accountId,
        accountName:  (vars['account'] as Account).name,
        healthScore:  vars['healthScore'],
        healthGrade:  vars['healthGrade'],
        riskLevel:    vars['riskLevel'],
        summary:      vars['summary'],
        urgency:      vars['urgency'],
        playbook:     vars['playbook'],
        recommendations: vars['recommendations'],
        nextSteps:    vars['nextSteps'],
        opportunities: vars['opportunities'],
      });
    },
  }));

  tools.register(weaveTool({
    name: 'get_at_risk_accounts',
    description: 'Analyze all accounts and return those with health score below a threshold.',
    parameters: {
      type: 'object',
      properties: {
        threshold: { type: 'number', description: 'Health score threshold (default 60)' },
      },
      required: [],
    },
    execute: async (args: { threshold?: number }) => {
      const threshold = args.threshold ?? 60;
      const results = [];
      for (const accountId of Object.keys(ACCOUNT_DB)) {
        const run = await engine.startRun('account-health-check', { accountId });
        const vars = run.state.variables as Record<string, unknown>;
        const score = vars['healthScore'] as number;
        if (score < threshold) {
          results.push({
            accountId,
            accountName: (vars['account'] as Account).name,
            healthScore: score,
            riskLevel:   vars['riskLevel'],
            urgency:     vars['urgency'],
            topRecommendation: ((vars['recommendations'] as string[]) ?? [])[0] ?? null,
          });
        }
      }
      results.sort((a, b) => a.healthScore - b.healthScore);
      return JSON.stringify({ threshold, atRiskCount: results.length, accounts: results });
    },
  }));

  tools.register(weaveTool({
    name: 'compare_accounts',
    description: 'Compare health metrics across multiple accounts side by side.',
    parameters: {
      type: 'object',
      properties: {
        accountIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Account IDs to compare',
        },
      },
      required: ['accountIds'],
    },
    execute: async (args: { accountIds: string[] }) => {
      const comparison = [];
      for (const accountId of args.accountIds) {
        const run = await engine.startRun('account-health-check', { accountId });
        const vars = run.state.variables as Record<string, unknown>;
        const acc  = vars['account'] as Account;
        comparison.push({
          accountId,
          name:            acc.name,
          plan:            acc.plan,
          healthScore:     vars['healthScore'],
          healthGrade:     vars['healthGrade'],
          riskLevel:       vars['riskLevel'],
          engagementScore: vars['engagementScore'],
          supportScore:    vars['supportScore'],
          billingScore:    vars['billingScore'],
          arrGrowthPct:    (vars['billingDetails'] as Record<string, unknown>)['arrGrowthPct'],
        });
      }
      comparison.sort((a, b) => (b.healthScore as number) - (a.healthScore as number));
      return JSON.stringify({ comparison });
    },
  }));

  const model = weaveAnthropicModel('claude-haiku-4-5-20251001');
  const agent = weaveAgent({
    name:         'csm-portfolio-agent',
    model,
    tools,
    systemPrompt: `You are a Customer Success Manager AI assistant. You have access to workflow tools that analyze SaaS customer health metrics. Use them to identify at-risk accounts, compare performance, and recommend CSM actions. Be specific and data-driven. The accounts in the system are: startup-alpha, enterprise-beta, midmarket-gamma, scaleup-delta.`,
    maxSteps:     12,
  });

  const ctx = weaveContext({ userId: 'csm-lead' });
  const result = await agent.run(ctx, {
    messages: [{
      role:    'user',
      content: 'Find all at-risk accounts (health < 60) and give me a prioritised action plan. Then compare all four accounts side by side so I can see where each stands.',
    }],
  });

  info('Agent response:');
  console.log('\n' + result.output.split('\n').map((l: string) => `    ${l}`).join('\n'));
  ok(`Agent completed in ${result.steps.length} steps`);
}

// ─────────────────────────────────────────────────────────────────────────
//  Scenario C — Portfolio parent workflow invokes child health checks
// ─────────────────────────────────────────────────────────────────────────

async function scenarioC() {
  header('Scenario C — Portfolio parent workflow with child workflow invocation');

  // The `invoke-health-check` handler iterates over accountIds and runs the child
  // workflow for each, accumulating results into variables.accountReports
  const invokeHealthCheckHandler = async (
    vars: Record<string, unknown>,
  ): Promise<unknown> => {
    const accountIds = vars['accountIds'] as string[];
    const childEngine = buildEngine();
    await childEngine.createDefinition(accountHealthWorkflow);

    const accountReports: Array<{
      accountId: string;
      healthScore: number;
      healthGrade: string;
      riskLevel: string;
      summary: string;
    }> = [];

    for (const accountId of accountIds) {
      const run = await childEngine.startRun('account-health-check', { accountId });
      if (run.status === 'completed') {
        const v = run.state.variables as Record<string, unknown>;
        accountReports.push({
          accountId,
          healthScore: v['healthScore'] as number,
          healthGrade: v['healthGrade'] as string,
          riskLevel:   v['riskLevel']   as string,
          summary:     v['summary']     as string,
        });
      }
    }

    return { accountReports };
  };

  const engine = buildEngine({ 'invoke-health-check': invokeHealthCheckHandler });
  await engine.createDefinition(portfolioReviewWorkflow);

  const run = await engine.startRun('portfolio-review', {
    accountIds: ['startup-alpha', 'enterprise-beta', 'midmarket-gamma', 'scaleup-delta'],
  });

  if (run.status !== 'completed') {
    fail(`Portfolio review failed: ${run.error ?? '(unknown)'}`);
  }

  const vars   = run.state.variables as Record<string, unknown>;
  const ranked = vars['rankedAccounts'] as Array<{ accountId: string; healthScore: number; healthGrade: string; summary: string }>;
  const atRisk = vars['atRisk']         as typeof ranked;
  const healthy= vars['healthy']        as typeof ranked;

  ok(`Portfolio review completed — ${ranked.length} accounts processed`);
  sub('Ranked by health score (lowest first):');
  for (const acc of ranked) {
    info(`[${acc.healthGrade}] ${acc.accountId} — ${acc.healthScore}/100`);
    info(`    ${acc.summary}`);
  }

  if (atRisk.length === 0) fail('Expected at least one at-risk account (midmarket-gamma)');
  if (!atRisk.some(a => a.accountId === 'midmarket-gamma')) fail('midmarket-gamma should be at-risk');
  ok(`At-risk accounts: ${atRisk.map(a => a.accountId).join(', ')}`);
  ok(`Healthy accounts: ${healthy.map(a => a.accountId).join(', ')}`);

  // Verify steps ran in correct order
  const stepIds = run.state.history.map(h => h.stepId);
  const expected = ['validate-portfolio', 'invoke-health-checks', 'rank-by-health'];
  for (const sid of expected) {
    if (!stepIds.includes(sid)) fail(`step "${sid}" did not execute`);
  }
  ok(`All portfolio steps executed: ${stepIds.join(' → ')}`);
}

// ─────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  SaaS Customer Health Intelligence Platform');
  console.log('  Example 23 — Complex Data Structures + Workflow Engine\n');

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
