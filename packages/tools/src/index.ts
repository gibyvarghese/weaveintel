// @weaveintel/tools — Public API
export {
  type ExtendedToolDescriptor,
  type ToolHealthStats,
  type ToolHealthTracker,
  type ToolTestCase,
  type ToolTestResult,
  type ExtendedToolRegistry,
  describeT as weaveToolDescriptor,
  createHealthTracker as weaveHealthTracker,
  runToolTests as weaveRunToolTests,
  createExtendedToolRegistry as weaveExtendedToolRegistry,
  toolsToMCPDefinitions,
  createMCPToolHandler,
} from './registry.js';

export {
  type PolicyResolutionContext,
  type ToolPolicyResolver,
  type ToolAuditEmitter,
  type ToolRateLimiter,
  type ToolApprovalGate,
  type ApprovalDecision,
  type PolicyEnforcedToolOptions,
  DEFAULT_TOOL_POLICY,
  InMemoryToolPolicyResolver,
  noopAuditEmitter,
  ToolPolicyViolationError,
  resolveEffectivePolicy,
  createPolicyEnforcedTool,
  createPolicyEnforcedRegistry,
} from './policy.js';
