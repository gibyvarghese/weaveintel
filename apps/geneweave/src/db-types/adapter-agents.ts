import type { WorkerAgentRow, SupervisorAgentRow, AgentToolRow, ResolvedSupervisorAgent, AgentStrategySettingsRow } from './agents.js';
import type { WorkflowRunRow, WorkflowCheckpointRow, CapabilityPolicyBindingRow } from './workflows.js';

export interface IAgentStore {
  // Worker agents
  createWorkerAgent(w: Omit<WorkerAgentRow, 'created_at' | 'updated_at'>): Promise<void>;
  getWorkerAgent(id: string): Promise<WorkerAgentRow | null>;
  listWorkerAgents(): Promise<WorkerAgentRow[]>;
  listEnabledWorkerAgents(): Promise<WorkerAgentRow[]>;
  listWorkerAgentsByCategory(category: string): Promise<WorkerAgentRow[]>;
  updateWorkerAgent(id: string, fields: Partial<Omit<WorkerAgentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteWorkerAgent(id: string): Promise<void>;

  // Supervisor agents
  createSupervisorAgent(a: Omit<SupervisorAgentRow, 'created_at' | 'updated_at'>, tools?: Array<{ tool_name: string; allocation?: string }>): Promise<void>;
  getSupervisorAgent(id: string): Promise<SupervisorAgentRow | null>;
  listSupervisorAgents(opts?: { tenantId?: string | null; category?: string; enabledOnly?: boolean }): Promise<SupervisorAgentRow[]>;
  updateSupervisorAgent(id: string, fields: Partial<Omit<SupervisorAgentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteSupervisorAgent(id: string): Promise<void>;
  listAgentTools(agentId: string): Promise<AgentToolRow[]>;
  setAgentTools(agentId: string, tools: Array<{ tool_name: string; allocation?: string }>): Promise<void>;
  resolveSupervisorAgent(opts: { tenantId?: string | null; category?: string; skillId?: string | null }): Promise<ResolvedSupervisorAgent | null>;

  // Workflow runs
  createWorkflowRun(r: Omit<WorkflowRunRow, 'completed_at'>): Promise<void>;
  getWorkflowRun(id: string): Promise<WorkflowRunRow | null>;
  listWorkflowRuns(workflowId?: string): Promise<WorkflowRunRow[]>;
  updateWorkflowRun(id: string, fields: Partial<Omit<WorkflowRunRow, 'id' | 'started_at'>>): Promise<void>;
  deleteWorkflowRun(id: string): Promise<void>;

  // Workflow checkpoints
  createWorkflowCheckpoint(c: Omit<WorkflowCheckpointRow, 'created_at'>): Promise<void>;
  listWorkflowCheckpoints(runId: string): Promise<WorkflowCheckpointRow[]>;
  deleteWorkflowCheckpoints(runId: string): Promise<void>;

  // Capability policy bindings
  createCapabilityPolicyBinding(b: Omit<CapabilityPolicyBindingRow, 'created_at' | 'updated_at'>): Promise<void>;
  getCapabilityPolicyBinding(id: string): Promise<CapabilityPolicyBindingRow | null>;
  listCapabilityPolicyBindings(opts?: { bindingKind?: string; bindingRef?: string; policyKind?: string; enabledOnly?: boolean }): Promise<CapabilityPolicyBindingRow[]>;
  updateCapabilityPolicyBinding(id: string, fields: Partial<Omit<CapabilityPolicyBindingRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteCapabilityPolicyBinding(id: string): Promise<void>;

  // Agent strategy settings (global / per-tenant defaults)
  getAgentStrategySettings(id: string): Promise<AgentStrategySettingsRow | null>;
  updateAgentStrategySettings(id: string, patch: Partial<Omit<AgentStrategySettingsRow, 'id' | 'updated_at'>>): Promise<void>;
  listAgentStrategySettings(): Promise<AgentStrategySettingsRow[]>;
}
