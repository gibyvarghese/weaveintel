/**
 * GeneWeave — Admin Tool Simulation routes (Phase 5)
 *
 * Operators can test tool invocations directly from admin before enabling
 * in production. Returns full policy resolution trace and optional tool output.
 *
 * Endpoints:
 *   GET  /api/admin/tool-simulation/tools   — list tools available for simulation
 *   POST /api/admin/tool-simulation          — run a simulation (dryRun or full exec)
 */

import { randomUUID } from 'node:crypto';
import { weaveContext } from '@weaveintel/core';
import { weaveRunToolTests } from '@weaveintel/tools';
import type { ToolRiskLevel } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { DbToolPolicyResolver } from '../../tool-policy-resolver.js';
import { DbToolAuditEmitter } from '../../tool-audit-emitter.js';
import { BUILTIN_TOOLS } from '../../tools.js';

function truncatePreview(s: string, max = 500): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function registerToolSimulationRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  /** List all tools available for simulation (builtins + enabled custom catalog entries). */
  router.get('/api/admin/tool-simulation/tools', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const builtinTools = Object.entries(BUILTIN_TOOLS).map(([key, tool]) => ({
      key,
      name: tool.schema.name,
      description: tool.schema.description,
      tags: tool.schema.tags ?? [],
      source: 'builtin',
    }));

    const catalogEntries = await db.listEnabledToolCatalog();
    const customTools = catalogEntries
      .filter(e => e.source !== 'builtin' && e.enabled)
      .map(e => ({
        key: e.tool_key ?? e.name,
        name: e.name,
        description: e.description ?? '',
        tags: [] as string[],
        source: e.source ?? 'custom',
      }));

    json(res, 200, { tools: [...builtinTools, ...customTools] });
  }, { auth: true });

  /**
   * Run a tool simulation.
   *
   * Request body:
   *   toolName   string          — name of the tool to simulate
   *   inputJson  string|object   — tool arguments as JSON string or object
   *   dryRun     boolean         — if true, only resolve policy (no execution)
   *   chatContext object         — optional { agentPersona, skillPolicyKey, chatId, userId }
   *
   * Response:
   *   simulationId  UUID
   *   toolName      string
   *   dryRun        boolean
   *   policy        EffectiveToolPolicy
   *   policyTrace   Array<{ step, passed, detail }>
   *   allowed       boolean
   *   violationReason? string
   *   result?       { content: string, isError?: boolean }
   *   durationMs    number
   *   auditEventId  UUID
   */
  router.post('/api/admin/tool-simulation', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const toolName = body['toolName'];
    if (!toolName || typeof toolName !== 'string') {
      json(res, 400, { error: 'toolName is required' }); return;
    }

    const inputJsonRaw = body['inputJson'] ?? '{}';
    const dryRun = body['dryRun'] === true;
    const chatContext = (body['chatContext'] as Record<string, unknown>) ?? {};

    // Parse tool input arguments
    let parsedInput: Record<string, unknown>;
    try {
      parsedInput = typeof inputJsonRaw === 'string'
        ? JSON.parse(inputJsonRaw) as Record<string, unknown>
        : inputJsonRaw as Record<string, unknown>;
    } catch {
      json(res, 400, { error: 'inputJson must be valid JSON' }); return;
    }

    const simulationId = randomUUID();
    const auditEventId = randomUUID();
    const startMs = Date.now();

    const resolutionContext = {
      agentPersona: typeof chatContext['agentPersona'] === 'string' ? chatContext['agentPersona'] : undefined,
      skillPolicyKey: typeof chatContext['skillPolicyKey'] === 'string' ? chatContext['skillPolicyKey'] : undefined,
      chatId: typeof chatContext['chatId'] === 'string' ? chatContext['chatId'] : simulationId,
      userId: typeof chatContext['userId'] === 'string' ? chatContext['userId'] : auth.userId,
    };

    // 1. Resolve effective policy via DB-backed resolver
    const resolver = new DbToolPolicyResolver(db);
    let policy;
    try {
      policy = await resolver.resolve(toolName, resolutionContext);
    } catch (err) {
      json(res, 500, { error: `Policy resolution failed: ${(err as Error).message}` }); return;
    }

    // 2. Build policy trace — step through each enforcement check without side effects
    const policyTrace: Array<{ step: string; passed: boolean; detail: string }> = [];
    let allowed = true;
    let violationReason: string | undefined;

    // Step 1: Enabled check
    const enabledPassed = !!policy.enabled;
    policyTrace.push({
      step: 'enabled_check',
      passed: enabledPassed,
      detail: enabledPassed
        ? 'Tool is enabled in catalog'
        : 'Tool is disabled — set enabled=true in Tool Catalog to allow invocations',
    });
    if (!enabledPassed) {
      allowed = false;
      violationReason = 'disabled';
    }

    // Step 2: Risk level gate
    if (allowed) {
      const catalogEntry = await db.getToolCatalogByKey(toolName);
      const toolRiskLevel = (catalogEntry?.risk_level ?? 'read-only') as ToolRiskLevel;
      const allowedRisks = policy.allowedRiskLevels ?? [];
      const riskPassed = allowedRisks.length === 0 || allowedRisks.includes(toolRiskLevel);
      policyTrace.push({
        step: 'risk_level_gate',
        passed: riskPassed,
        detail: riskPassed
          ? `Risk level '${toolRiskLevel}' is permitted by the active policy`
          : `Risk level '${toolRiskLevel}' is blocked — policy allows only [${allowedRisks.join(', ')}]`,
      });
      if (!riskPassed) {
        allowed = false;
        violationReason = 'risk_level_blocked';
      }
    }

    // Step 3: Approval gate — note if required (simulation bypasses actual gate)
    if (allowed) {
      const approvalRequired = !!policy.requiresApproval;
      policyTrace.push({
        step: 'approval_gate',
        passed: true,
        detail: approvalRequired
          ? 'Approval required — production invocations will be gated (simulation bypasses this check)'
          : 'No approval required',
      });
    }

    // Step 4: Rate limit — show configuration without incrementing
    if (allowed) {
      if (policy.rateLimitPerMinute && policy.rateLimitPerMinute > 0) {
        policyTrace.push({
          step: 'rate_limit',
          passed: true,
          detail: `Rate limit configured: ${policy.rateLimitPerMinute} invocations/min (simulation does not consume quota)`,
        });
      } else {
        policyTrace.push({
          step: 'rate_limit',
          passed: true,
          detail: 'No rate limit configured',
        });
      }
    }

    // Step 5: Timeout
    if (allowed) {
      policyTrace.push({
        step: 'timeout',
        passed: true,
        detail: policy.timeoutMs && policy.timeoutMs > 0
          ? `Execution timeout: ${policy.timeoutMs}ms`
          : 'No execution timeout configured',
      });
    }

    // 3. Execute tool if allowed and not dryRun
    let result: { content: string; isError?: boolean } | undefined;
    let errorMessage: string | undefined;

    if (allowed && !dryRun) {
      const tool = BUILTIN_TOOLS[toolName];
      if (!tool) {
        // Custom/MCP/A2A tools: not executable in sandbox simulation mode
        json(res, 404, {
          error: `Tool '${toolName}' is not a builtin tool. MCP and A2A tools cannot be executed in simulation mode — use dryRun:true for policy inspection only.`,
        });
        return;
      }

      const execCtx = weaveContext({
        executionId: simulationId,
        userId: resolutionContext.userId,
        metadata: { simulationMode: true, adminSimulation: true },
      });

      const testResults = await weaveRunToolTests(tool, execCtx, [{
        name: 'simulation',
        input: { name: toolName, arguments: parsedInput },
      }]);

      const testResult = testResults[0];
      if (testResult) {
        if (testResult.error) {
          result = { content: testResult.error, isError: true };
          errorMessage = testResult.error;
        } else if (testResult.actual) {
          const output = testResult.actual;
          const rawContent = output.content;
          result = {
            content: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent),
            isError: !!output.isError,
          };
        }
      }
    }

    const durationMs = Date.now() - startMs;
    const outcome: string = !allowed ? 'denied_policy' : result?.isError ? 'error' : 'simulation';

    // 4. Emit audit event — best-effort, non-blocking
    const auditEmitter = new DbToolAuditEmitter(db);
    void auditEmitter.emit({
      toolName,
      chatId: resolutionContext.chatId,
      userId: resolutionContext.userId,
      agentPersona: resolutionContext.agentPersona,
      skillKey: resolutionContext.skillPolicyKey,
      policyId: policy.policyId,
      outcome: outcome as any, // 'simulation' is a valid ToolAuditOutcome
      violationReason: violationReason as any,
      durationMs,
      inputPreview: truncatePreview(JSON.stringify(parsedInput)),
      outputPreview: result ? truncatePreview(result.content) : undefined,
      errorMessage,
      createdAt: new Date().toISOString(),
    });

    json(res, 200, {
      simulationId,
      auditEventId,
      toolName,
      dryRun,
      policy,
      policyTrace,
      allowed,
      violationReason,
      result,
      durationMs,
    });
  }, { auth: true, csrf: true });
}
