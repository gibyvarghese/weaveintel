/**
 * @weaveintel/tools — Extended tool registry
 *
 * Rich tool metadata (risk level, side effects, rate limits), lifecycle policies,
 * health telemetry, test harness, and MCP bridge for auto-exposing tools.
 */

import type {
  Tool,
  ToolSchema,
  ToolInput,
  ToolOutput,
  ToolRegistry,
  ExecutionContext,
  ToolRiskLevel,
  ToolDescriptor,
  ToolHealth,
} from '@weaveintel/core';
import { weaveToolRegistry } from '@weaveintel/core';

// ─── Descriptor ──────────────────────────────────────────────

export interface ExtendedToolDescriptor extends ToolDescriptor {
  readonly rateLimit?: { readonly perMinute: number };
  readonly maxExecutionMs?: number;
}

export function describeT(
  name: string,
  description: string,
  risk: ToolRiskLevel,
  opts?: Partial<Omit<ExtendedToolDescriptor, 'name' | 'description' | 'riskLevel'>>,
): ExtendedToolDescriptor {
  return { id: name, name, description, riskLevel: risk, version: '1.0.0', deprecated: false, sideEffects: false, requiresApproval: false, ...opts };
}

// ─── Health tracker ──────────────────────────────────────────

export interface ToolHealthStats {
  toolName: string;
  invocations: number;
  errors: number;
  avgLatencyMs: number;
  lastInvoked: number | null;
  circuitOpen: boolean;
}

export interface ToolHealthTracker {
  record(toolName: string, latencyMs: number, isError: boolean): void;
  get(toolName: string): ToolHealthStats;
  getAll(): ToolHealthStats[];
  isCircuitOpen(toolName: string): boolean;
  reset(toolName: string): void;
}

export function createHealthTracker(opts?: { errorThreshold?: number; windowMs?: number }): ToolHealthTracker {
  const errorThreshold = opts?.errorThreshold ?? 5;
  const windowMs = opts?.windowMs ?? 60_000;
  const stats = new Map<string, { invocations: number; errors: number; totalLatency: number; lastInvoked: number | null; recentErrors: number[]; circuitOpen: boolean }>();

  function ensure(name: string) {
    if (!stats.has(name)) {
      stats.set(name, { invocations: 0, errors: 0, totalLatency: 0, lastInvoked: null, recentErrors: [], circuitOpen: false });
    }
    return stats.get(name)!;
  }

  return {
    record(toolName: string, latencyMs: number, isError: boolean): void {
      const s = ensure(toolName);
      s.invocations++;
      s.totalLatency += latencyMs;
      s.lastInvoked = Date.now();
      if (isError) {
        s.errors++;
        s.recentErrors.push(Date.now());
        const cutoff = Date.now() - windowMs;
        s.recentErrors = s.recentErrors.filter(t => t > cutoff);
        if (s.recentErrors.length >= errorThreshold) {
          s.circuitOpen = true;
        }
      }
    },
    get(toolName: string): ToolHealthStats {
      const s = ensure(toolName);
      return {
        toolName,
        invocations: s.invocations,
        errors: s.errors,
        avgLatencyMs: s.invocations > 0 ? Math.round(s.totalLatency / s.invocations) : 0,
        lastInvoked: s.lastInvoked,
        circuitOpen: s.circuitOpen,
      };
    },
    getAll(): ToolHealthStats[] {
      return [...stats.keys()].map(name => this.get(name));
    },
    isCircuitOpen(toolName: string): boolean {
      return ensure(toolName).circuitOpen;
    },
    reset(toolName: string): void {
      stats.delete(toolName);
    },
  };
}

// ─── Test harness ────────────────────────────────────────────

export interface ToolTestCase {
  name: string;
  input: ToolInput;
  expectedContent?: string;
  expectError?: boolean;
}

export interface ToolTestResult {
  case: string;
  passed: boolean;
  actual?: ToolOutput;
  error?: string;
  durationMs: number;
}

export async function runToolTests(
  tool: Tool,
  ctx: ExecutionContext,
  cases: ToolTestCase[],
): Promise<ToolTestResult[]> {
  const results: ToolTestResult[] = [];
  for (const tc of cases) {
    const start = Date.now();
    try {
      const output = await tool.invoke(ctx, tc.input);
      const passed = tc.expectError
        ? !!output.isError
        : tc.expectedContent
          ? output.content.includes(tc.expectedContent)
          : !output.isError;
      results.push({ case: tc.name, passed, actual: output, durationMs: Date.now() - start });
    } catch (err) {
      results.push({
        case: tc.name,
        passed: !!tc.expectError,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
  }
  return results;
}

// ─── Extended registry ───────────────────────────────────────

export interface ExtendedToolRegistry extends ToolRegistry {
  registerWithDescriptor(tool: Tool, descriptor: ExtendedToolDescriptor): void;
  getDescriptor(name: string): ExtendedToolDescriptor | undefined;
  listDescriptors(): ExtendedToolDescriptor[];
  listByRisk(risk: ToolRiskLevel): Tool[];
  healthTracker: ToolHealthTracker;
}

export function createExtendedToolRegistry(opts?: { healthOpts?: { errorThreshold?: number; windowMs?: number } }): ExtendedToolRegistry {
  const base = weaveToolRegistry();
  const descriptors = new Map<string, ExtendedToolDescriptor>();
  const healthTracker = createHealthTracker(opts?.healthOpts);

  return {
    ...base,
    healthTracker,

    register(tool: Tool): void {
      base.register(tool);
    },

    registerWithDescriptor(tool: Tool, descriptor: ExtendedToolDescriptor): void {
      base.register(tool);
      descriptors.set(tool.schema.name, descriptor);
    },

    unregister(name: string): void {
      base.unregister(name);
      descriptors.delete(name);
    },

    get(name: string): Tool | undefined {
      return base.get(name);
    },

    list(): Tool[] {
      return base.list();
    },

    listByTag(tag: string): Tool[] {
      return base.listByTag(tag);
    },

    listByRisk(risk: ToolRiskLevel): Tool[] {
      return base.list().filter(t => {
        const d = descriptors.get(t.schema.name);
        return d?.riskLevel === risk;
      });
    },

    getDescriptor(name: string): ExtendedToolDescriptor | undefined {
      return descriptors.get(name);
    },

    listDescriptors(): ExtendedToolDescriptor[] {
      return [...descriptors.values()];
    },

    toDefinitions() {
      return base.toDefinitions();
    },
  };
}

// ─── MCP bridge helper ───────────────────────────────────────

/**
 * Converts all tools in a ToolRegistry into MCP tool definition objects
 * suitable for registration with an MCPServer.
 */
export function toolsToMCPDefinitions(registry: ToolRegistry): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return registry.list().map(t => ({
    name: t.schema.name,
    description: t.schema.description,
    inputSchema: t.schema.parameters as Record<string, unknown>,
  }));
}

/**
 * Creates an MCP tool handler function that routes MCP calls through
 * the given ToolRegistry, applying health tracking.
 */
export function createMCPToolHandler(
  registry: ToolRegistry,
  healthTracker?: ToolHealthTracker,
): (ctx: ExecutionContext, args: Record<string, unknown>, toolName: string) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  return async (ctx, args, toolName) => {
    const tool = registry.get(toolName);
    if (!tool) {
      return { content: [{ type: 'text' as const, text: `Tool not found: ${toolName}` }], isError: true };
    }
    const start = Date.now();
    try {
      const output = await tool.invoke(ctx, { name: toolName, arguments: args });
      healthTracker?.record(toolName, Date.now() - start, !!output.isError);
      return { content: [{ type: 'text' as const, text: output.content }], isError: output.isError };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      healthTracker?.record(toolName, Date.now() - start, true);
      return { content: [{ type: 'text' as const, text: msg }], isError: true };
    }
  };
}
