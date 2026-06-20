/**
 * @weaveintel/core — A2A (Agent-to-Agent) protocol contracts
 *
 * Aligned with A2A v1.0 (Linux Foundation, 2026).
 * https://a2a-protocol.org/latest/specification/
 *
 * v1.0 breaking changes vs v0.2/v0.3:
 *   - Task states: SCREAMING_SNAKE_CASE; three new states (INPUT_REQUIRED, AUTH_REQUIRED, REJECTED)
 *   - A2APart: unified field-presence model (no `type` discriminator)
 *   - A2ATask: full task object (contextId, artifacts[], history[], nested status object)
 *   - A2ATaskSendParams: separate type for what clients send
 *   - AgentCard: supportedInterfaces[], capabilities object, skills with required `id`
 *   - A2AServer.handleMessage() primary; handleTask() kept as deprecated compat shim
 */

import type { ExecutionContext } from './context.js';

// ─── Task States ─────────────────────────────────────────────

/** A2A v1.0 task state (SCREAMING_SNAKE_CASE). */
export type A2ATaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'   // agent paused, waiting for more input
  | 'TASK_STATE_AUTH_REQUIRED'    // agent needs fresh credentials
  | 'TASK_STATE_REJECTED';        // agent refused (policy/quota)

/** @deprecated Use A2ATaskState (SCREAMING_SNAKE_CASE values). */
export type A2ATaskStatus = 'submitted' | 'working' | 'completed' | 'failed' | 'cancelled';

// ─── Parts ───────────────────────────────────────────────────

/**
 * A2A v1.0 Part — field-presence polymorphism (no `type` discriminator).
 * Exactly one of text / raw / url / data should be present.
 */
export interface A2APart {
  readonly text?: string;       // inline text content
  readonly raw?: string;        // base64-encoded bytes
  readonly url?: string;        // remote file reference
  readonly data?: unknown;      // structured JSON value
  readonly mediaType?: string;  // MIME type
  readonly filename?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Extract a text representation from a single part. Returns null for unrecognised parts. */
export function a2aPartText(part: A2APart): string | null {
  if (typeof part.text === 'string') return part.text;
  if (part.data !== undefined) return JSON.stringify(part.data);
  if (typeof part.url === 'string') return `[File: ${part.filename ?? part.url}]`;
  if (typeof part.raw === 'string') return `[Binary: ${part.mediaType ?? 'application/octet-stream'}]`;
  return null;
}

/** Extract and join text from all parts in an array. */
export function a2aPartsText(parts: readonly A2APart[]): string {
  return parts
    .map(a2aPartText)
    .filter((t): t is string => t !== null)
    .join('\n');
}

// ─── Artifact ────────────────────────────────────────────────

/** A2A v1.0 Artifact — a structured, named task output (separate from the conversation). */
export interface A2AArtifact {
  readonly artifactId: string;
  readonly name: string;
  readonly parts: readonly A2APart[];
  readonly metadata?: Record<string, unknown>;
}

// ─── Message ─────────────────────────────────────────────────

/** A2A v1.0 Message — a single turn in the conversation. */
export interface A2AMessage {
  readonly role: 'user' | 'agent';
  readonly parts: readonly A2APart[];
  readonly messageId?: string;
  readonly contextId?: string;       // groups related tasks; same across a session
  readonly taskId?: string;          // set when continuing an interrupted task
  readonly referenceTaskIds?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

// ─── Task Status Object ──────────────────────────────────────

/** A2A v1.0 nested task status (state + optional message + timestamp). */
export interface A2ATaskStatusObj {
  readonly state: A2ATaskState;
  readonly message?: A2AMessage;  // optional status message (e.g. INPUT_REQUIRED prompt)
  readonly timestamp: string;     // ISO 8601
}

// ─── Task (server-returned) ──────────────────────────────────

/** A2A v1.0 Task — what the server returns after creating or updating a task. */
export interface A2ATask {
  readonly id: string;
  readonly contextId: string;
  readonly status: A2ATaskStatusObj;
  readonly artifacts: readonly A2AArtifact[];
  readonly history: readonly A2AMessage[];
  readonly metadata?: Record<string, unknown>;
}

// ─── Send Params (client → server) ──────────────────────────

/** What clients send when submitting or continuing a task. */
export interface A2ATaskSendParams {
  readonly message: A2AMessage;
  readonly configuration?: A2ASendConfiguration;
  readonly metadata?: Record<string, unknown>;
}

export interface A2ASendConfiguration {
  readonly acceptedOutputModes?: readonly string[];
  readonly returnImmediately?: boolean;
  readonly historyLength?: number;
}

// ─── Stream Events ───────────────────────────────────────────

export interface TaskStatusUpdateEvent {
  readonly taskId: string;
  readonly contextId: string;
  readonly status: A2ATaskStatusObj;
}

export interface TaskArtifactUpdateEvent {
  readonly taskId: string;
  readonly contextId: string;
  readonly artifact: A2AArtifact;
  readonly append: boolean;    // true → concatenate with previous chunk for this artifact
  readonly lastChunk: boolean; // true → final chunk
}

/** All possible SSE event shapes in a task stream. */
export type A2AStreamEvent =
  | { readonly task: A2ATask }
  | { readonly message: A2AMessage }
  | { readonly statusUpdate: TaskStatusUpdateEvent }
  | { readonly artifactUpdate: TaskArtifactUpdateEvent };

// ─── Push Notifications ──────────────────────────────────────

export interface A2APushNotificationConfig {
  readonly url: string;
  readonly token?: string;
  readonly authentication?: {
    readonly schemes: readonly string[];
    readonly credentials?: string;
  };
}

/** Server-assigned push notification config entry (extends config with id + audit fields). */
export interface A2APushNotificationConfigEntry extends A2APushNotificationConfig {
  readonly pushConfigId: string;
  readonly taskId: string;
  readonly createdAt: string;
}

// ─── Agent Card ──────────────────────────────────────────────

/** A2A v1.0: replaces the flat `url` field. */
export interface AgentInterface {
  readonly url: string;
  readonly protocolBinding: 'JSONRPC' | 'GRPC';
  readonly protocolVersion: string;
  readonly tenant?: string;
}

export interface AgentCapabilityExtension {
  readonly uri: string;
  readonly version: string;
  readonly required: boolean;
  readonly description?: string;
}

/** A2A v1.0 capabilities (was a `string[]` in v0.2/v0.3). */
export interface AgentCapabilities {
  readonly streaming: boolean;
  readonly pushNotifications: boolean;
  readonly extendedAgentCard: boolean;
  readonly stateTransitionHistory: boolean;
  readonly extensions?: readonly AgentCapabilityExtension[];
}

export type AgentSecurityScheme =
  | { readonly type: 'apiKey'; readonly name: string; readonly in: 'header' | 'query' }
  | { readonly type: 'http'; readonly scheme: 'bearer' | 'basic' }
  | { readonly type: 'oauth2'; readonly flows: Record<string, unknown> }
  | { readonly type: 'openIdConnect'; readonly openIdConnectUrl: string }
  | { readonly type: 'mutualTLS' };

export interface AgentCardSignature {
  readonly algorithm: string;  // e.g. "ES256"
  readonly keyId: string;      // URL to JWKS
  readonly signature: string;  // JWS compact
}

/** A2A v1.0 Skill — `id` is required and maps to JWT scope claims. */
export interface AgentSkill {
  readonly id: string;             // required; kebab-case; used in JWT scope
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly examples?: readonly string[];
  readonly inputModes?: readonly string[];
  readonly outputModes?: readonly string[];
}

/** A2A v1.0 Agent Card. */
export interface AgentCard {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly skills: readonly AgentSkill[];
  readonly capabilities: AgentCapabilities;
  readonly supportedInterfaces: readonly AgentInterface[];
  readonly defaultInputModes?: readonly string[];
  readonly defaultOutputModes?: readonly string[];
  readonly provider?: { readonly organization: string; readonly url: string };
  readonly securitySchemes?: Readonly<Record<string, AgentSecurityScheme>>;
  readonly security?: ReadonlyArray<Readonly<Record<string, readonly string[]>>>;
  readonly signatures?: readonly AgentCardSignature[];
  readonly documentationUrl?: string;
  readonly iconUrl?: string;
  readonly privacyPolicyUrl?: string;
  readonly termsOfServiceUrl?: string;
  /** @deprecated Use supportedInterfaces[0].url. Kept for backward compat with v0.3. */
  readonly url?: string;
}

/** @deprecated Use securitySchemes in AgentCard. */
export interface AgentAuthentication {
  readonly type: 'none' | 'api_key' | 'oauth2' | 'bearer';
  readonly credentials?: Record<string, string>;
}

// ─── Client ──────────────────────────────────────────────────

export interface A2AListTasksFilter {
  readonly contextId?: string;
  readonly state?: A2ATaskState;
  readonly statusTimestampAfter?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface A2ATaskPage {
  readonly tasks: readonly A2ATask[];
  readonly nextPageToken?: string;
  readonly totalSize?: number;
}

export interface A2AClient {
  /** Fetch and validate the AgentCard from /.well-known/agent-card.json (falls back to agent.json). */
  discover(url: string): Promise<AgentCard>;

  /** Submit a new task (or continue an interrupted one via message.taskId). */
  sendMessage(ctx: ExecutionContext, agentUrl: string, params: A2ATaskSendParams): Promise<A2ATask>;

  /** Submit a task and receive streamed events over SSE. */
  streamMessage(ctx: ExecutionContext, agentUrl: string, params: A2ATaskSendParams): AsyncIterable<A2AStreamEvent>;

  /** Fetch task state by ID. */
  getTask(ctx: ExecutionContext, agentUrl: string, taskId: string, historyLength?: number): Promise<A2ATask>;

  /** Paginated task listing. */
  listTasks(ctx: ExecutionContext, agentUrl: string, filter?: A2AListTasksFilter): Promise<A2ATaskPage>;

  /** Cancel an in-progress task. */
  cancelTask(ctx: ExecutionContext, agentUrl: string, taskId: string): Promise<void>;

  /** Reconnect SSE stream to an in-progress task. */
  subscribeToTask(ctx: ExecutionContext, agentUrl: string, taskId: string): AsyncIterable<A2AStreamEvent>;

  // ── Push Notifications (A2A v1.0) ──────────────────────────────────────────
  /** Register a webhook for push notifications on a task. */
  createPushConfig(ctx: ExecutionContext, agentUrl: string, taskId: string, config: A2APushNotificationConfig): Promise<A2APushNotificationConfigEntry>;
  /** Retrieve a push notification config by ID. */
  getPushConfig(ctx: ExecutionContext, agentUrl: string, taskId: string, configId: string): Promise<A2APushNotificationConfigEntry>;
  /** List all push notification configs for a task. */
  listPushConfigs(ctx: ExecutionContext, agentUrl: string, taskId: string): Promise<readonly A2APushNotificationConfigEntry[]>;
  /** Delete a push notification config. */
  deletePushConfig(ctx: ExecutionContext, agentUrl: string, taskId: string, configId: string): Promise<boolean>;

  // ── Deprecated v0.3 compat ─────────────────────────────────────────────────
  /** @deprecated Use sendMessage(). */
  sendTask?(ctx: ExecutionContext, agentUrl: string, task: A2ATaskLegacy): Promise<A2ATaskResult>;
  /** @deprecated Use streamMessage(). */
  streamTask?(ctx: ExecutionContext, agentUrl: string, task: A2ATaskLegacy): AsyncIterable<A2ATaskResult>;
  /** @deprecated Use getTask(). */
  getTaskStatus?(ctx: ExecutionContext, agentUrl: string, taskId: string): Promise<A2ATaskResult>;
}

// ─── Server ──────────────────────────────────────────────────

export interface A2AServer {
  readonly card: AgentCard;

  /** Primary handler — receive send params, return full A2ATask. */
  handleMessage(ctx: ExecutionContext, params: A2ATaskSendParams): Promise<A2ATask>;

  /** Optional: streaming handler — yields A2AStreamEvents over SSE. */
  handleStreamMessage?(ctx: ExecutionContext, params: A2ATaskSendParams): AsyncIterable<A2AStreamEvent>;

  /** Optional: fetch a previously created task by ID. */
  getTask?(ctx: ExecutionContext, taskId: string): Promise<A2ATask | null>;

  /** Optional: paginated task listing. */
  listTasks?(ctx: ExecutionContext, filter?: A2AListTasksFilter): Promise<A2ATaskPage>;

  /** Optional: cancel an in-progress task. */
  cancelTask?(ctx: ExecutionContext, taskId: string): Promise<void>;

  /** Optional: return the extended agent card with additional metadata. */
  getExtendedCard?(ctx: ExecutionContext): Promise<AgentCard>;

  // ── Push Notifications (A2A v1.0) ──────────────────────────────────────────
  /** Optional: register a push notification webhook for a task. */
  createPushConfig?(ctx: ExecutionContext, taskId: string, config: A2APushNotificationConfig): Promise<A2APushNotificationConfigEntry>;
  /** Optional: retrieve a push notification config. */
  getPushConfig?(ctx: ExecutionContext, taskId: string, configId: string): Promise<A2APushNotificationConfigEntry | null>;
  /** Optional: list push notification configs for a task. */
  listPushConfigs?(ctx: ExecutionContext, taskId: string): Promise<readonly A2APushNotificationConfigEntry[]>;
  /** Optional: delete a push notification config. */
  deletePushConfig?(ctx: ExecutionContext, taskId: string, configId: string): Promise<boolean>;

  /** Lifecycle — HTTP serving is handled by the host app; no-op for in-process adapters. */
  start(port: number): Promise<void>;
  stop(): Promise<void>;

  // ── Deprecated v0.3 compat ─────────────────────────────────────────────────
  /** @deprecated Use handleMessage(). */
  handleTask?(ctx: ExecutionContext, task: A2ATaskLegacy): Promise<A2ATaskResult>;
  /** @deprecated Use handleStreamMessage(). */
  handleStreamTask?(ctx: ExecutionContext, task: A2ATaskLegacy): AsyncIterable<A2ATaskResult>;
}

// ─── Internal bus ────────────────────────────────────────────

export interface InternalA2ABus {
  register(name: string, handler: A2AServer): void;
  unregister(name: string): void;
  /** Dispatch a task to a named registered agent. */
  send(ctx: ExecutionContext, target: string, params: A2ATaskSendParams): Promise<A2ATask>;
  discover(name: string): AgentCard | undefined;
  listAgents(): AgentCard[];
}

// ─── Deprecated legacy types ─────────────────────────────────

/**
 * @deprecated Use A2ATaskSendParams (what clients send) + A2ATask (what servers return).
 * Kept for callers that construct A2ATask literals with the old `id`/`input` shape.
 */
export interface A2ATaskLegacy {
  readonly id: string;
  readonly skill?: string;
  readonly input: A2AMessage;
  readonly metadata?: Record<string, unknown>;
}

/**
 * @deprecated Use A2ATask (the v1.0 full task object with contextId, artifacts, history).
 * The old flat result shape: string `status` and `output: A2AMessage`.
 */
export interface A2ATaskResult {
  readonly id: string;
  readonly status: A2ATaskStatus;
  readonly output?: A2AMessage;
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
}

// ─── Convenience helpers ─────────────────────────────────────

/** Build a terminal COMPLETED A2ATask from a text output string. */
export function makeCompletedA2ATask(
  taskId: string,
  contextId: string,
  outputText: string,
  history: readonly A2AMessage[] = [],
): A2ATask {
  return {
    id: taskId,
    contextId,
    status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: `${taskId}-output`, name: 'output', parts: [{ text: outputText }] }],
    history,
  };
}

/** Build a terminal FAILED A2ATask from an error string. */
export function makeFailedA2ATask(
  taskId: string,
  contextId: string,
  error: string,
  history: readonly A2AMessage[] = [],
): A2ATask {
  return {
    id: taskId,
    contextId,
    status: {
      state: 'TASK_STATE_FAILED',
      message: { role: 'agent', parts: [{ text: error }] },
      timestamp: new Date().toISOString(),
    },
    artifacts: [],
    history,
  };
}

/** Extract the primary text output from the first artifact of an A2ATask. */
export function a2aTaskOutputText(task: A2ATask): string {
  const artifact = task.artifacts[0];
  if (!artifact) {
    const lastAgent = [...task.history].reverse().find((m) => m.role === 'agent');
    return lastAgent ? a2aPartsText(lastAgent.parts) : '';
  }
  return a2aPartsText(artifact.parts);
}
