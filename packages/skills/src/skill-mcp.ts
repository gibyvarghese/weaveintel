// SPDX-License-Identifier: MIT
/**
 * MCP bridge — let other AI tools discover and pull your skills over the Model Context Protocol.
 *
 * MCP is the common wire other agents (Claude Desktop, Cursor, Codex, …) already speak. Skills and MCP
 * are complementary: MCP tools say *what* an agent can do; a skill says *how* to do a whole job. The
 * modern pattern is **discovery on demand** — instead of dumping every skill into the model's context,
 * an agent *searches* for a relevant skill and *pulls* only that one. This bridge exposes exactly that:
 *
 *   • `list_skills`  — the short cards (id, name, one-line summary) for everything on offer,
 *   • `search_skills` — find the few skills that match a request (uses your retriever),
 *   • `get_skill`    — fetch one skill's full `SKILL.md` to actually use it.
 *
 * It returns handlers shaped exactly like `@weaveintel/mcp-server`'s `McpHandlers`, so you hand them
 * straight to that package's `handleMcpMessage` / server transport — no glue code, no new protocol.
 */

import { lexicalSkillRetriever, type SkillRetriever } from './retrieval.js';
import { exportSkillMd, skillDefinitionToSkillMd } from './skill-interop.js';
import { isSkillUsable } from './skill-evaluation.js';
import type { SkillPackage } from './skill-package.js';
import type { SkillDefinition } from './types.js';

// Structurally identical to @weaveintel/mcp-server's types, so this bridge is a drop-in `McpHandlers`.
export interface SkillMcpTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface SkillMcpToolResult { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
export interface SkillMcpHandlers {
  serverInfo: { name: string; version: string; instructions?: string };
  listTools(): SkillMcpTool[];
  callTool(name: string, args: Record<string, unknown>): Promise<SkillMcpToolResult>;
}

export interface SkillMcpBridgeOptions {
  /** The skills to expose — an array or a (sync/async) getter, so the catalog can change over time. */
  readonly skills: readonly SkillDefinition[] | (() => readonly SkillDefinition[] | Promise<readonly SkillDefinition[]>);
  /** Optional: return the full package for a skill id, so `get_skill` can serve bundled scripts/references. */
  readonly packageFor?: (id: string) => SkillPackage | undefined | Promise<SkillPackage | undefined>;
  /** How `search_skills` finds matches. Defaults to the built-in lexical retriever (no setup). */
  readonly retriever?: SkillRetriever;
  readonly serverInfo?: { name?: string; version?: string; instructions?: string };
  /** Cap on how many results `search_skills` / `list_skills` return. Default 20. */
  readonly maxResults?: number;
}

const text = (t: string, isError = false): SkillMcpToolResult => ({ content: [{ type: 'text', text: t }], isError });

function card(skill: SkillDefinition): string {
  return `- ${skill.id}: ${skill.summary}${skill.whenToUse ? ` (use when: ${skill.whenToUse})` : ''}`;
}

/**
 * Build MCP handlers that expose a skill catalog for discovery and retrieval. Only *usable* skills
 * (active or deprecated — never retired/disabled) are shown.
 */
export function createSkillMcpBridge(opts: SkillMcpBridgeOptions): SkillMcpHandlers {
  const retriever = opts.retriever ?? lexicalSkillRetriever();
  const maxResults = opts.maxResults ?? 20;
  const resolve = async (): Promise<SkillDefinition[]> => {
    const all = typeof opts.skills === 'function' ? await opts.skills() : opts.skills;
    return all.filter(isSkillUsable);
  };

  const tools: SkillMcpTool[] = [
    { name: 'list_skills', description: 'List the available skills as short cards (id, name, summary).', inputSchema: { type: 'object', properties: {} } },
    { name: 'search_skills', description: 'Find the skills most relevant to a request, so you can pull only what you need.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What you are trying to do.' }, limit: { type: 'number' } }, required: ['query'] } },
    { name: 'get_skill', description: "Fetch one skill's full SKILL.md (instructions and metadata) by its id.", inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  ];

  return {
    serverInfo: { name: opts.serverInfo?.name ?? 'weaveintel-skills', version: opts.serverInfo?.version ?? '0.1.0', instructions: opts.serverInfo?.instructions ?? 'Search for a skill, then get it to follow its instructions.' },
    listTools: () => tools,
    async callTool(name, args) {
      const skills = await resolve();
      switch (name) {
        case 'list_skills':
          return text(skills.slice(0, maxResults).map(card).join('\n') || '(no skills available)');

        case 'search_skills': {
          const query = String(args['query'] ?? '').trim();
          if (!query) return text('search_skills requires a "query".', true);
          const limit = Math.min(Number(args['limit']) || 5, maxResults);
          const candidates = await retriever.retrieve(query, skills, { limit });
          if (!candidates.length) return text(`No skills matched "${query}".`);
          return text(candidates.slice(0, limit).map((c) => card(c.skill)).join('\n'));
        }

        case 'get_skill': {
          const id = String(args['id'] ?? '');
          const skill = skills.find((s) => s.id === id);
          if (!skill) return text(`No skill with id "${id}".`, true);
          const pkg = await opts.packageFor?.(id);
          return text(pkg ? exportSkillMd(pkg) : skillDefinitionToSkillMd(skill));
        }

        default:
          return text(`Unknown tool "${name}".`, true);
      }
    },
  };
}
