/**
 * @weaveintel/core — Plugin registry
 *
 * Why: All providers, connectors, vector stores, memory backends, etc. register
 * through a unified plugin system. The core never knows about specific implementations.
 * This is what makes "add a new provider without changing core" possible.
 */

import type { CapabilityId, HasCapabilities } from './capabilities.js';

export interface PluginDescriptor {
  readonly name: string;
  readonly version: string;
  readonly type: PluginType;
  readonly capabilities: ReadonlySet<CapabilityId>;
  readonly metadata?: Record<string, unknown>;
}

export type PluginType =
  | 'model-provider'
  | 'embedding-provider'
  | 'reranker-provider'
  | 'vector-store'
  | 'connector'
  | 'memory-store'
  | 'redactor'
  | 'policy-engine'
  | 'observability-sink'
  | 'eval-evaluator'
  | 'transport';

export interface Plugin extends HasCapabilities {
  readonly descriptor: PluginDescriptor;
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface PluginRegistry {
  register(plugin: Plugin): void;
  unregister(name: string): void;
  get<T extends Plugin>(name: string): T | undefined;
  getByType(type: PluginType): Plugin[];
  getByCapability(capability: CapabilityId): Plugin[];
  all(): Plugin[];
}

export function createPluginRegistry(): PluginRegistry {
  const plugins = new Map<string, Plugin>();

  return {
    register(plugin: Plugin): void {
      if (plugins.has(plugin.descriptor.name)) {
        throw new Error(`Plugin "${plugin.descriptor.name}" is already registered`);
      }
      plugins.set(plugin.descriptor.name, plugin);
    },

    unregister(name: string): void {
      plugins.delete(name);
    },

    get<T extends Plugin>(name: string): T | undefined {
      return plugins.get(name) as T | undefined;
    },

    getByType(type: PluginType): Plugin[] {
      return [...plugins.values()].filter((p) => p.descriptor.type === type);
    },

    getByCapability(capability: CapabilityId): Plugin[] {
      return [...plugins.values()].filter((p) => p.hasCapability(capability));
    },

    all(): Plugin[] {
      return [...plugins.values()];
    },
  };
}
