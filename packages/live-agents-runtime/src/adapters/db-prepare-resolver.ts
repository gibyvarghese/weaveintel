/**
 * Phase 2 (DB-driven capability plan) — declarative `prepare()` recipes.
 *
 * Replaces hand-written `prepare()` closures inside agent handlers with a
 * small JSON recipe stored on `live_agents.prepare_config_json`. The
 * runtime parses the recipe and synthesises a `prepare()` function with
 * the **same shape and contract** as the one a handler author would write
 * by hand.
 *
 * --- Boundary ---
 *
 * - Pure runtime: this file knows nothing about SQLite, prompt records, or
 *   any specific DB schema. Apps inject a `PrepareResolutionDeps` bundle
 *   containing `resolvePromptText(promptKey, variables)`.
 * - Caller-supplied `prepare()` (passed through `weaveLiveAgent`) ALWAYS
 *   wins. The recipe path is the default when no custom prepare exists.
 *
 * --- Recipe schema (JSON) ---
 *
 *   {
 *     "systemPrompt": "literal text"
 *                  | { "promptKey": "live-agent.observer", "variables": { "x": "y" } },
 *     "tools": "$auto",
 *     "userGoal": "literal"
 *               | { "from": "inbound.body" | "inbound.subject" | "inbound" }
 *               | { "template": "Subject: {{subject}}\n\n{{body}}" },
 *     "memory": { "windowMessages": 20, "summarizer": "compression.daily" }
 *   }
 *
 * `memory` is captured for forward compatibility but not yet enforced by
 * the ReAct loop — a Phase 6+ concern. The recipe parses and surfaces it
 * on the returned definition so downstream code can read it.
 */

import { weaveToolRegistry, type ToolRegistry } from '@weaveintel/core';

// ─── Public types ────────────────────────────────────────────

export type PrepareSystemPromptRecipe =
  | string
  | { promptKey: string; variables?: Record<string, unknown> };

export type PrepareUserGoalRecipe =
  | string
  | { from: 'inbound.body' | 'inbound.subject' | 'inbound' }
  | { template: string };

export interface PrepareMemoryRecipe {
  windowMessages?: number;
  summarizer?: string;
}

/**
 * Tools recipe.
 *
 * - `'$auto'` (legacy shorthand) — equivalent to `{ auto: true }`. The
 *   handler-context tool registry is forwarded as-is.
 * - Object form — fine-grained control. `auto: true` forwards the
 *   ctx.tools registry; `traceTools: '$auto'` additionally injects the
 *   lazy trace-retrieval tools (Phase 9) when a `traceToolsFactory` dep
 *   is wired and an active run is available.
 */
export type PrepareToolsRecipe =
  | '$auto'
  | { auto?: boolean; traceTools?: '$auto' };

export interface PrepareConfig {
  systemPrompt?: PrepareSystemPromptRecipe;
  tools?: PrepareToolsRecipe;
  userGoal?: PrepareUserGoalRecipe;
  memory?: PrepareMemoryRecipe;
}

/** Minimal inbound shape the recipe knows how to read from. Mirrors the
 *  `AgenticPrepareInput.inbound` shape from `@weaveintel/live-agents`. */
export interface PrepareInbound {
  subject: string;
  body: string;
}

export interface PrepareInput {
  inbound: PrepareInbound | null;
}

/** Output mirrors `AgenticPreparation` from `@weaveintel/live-agents`. */
export interface PrepareOutput {
  systemPrompt: string;
  userGoal: string;
  tools?: ToolRegistry;
}

/** Dependencies the recipe runtime needs to resolve external references.
 *  Apps inject these at handler-context build time. */
export interface PrepareResolutionDeps {
  /** Resolve a prompt-key reference into the final system-prompt text.
   *  Required ONLY when the recipe uses `systemPrompt: { promptKey }`. */
  resolvePromptText?: (
    promptKey: string,
    variables?: Record<string, unknown>,
  ) => Promise<string>;
  /** Optional fallback text when no `systemPrompt` is present in the
   *  recipe AND no inline `fallbackPrompt` is supplied. Defaults to a
   *  generic "You are <name>." at handler-build time. */
  defaultSystemPrompt?: string;
  /**
   * Build the lazy trace-retrieval tool registry for THE CURRENT run
   * (Phase 9). Required ONLY when the recipe sets
   * `tools: { traceTools: '$auto' }`. Returning `null` is graceful and
   * means "no active run, omit trace tools this tick". Errors are
   * swallowed and treated as null — trace tools are never load-bearing.
   */
  traceToolsFactory?: (ctx: {
    runId?: string;
    agentId?: string;
    meshId?: string;
  }) => Promise<ToolRegistry | null> | ToolRegistry | null;
}

/** What `dbPrepareFromConfig` returns. */
export interface PreparedRecipe {
  /** The synthesised prepare function. */
  prepare: (input: PrepareInput) => Promise<PrepareOutput>;
  /** The parsed recipe (echoed back for introspection / tests). */
  config: PrepareConfig;
}

// ─── Parsing ──────────────────────────────────────────────────

/**
 * Parse a raw `prepare_config_json` string into a typed `PrepareConfig`.
 *
 * Returns `null` for null/empty input so callers can branch cleanly.
 * Throws a descriptive error for malformed JSON or invalid shapes — these
 * are operator misconfigurations and should surface loudly during tick
 * dispatch, not silently degrade.
 */
export function parsePrepareConfig(raw: string | null | undefined): PrepareConfig | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '{}') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `parsePrepareConfig: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('parsePrepareConfig: recipe must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const out: PrepareConfig = {};

  if ('systemPrompt' in obj) {
    const sp = obj['systemPrompt'];
    if (typeof sp === 'string') {
      out.systemPrompt = sp;
    } else if (sp && typeof sp === 'object' && typeof (sp as { promptKey?: unknown }).promptKey === 'string') {
      const ref = sp as { promptKey: string; variables?: Record<string, unknown> };
      out.systemPrompt = ref.variables
        ? { promptKey: ref.promptKey, variables: ref.variables }
        : { promptKey: ref.promptKey };
    } else {
      throw new Error('parsePrepareConfig: systemPrompt must be string or { promptKey, variables? }');
    }
  }

  if ('tools' in obj) {
    const t = obj['tools'];
    if (t === '$auto') {
      out.tools = '$auto';
    } else if (t && typeof t === 'object' && !Array.isArray(t)) {
      const tt = t as Record<string, unknown>;
      const toolsOut: { auto?: boolean; traceTools?: '$auto' } = {};
      for (const k of Object.keys(tt)) {
        if (k !== 'auto' && k !== 'traceTools') {
          throw new Error(`parsePrepareConfig: unknown tools key "${k}" (expected auto|traceTools)`);
        }
      }
      if ('auto' in tt) {
        if (typeof tt['auto'] !== 'boolean') {
          throw new Error('parsePrepareConfig: tools.auto must be boolean');
        }
        toolsOut.auto = tt['auto'];
      }
      if ('traceTools' in tt) {
        if (tt['traceTools'] !== '$auto') {
          throw new Error('parsePrepareConfig: tools.traceTools currently supports only "$auto"');
        }
        toolsOut.traceTools = '$auto';
      }
      out.tools = toolsOut;
    } else {
      throw new Error('parsePrepareConfig: tools must be "$auto" or { auto?, traceTools? }');
    }
  }

  if ('userGoal' in obj) {
    const ug = obj['userGoal'];
    if (typeof ug === 'string') {
      out.userGoal = ug;
    } else if (ug && typeof ug === 'object') {
      const u = ug as Record<string, unknown>;
      if (typeof u['from'] === 'string') {
        const from = u['from'];
        if (from !== 'inbound.body' && from !== 'inbound.subject' && from !== 'inbound') {
          throw new Error(`parsePrepareConfig: userGoal.from must be inbound.body|inbound.subject|inbound, got "${from}"`);
        }
        out.userGoal = { from };
      } else if (typeof u['template'] === 'string') {
        out.userGoal = { template: u['template'] };
      } else {
        throw new Error('parsePrepareConfig: userGoal object must have `from` or `template`');
      }
    } else {
      throw new Error('parsePrepareConfig: userGoal must be string or object');
    }
  }

  if ('memory' in obj) {
    const m = obj['memory'];
    if (m && typeof m === 'object') {
      const mm = m as Record<string, unknown>;
      const memOut: PrepareMemoryRecipe = {};
      if (typeof mm['windowMessages'] === 'number') memOut.windowMessages = mm['windowMessages'];
      if (typeof mm['summarizer'] === 'string') memOut.summarizer = mm['summarizer'];
      out.memory = memOut;
    }
  }

  return out;
}

// ─── Synthesis ────────────────────────────────────────────────

function interpolate(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

/**
 * Build a `prepare()` function from a parsed recipe + per-tick deps.
 *
 * Resolution rules:
 *   - `systemPrompt` literal: used as-is.
 *   - `systemPrompt: { promptKey }`: requires `deps.resolvePromptText`;
 *     throws at prepare-time if absent.
 *   - `systemPrompt` omitted: falls back to `deps.defaultSystemPrompt`,
 *     then to `''`. Caller (handler) is responsible for refusing empty.
 *   - `tools: "$auto"`: the supplied `ctx.tools` registry is forwarded.
 *   - `userGoal` literal: used as-is.
 *   - `userGoal: { from: "inbound.body" }`: pulls the inbound field.
 *   - `userGoal: { template }`: interpolates `{{subject}}` / `{{body}}`.
 *   - `userGoal` omitted: defaults to `inbound?.body ?? inbound?.subject ?? ''`.
 */
export function dbPrepareFromConfig(
  config: PrepareConfig,
  ctx: {
    tools?: ToolRegistry;
    runId?: string;
    agentId?: string;
    meshId?: string;
  } & PrepareResolutionDeps,
): PreparedRecipe {
  const prepare = async ({ inbound }: PrepareInput): Promise<PrepareOutput> => {
    // --- system prompt ---
    let systemPrompt = '';
    const sp = config.systemPrompt;
    if (typeof sp === 'string') {
      systemPrompt = sp;
    } else if (sp && typeof sp === 'object') {
      if (!ctx.resolvePromptText) {
        throw new Error(
          `dbPrepareFromConfig: systemPrompt.promptKey "${sp.promptKey}" supplied but no resolvePromptText dep was injected`,
        );
      }
      systemPrompt = await ctx.resolvePromptText(sp.promptKey, sp.variables);
    }
    if (!systemPrompt && ctx.defaultSystemPrompt) {
      systemPrompt = ctx.defaultSystemPrompt;
    }

    // --- user goal ---
    let userGoal = '';
    const ug = config.userGoal;
    if (typeof ug === 'string') {
      userGoal = ug;
    } else if (ug && typeof ug === 'object') {
      if ('from' in ug) {
        if (inbound) {
          if (ug.from === 'inbound.body') userGoal = inbound.body;
          else if (ug.from === 'inbound.subject') userGoal = inbound.subject;
          else userGoal = `Subject: ${inbound.subject}\n\n${inbound.body}`;
        }
      } else {
        userGoal = interpolate(ug.template, {
          subject: inbound?.subject ?? '',
          body: inbound?.body ?? '',
        });
      }
    } else {
      userGoal = inbound?.body ?? inbound?.subject ?? '';
    }

    // --- tools ---
    // Recipe shapes:
    //   undefined          → no tools forwarded
    //   '$auto'            → forward ctx.tools as-is
    //   { auto, traceTools } → build merged registry from selected sources
    const toolsRecipe = config.tools;
    let useTools: ToolRegistry | undefined;
    if (toolsRecipe === '$auto') {
      useTools = ctx.tools;
    } else if (toolsRecipe && typeof toolsRecipe === 'object') {
      const sources: ToolRegistry[] = [];
      if (toolsRecipe.auto && ctx.tools) sources.push(ctx.tools);
      if (toolsRecipe.traceTools === '$auto' && ctx.traceToolsFactory) {
        try {
          const traceReg = await ctx.traceToolsFactory({
            ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
            ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
            ...(ctx.meshId !== undefined ? { meshId: ctx.meshId } : {}),
          });
          if (traceReg) sources.push(traceReg);
        } catch {
          // Trace tools are never load-bearing — swallow factory errors.
        }
      }
      if (sources.length === 1) {
        useTools = sources[0];
      } else if (sources.length > 1) {
        const merged = weaveToolRegistry();
        for (const src of sources) {
          for (const t of src.list()) merged.register(t);
        }
        useTools = merged;
      }
    }

    return useTools
      ? { systemPrompt, userGoal, tools: useTools }
      : { systemPrompt, userGoal };
  };

  return { prepare, config };
}
