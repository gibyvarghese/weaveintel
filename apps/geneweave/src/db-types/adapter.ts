/** DatabaseAdapter interface and DatabaseConfig — composed from domain sub-interfaces. */

import type { IUserStore } from './adapter-users.js';
import type { IChatStore } from './adapter-chats.js';
import type { IPromptStore } from './adapter-prompts.js';
import type { IRoutingStore } from './adapter-routing.js';
import type { IWorkflowStore } from './adapter-workflows.js';
import type { IToolStore } from './adapter-tools.js';
import type { IAgentStore } from './adapter-agents.js';
import type { ICostStore } from './adapter-cost.js';
import type { IEncryptionStore } from './adapter-encryption.js';
import type { ICapabilityStore } from './adapter-capabilities.js';
import type { IAdminStore } from './adapter-admin.js';
import type { IMemoryStore } from './adapter-memory.js';
import type { IKaggleStore } from './adapter-kaggle.js';
import type { ILiveAgentsStore } from './adapter-live-agents.js';
import type { IMeStore } from './adapter-me.js';

export type { IUserStore } from './adapter-users.js';
export type { IChatStore } from './adapter-chats.js';
export type { IPromptStore } from './adapter-prompts.js';
export type { IRoutingStore } from './adapter-routing.js';
export type { IWorkflowStore } from './adapter-workflows.js';
export type { IToolStore } from './adapter-tools.js';
export type { IAgentStore } from './adapter-agents.js';
export type { ICostStore } from './adapter-cost.js';
export type { IEncryptionStore } from './adapter-encryption.js';
export type { ICapabilityStore } from './adapter-capabilities.js';
export type { IAdminStore } from './adapter-admin.js';
export type { IMemoryStore } from './adapter-memory.js';
export type { IKaggleStore } from './adapter-kaggle.js';
export type { ILiveAgentsStore } from './adapter-live-agents.js';
export type { IMeStore } from './adapter-me.js';

export interface DatabaseAdapter extends
  IUserStore,
  IChatStore,
  IPromptStore,
  IRoutingStore,
  IWorkflowStore,
  IToolStore,
  IAgentStore,
  ICostStore,
  IEncryptionStore,
  ICapabilityStore,
  IAdminStore,
  IMemoryStore,
  IKaggleStore,
  ILiveAgentsStore,
  IMeStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseConfig {
  type: 'sqlite' | 'custom';
  /** SQLite file path (default: './geneweave.db') */
  path?: string;
  /** Provide your own adapter for Postgres, MySQL, Mongo, etc. */
  adapter?: DatabaseAdapter;
}
