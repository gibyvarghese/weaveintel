export { registerGuardrailRoutes } from './guardrails.js';
export { registerRoutingRoutes } from './routing.js';
export { registerModelPricingRoutes } from './model-pricing.js';
export { registerWorkflowRoutes } from './workflows.js';
export { registerTaskPolicyRoutes } from './task-policies.js';
export { registerTaskContractRoutes } from './task-contracts.js';
export { registerIdentityRuleRoutes } from './identity-rules.js';
export { registerMemoryGovernanceRoutes } from './memory-governance.js';
export { registerComplianceRuleRoutes } from './compliance-rules.js';
export { registerToolRoutes } from './tools.js';
export { registerToolPolicyRoutes } from './tool-policies.js';
export { registerToolAuditRoutes } from './tool-audit.js';
export { registerToolHealthRoutes } from './tool-health.js';
export { registerToolCredentialRoutes } from './tool-credentials.js';
export { registerToolSimulationRoutes } from './tool-simulation.js';
export { registerMCPGatewayClientRoutes } from './mcp-gateway-clients.js';
export { registerMCPGatewayActivityRoutes } from './mcp-gateway-activity.js';
export { registerSkillRoutes } from './skills.js';
export { registerWorkerAgentRoutes } from './worker-agents.js';
export { registerSupervisorAgentRoutes } from './agents.js';
export { registerToolApprovalRequestRoutes } from './tool-approval-requests.js';

// ── anyWeave Phase 4: Task-aware routing admin API + UI ─────
export { registerTaskTypeRoutes } from './task-types.js';
export { registerCapabilityScoreRoutes } from './capability-scores.js';
export { registerProviderToolAdapterRoutes } from './provider-tool-adapters.js';
export { registerTaskTypeTenantOverrideRoutes } from './task-type-tenant-overrides.js';
export { registerRoutingDecisionTraceRoutes } from './routing-decision-traces.js';
export { registerRoutingSimulatorRoutes } from './routing-simulator.js';

// ── anyWeave Phase 5: Feedback loop ─────────────────────────
export { registerRoutingCapabilitySignalRoutes } from './routing-capability-signals.js';
export { registerMessageFeedbackRoutes } from './message-feedback.js';
export { registerRoutingSurfaceItemRoutes } from './routing-surface-items.js';
