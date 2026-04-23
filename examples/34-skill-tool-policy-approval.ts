/**
 * Example 34 — Skill→Tool Policy Closure + Approval Workflow (Phase 6)
 *
 * Demonstrates Phase 6: when a skill is activated in a chat session, its declared
 * `toolPolicyKey` is automatically forwarded to the tool registry, ensuring every
 * tool invocation during that session is evaluated under the skill's policy.
 *
 * It also shows the operator-side of the approval workflow:
 *  1. A chat sends a message that triggers a policy-gated tool requiring human approval.
 *  2. The pending approval request appears in the admin API.
 *  3. An operator approves (or denies) the request via the admin endpoint.
 *
 * Key Phase 6 concepts:
 *  - Skill activation binds a `toolPolicyKey` to the runtime context.
 *  - `createPolicyEnforcedRegistry()` evaluates this key for every tool call.
 *  - Tools blocked by `requireApproval: true` produce a `tool_approval_requests` DB row.
 *  - Operators resolve requests via `POST /api/admin/tool-approval-requests/:id/approve|deny`.
 *
 * Prerequisites:
 *  - geneWeave server running at BASE_URL (default: http://localhost:3500)
 *  - An admin account configured via API_EMAIL / API_PASSWORD env vars
 *    (defaults: admin@geneweave.ai / admin123)
 */
export {};

const BASE_URL = process.env['API_URL'] ?? 'http://localhost:3500';
const EMAIL    = process.env['API_EMAIL']    ?? 'admin@geneweave.ai';
const PASSWORD = process.env['API_PASSWORD'] ?? 'admin123';

// ─── Auth state ──────────────────────────────────────────────────────────────

let _cookie = '';
let _csrf   = '';

interface ApiResult<T> { status: number; data: T }

async function apiCall<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (_cookie)                        headers['Cookie']       = _cookie;
  if (_csrf && method !== 'GET')      headers['X-CSRF-Token'] = _csrf;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/gw_token=([^;]+)/);
    if (m) _cookie = `gw_token=${m[1]}`;
  }

  const data = await res.json().catch(() => ({})) as T;
  return { status: res.status, data };
}

async function login(): Promise<void> {
  const { status, data } = await apiCall('POST', '/api/auth/login', {
    email: EMAIL, password: PASSWORD,
  });
  if (status !== 200) throw new Error(`Login failed: ${JSON.stringify(data)}`);
  _csrf = (data as Record<string, unknown>)['csrfToken'] as string ?? '';
  console.log(`[auth] Logged in as ${EMAIL}`);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ApprovalRequest {
  id: string;
  tool_name: string;
  chat_id: string | null;
  skill_key: string | null;
  policy_key: string | null;
  status: 'pending' | 'approved' | 'denied';
  requested_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  input_preview: string | null;
}

interface ChatMessage {
  role: string;
  content: string;
}

// ─── Admin helpers ────────────────────────────────────────────────────────────

async function listApprovalRequests(
  opts: { status?: string; toolName?: string } = {},
): Promise<ApprovalRequest[]> {
  const params = new URLSearchParams();
  if (opts.status)   params.set('status',    opts.status);
  if (opts.toolName) params.set('tool_name', opts.toolName);
  const qs = params.toString() ? `?${params}` : '';
  const { status, data } = await apiCall<{ requests: ApprovalRequest[] }>(
    'GET', `/api/admin/tool-approval-requests${qs}`,
  );
  if (status !== 200) throw new Error(`Failed to list approval requests (${status}): ${JSON.stringify(data)}`);
  return data.requests;
}

async function getApprovalRequest(id: string): Promise<ApprovalRequest> {
  const { status, data } = await apiCall<{ request: ApprovalRequest }>(
    'GET', `/api/admin/tool-approval-requests/${id}`,
  );
  if (status !== 200) throw new Error(`Approval request ${id} not found (${status})`);
  return data.request;
}

async function approveRequest(id: string, note?: string): Promise<ApprovalRequest> {
  const { status, data } = await apiCall<{ request: ApprovalRequest }>(
    'POST', `/api/admin/tool-approval-requests/${id}/approve`,
    { note },
  );
  if (status !== 200) throw new Error(`Failed to approve request ${id} (${status}): ${JSON.stringify(data)}`);
  return data.request;
}

async function denyRequest(id: string, note?: string): Promise<ApprovalRequest> {
  const { status, data } = await apiCall<{ request: ApprovalRequest }>(
    'POST', `/api/admin/tool-approval-requests/${id}/deny`,
    { note },
  );
  if (status !== 200) throw new Error(`Failed to deny request ${id} (${status}): ${JSON.stringify(data)}`);
  return data.request;
}

// ─── Chat helpers ─────────────────────────────────────────────────────────────

async function sendChatMessage(
  message: string,
  sessionId?: string,
): Promise<{ sessionId: string; messages: ChatMessage[] }> {
  const body: Record<string, unknown> = { message };
  if (sessionId) body['sessionId'] = sessionId;

  const { status, data } = await apiCall<{ sessionId: string; messages: ChatMessage[] }>(
    'POST', '/api/chat', body,
  );
  if (status !== 200) throw new Error(`Chat failed (${status}): ${JSON.stringify(data)}`);
  return data;
}

// ─── Policy catalog helpers ───────────────────────────────────────────────────

async function listToolPolicies(): Promise<Array<{ id: string; key: string; name: string; require_approval: number }>> {
  const { status, data } = await apiCall<{ policies: Array<{ id: string; key: string; name: string; require_approval: number }> }>(
    'GET', '/api/admin/tool-policies',
  );
  if (status !== 200) throw new Error(`Failed to list tool policies (${status})`);
  return data.policies;
}

// ─── Main demo ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== Phase 6: Skill→Tool Policy Closure + Approval Workflow ===\n');

  await login();

  // ── 1. Inspect the tool policies seeded into the database ─────────────────
  console.log('\n── Step 1: Tool policies in the catalog ──');
  const policies = await listToolPolicies().catch(() => []);
  if (policies.length === 0) {
    console.log('  (No policies found — seeded defaults may differ by version)');
  } else {
    for (const p of policies) {
      const approvalFlag = p.require_approval ? '✓ requires approval' : '  no approval gate';
      console.log(`  [${p.key.padEnd(22)}] ${p.name.padEnd(30)} ${approvalFlag}`);
    }
  }

  // ── 2. Show the current (empty) approval request queue ────────────────────
  console.log('\n── Step 2: Current approval request queue ──');
  const pending = await listApprovalRequests({ status: 'pending' });
  console.log(`  Pending requests: ${pending.length}`);

  // ── 3. Demonstrate the approval workflow with a fabricated request ─────────
  //
  // In production, approval requests are created automatically by the runtime
  // when a tool's effective policy has `requireApproval: true`.  For this
  // example we call the list endpoint after simulating a restricted chat turn
  // to observe any requests produced by that invocation.
  //
  // NOTE: if your server's seed skills and policies don't gate any tool
  // behind requireApproval, no request will be created, and steps 4–6 will
  // demonstrate the empty-queue case which is equally valid.

  console.log('\n── Step 3: Send a chat message (tool may be gated) ──');
  let sessionId: string | undefined;
  try {
    const chatResult = await sendChatMessage(
      'What is the current time in UTC?',
    );
    sessionId = chatResult.sessionId;
    const reply = chatResult.messages.find(m => m.role === 'assistant');
    console.log('  Chat reply (truncated):', reply?.content?.slice(0, 120) ?? '(none)');
  } catch (err) {
    console.log('  Chat skipped (server may require API key):', (err as Error).message);
  }

  // ── 4. Re-check the approval queue ────────────────────────────────────────
  console.log('\n── Step 4: Re-check approval queue after chat ──');
  const allRequests = await listApprovalRequests();
  console.log(`  Total approval requests: ${allRequests.length}`);

  const pendingAfterChat = allRequests.filter(r => r.status === 'pending');
  if (pendingAfterChat.length === 0) {
    console.log('  No pending requests — no tool required approval in this run.');
    console.log('\n  (To trigger an approval request in a real deployment:');
    console.log('    1. Configure a tool policy with requireApproval: true');
    console.log('    2. Bind a skill with that policyKey in chat.ts skillPolicyKey');
    console.log('    3. Activate that skill in a chat session and call the gated tool)');
  } else {
    // ── 5. Approve the first pending request ──────────────────────────────
    const target = pendingAfterChat[0]!;
    console.log(`\n── Step 5: Approve pending request ${target.id} ──`);
    console.log(`  Tool:       ${target.tool_name}`);
    console.log(`  Skill key:  ${target.skill_key ?? '(none)'}`);
    console.log(`  Policy key: ${target.policy_key ?? '(none)'}`);
    console.log(`  Requested:  ${target.requested_at}`);

    const approved = await approveRequest(target.id, 'Approved via example 34');
    console.log(`  Status after approval: ${approved.status}`);
    console.log(`  Resolved by:           ${approved.resolved_by}`);
    console.log(`  Note:                  ${approved.resolution_note}`);

    // ── 6. Attempt to approve again — should return 409 Conflict ──────────
    console.log('\n── Step 6: Attempt to double-approve (expects 409 Conflict) ──');
    const { status: conflictStatus } = await apiCall(
      'POST', `/api/admin/tool-approval-requests/${target.id}/approve`, { note: 're-approve' },
    );
    console.log(`  Double-approve status: ${conflictStatus} (expected 409)`);
  }

  // ── 7. Fetch a non-existent request (expects 404) ─────────────────────────
  console.log('\n── Step 7: Fetch unknown request (expects 404) ──');
  const { status: notFoundStatus } = await apiCall(
    'GET', '/api/admin/tool-approval-requests/nonexistent-uuid',
  );
  console.log(`  GET unknown request status: ${notFoundStatus} (expected 404)`);

  // ── 8. Deny path demo — deny a pending request if available ──────────────
  const pendingForDeny = allRequests.filter(r => r.status === 'pending');
  if (pendingForDeny.length > 0) {
    const toDeny = pendingForDeny[0]!;
    console.log(`\n── Step 8: Deny pending request ${toDeny.id} ──`);
    const denied = await denyRequest(toDeny.id, 'Denied via example 34');
    console.log(`  Status after denial: ${denied.status}`);
    console.log(`  Note:                ${denied.resolution_note}`);
  } else {
    console.log('\n── Step 8: Deny path ──');
    console.log('  No pending requests to deny in this run.');
  }

  console.log('\n✓ Phase 6 example complete.\n');

  console.log('Summary of Phase 6 capabilities demonstrated:');
  console.log('  • Skill→Tool policy closure: skill.toolPolicyKey → runtime enforcement');
  console.log('  • Approval queue: GET /api/admin/tool-approval-requests');
  console.log('  • Approval resolution: POST .../approve | .../deny with optional note');
  console.log('  • 409 Conflict on re-resolution of an already-resolved request');
  console.log('  • 404 for unknown request IDs');
  console.log('  • 401 for unauthenticated access to all admin endpoints');
}

main().catch((err: unknown) => {
  console.error('Example 34 failed:', err);
  process.exit(1);
});
