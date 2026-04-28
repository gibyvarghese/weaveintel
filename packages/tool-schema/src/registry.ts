/**
 * Adapter registry.
 *
 * Holds the live set of {@link ProviderToolAdapter}s available to the
 * translator. Built-in adapters are pre-registered. Apps may load
 * additional adapters from a DB-backed `provider_tool_adapters` row by
 * mapping the row's `adapter_module` to a runtime adapter instance
 * (e.g. via dynamic import) and calling {@link AdapterRegistry.register}.
 */

import { openaiAdapter } from './adapters/openai.js';
import { anthropicAdapter } from './adapters/anthropic.js';
import { googleAdapter } from './adapters/google.js';
import type { ProviderToolAdapter } from './types.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, ProviderToolAdapter>();

  constructor(initial: readonly ProviderToolAdapter[] = BUILTIN_ADAPTERS) {
    for (const a of initial) this.adapters.set(a.provider, a);
  }

  register(adapter: ProviderToolAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: string): ProviderToolAdapter | undefined {
    return this.adapters.get(provider);
  }

  require(provider: string): ProviderToolAdapter {
    const a = this.adapters.get(provider);
    if (!a) throw new Error(`No tool-schema adapter registered for provider "${provider}"`);
    return a;
  }

  list(): readonly ProviderToolAdapter[] {
    return Array.from(this.adapters.values());
  }
}

export const BUILTIN_ADAPTERS: readonly ProviderToolAdapter[] = [
  openaiAdapter,
  anthropicAdapter,
  googleAdapter,
];

/** Process-wide default registry containing the three built-in adapters. */
export const defaultAdapterRegistry = new AdapterRegistry();
