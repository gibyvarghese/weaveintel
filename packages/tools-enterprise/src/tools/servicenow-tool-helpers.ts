import type { Tool, ToolInput, ToolOutput, ExecutionContext } from '@weaveintel/core';

/* ---- helpers (same as mcp.ts) ---- */
export type ToolDef = { name: string; desc: string; params: Record<string, unknown>; fn: (ctx: ExecutionContext, input: ToolInput) => Promise<ToolOutput> };

/** See normalizeArgs in mcp.ts for full doc.  Auto-wraps flat LLM args into the expected nested object param. */
export function normalizeArgs(params: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const props = (params as { properties?: Record<string, { type?: string }> }).properties;
  if (!props) return args;
  const objectKeys = Object.keys(props).filter(k => props[k]?.type === 'object');
  if (objectKeys.length !== 1) return args;
  const objKey = objectKeys[0]!;
  const existing = args[objKey];
  if (existing != null && typeof existing === 'object' && !Array.isArray(existing)) return args;
  const scalarKeys = new Set(Object.keys(props).filter(k => k !== objKey));
  const dataObj: Record<string, unknown> = {};
  const newArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (scalarKeys.has(k)) newArgs[k] = v;
    else if (k !== objKey) dataObj[k] = v;
  }
  if (Object.keys(dataObj).length > 0) newArgs[objKey] = dataObj;
  return newArgs;
}

export function bt(d: ToolDef): Tool { const safeName = d.name.replace(/\./g, '_'); return { schema: { name: safeName, description: d.desc, parameters: d.params },
  invoke: (ctx, inp) => d.fn(ctx, { ...inp, arguments: normalizeArgs(d.params, inp.arguments) }) }; }
export function ok(data: unknown): ToolOutput { return { content: JSON.stringify(data) }; }
export function s(inp: ToolInput, k: string): string { return String(inp.arguments[k]); }
export function n(inp: ToolInput, k: string, def?: number): number | undefined { const v = inp.arguments[k]; return v != null ? Number(v) : def; }
export function o(inp: ToolInput, k: string): Record<string, unknown> { return (inp.arguments[k] as Record<string, unknown>) ?? {}; }
export function b(inp: ToolInput, k: string): boolean { return Boolean(inp.arguments[k]); }
