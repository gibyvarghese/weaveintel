/**
 * @weaveintel/live-agents — LLM loop scaffold (Phase 2.5).
 *
 * This sub-folder owns the live-agents-specific ReAct loop. It is the
 * SEAM between the live-agents runtime (heartbeat, attention, action
 * executor) and the underlying ReAct/tool-calling engine. The handler
 * code in `agentic-task-handler.ts` MUST import from here rather than
 * directly from `@weaveintel/agents` so that:
 *
 *   - Live-agent budget enforcement, idempotency, and pause/resume
 *     semantics can be added without touching `@weaveintel/agents`.
 *   - The loop can be swapped (e.g. for a streaming variant or a
 *     deterministic replay variant) without forking handler code.
 *
 * Phase 2.5 ships the scaffold + a thin pass-through implementation
 * over `@weaveintel/agents.weaveAgent`. Later phases will plug in the
 * Phase 3.5 model resolver, tool binder, and budget envelope.
 */

export {
  runLiveReactLoop,
  type LiveReactLoopInput,
  type LiveReactLoopResult,
  type LiveReactLoopStep,
} from './react-runner.js';
export type {
  LiveAgentBudget,
  LiveAgentRunStatus,
  ModelCapabilitySpec,
} from './types.js';
export { BudgetExhausted } from './budget.js';
