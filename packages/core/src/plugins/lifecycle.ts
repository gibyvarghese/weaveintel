// @weaveintel/plugins — Plugin lifecycle: init, start, stop hooks

export type LifecyclePhase = 'init' | 'start' | 'stop' | 'destroy';

export interface LifecycleHook {
  readonly phase: LifecyclePhase;
  readonly handler: () => Promise<void> | void;
  readonly priority: number;
}

export interface PluginLifecycle {
  register(pluginId: string, phase: LifecyclePhase, handler: () => Promise<void> | void, priority?: number): void;
  execute(pluginId: string, phase: LifecyclePhase): Promise<void>;
  executeAll(phase: LifecyclePhase): Promise<void>;
  getHooks(pluginId: string): readonly LifecycleHook[];
  clear(pluginId: string): void;
}

export function createPluginLifecycle(): PluginLifecycle {
  const hooks = new Map<string, LifecycleHook[]>();

  return {
    register(pluginId, phase, handler, priority = 0) {
      const list = hooks.get(pluginId) ?? [];
      list.push({ phase, handler, priority });
      list.sort((a, b) => a.priority - b.priority);
      hooks.set(pluginId, list);
    },

    async execute(pluginId, phase) {
      const list = hooks.get(pluginId) ?? [];
      for (const hook of list.filter((h) => h.phase === phase)) {
        await hook.handler();
      }
    },

    async executeAll(phase) {
      for (const [pluginId] of hooks) {
        await this.execute(pluginId, phase);
      }
    },

    getHooks(pluginId) { return hooks.get(pluginId) ?? []; },
    clear(pluginId) { hooks.delete(pluginId); },
  };
}
