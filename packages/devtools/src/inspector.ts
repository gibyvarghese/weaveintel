/**
 * @weaveintel/devtools — Runtime capability inspector
 *
 * Inspect what capabilities, tools, models, and plugins are registered in a
 * running weaveIntel application.
 */

import type {
  ToolRegistry,
  PluginRegistry,
  EventBus,
  CapabilityDescriptor,
} from '@weaveintel/core';

export interface InspectionReport {
  timestamp: string;
  tools: ToolInspection[];
  plugins: PluginInspection[];
  capabilities: CapabilityDescriptor[];
  events: EventInspection;
}

export interface ToolInspection {
  name: string;
  description?: string;
  parameterCount: number;
  hasExecute: boolean;
}

export interface PluginInspection {
  name: string;
  type: string;
  description?: string;
}

export interface EventInspection {
  registeredHandlers: number;
}

export interface InspectorOptions {
  tools?: ToolRegistry;
  plugins?: PluginRegistry;
  bus?: EventBus;
  capabilities?: CapabilityDescriptor[];
}

/**
 * Inspect the runtime and produce a structured report.
 */
export function inspect(opts: InspectorOptions): InspectionReport {
  const tools: ToolInspection[] = [];
  if (opts.tools) {
    for (const def of opts.tools.toDefinitions()) {
      tools.push({
        name: def.name,
        description: def.description,
        parameterCount: Object.keys((def.parameters as Record<string, unknown>)?.['properties'] ?? {}).length,
        hasExecute: true,
      });
    }
  }

  const plugins: PluginInspection[] = [];
  if (opts.plugins) {
    for (const p of opts.plugins.all()) {
      plugins.push({
        name: p.descriptor.name,
        type: p.descriptor.type,
        description: p.descriptor.metadata?.['description'] as string | undefined,
      });
    }
  }

  return {
    timestamp: new Date().toISOString(),
    tools,
    plugins,
    capabilities: opts.capabilities ?? [],
    events: { registeredHandlers: 0 },
  };
}

/**
 * Print a human-readable summary of the inspection report.
 */
export function formatReport(report: InspectionReport): string {
  const lines: string[] = [];
  lines.push(`=== weaveIntel Runtime Inspection ===`);
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push('');

  lines.push(`Tools (${report.tools.length}):`);
  for (const t of report.tools) {
    lines.push(`  - ${t.name}: ${t.description ?? '(no desc)'} [${t.parameterCount} params]`);
  }
  lines.push('');

  lines.push(`Plugins (${report.plugins.length}):`);
  for (const p of report.plugins) {
    lines.push(`  - ${p.name} (${p.type}): ${p.description ?? '(no desc)'}`);
  }
  lines.push('');

  lines.push(`Capabilities: ${report.capabilities.length}`);
  lines.push(`Event handlers: ${report.events.registeredHandlers}`);

  return lines.join('\n');
}
