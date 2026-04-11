/**
 * @weaveintel/geneweave — Built-in tools & registry
 *
 * Ships a set of useful built-in tools that agents can use, plus
 * a helper to create a ToolRegistry from selected tool names.
 */

import type { Tool, ToolRegistry } from '@weaveintel/core';
import { weaveTool, weaveToolRegistry } from '@weaveintel/core';

// ─── Built-in tools ──────────────────────────────────────────

const calculatorTool = weaveTool({
  name: 'calculator',
  description: 'Evaluate a mathematical expression. Supports +, -, *, /, **, %, parentheses.',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'The math expression to evaluate' },
    },
    required: ['expression'],
  },
  execute: async (args: { expression: string }) => {
    try {
      const sanitized = args.expression.replace(/[^0-9+\-*/.()%\s^]/g, '');
      if (!sanitized.trim() || sanitized.length > 200) return { content: 'Invalid expression', isError: true };
      const result = new Function(`"use strict"; return (${sanitized.replace(/\^/g, '**')})`)();
      return String(result);
    } catch (e) {
      return { content: `Error: ${(e as Error).message}`, isError: true };
    }
  },
  tags: ['math', 'utility'],
});

const datetimeTool = weaveTool({
  name: 'datetime',
  description: 'Get the current date and time in various formats.',
  parameters: {
    type: 'object',
    properties: {
      format: { type: 'string', description: 'Output format: "iso", "unix", "human", "date", "time"' },
      timezone: { type: 'string', description: 'IANA timezone (e.g., "America/New_York")' },
    },
  },
  execute: async (args: { format?: string; timezone?: string }) => {
    const now = new Date();
    switch (args.format || 'iso') {
      case 'unix': return String(Math.floor(now.getTime() / 1000));
      case 'human': return now.toLocaleString('en-US', { timeZone: args.timezone });
      case 'date': return now.toLocaleDateString('en-US', { timeZone: args.timezone });
      case 'time': return now.toLocaleTimeString('en-US', { timeZone: args.timezone });
      default: return now.toISOString();
    }
  },
  tags: ['utility', 'datetime'],
});

const webSearchTool = weaveTool({
  name: 'web_search',
  description: 'Search the web for information (placeholder — replace with real search API in production).',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
  execute: async (args: { query: string }) => {
    return `[Web search for "${args.query}" — integrate a real search API for production use]`;
  },
  tags: ['search', 'external'],
});

const jsonFormatterTool = weaveTool({
  name: 'json_format',
  description: 'Parse and pretty-print a JSON string.',
  parameters: {
    type: 'object',
    properties: {
      json: { type: 'string', description: 'The JSON string to format' },
      indent: { type: 'number', description: 'Indentation spaces (default: 2)' },
    },
    required: ['json'],
  },
  execute: async (args: { json: string; indent?: number }) => {
    try {
      const parsed = JSON.parse(args.json);
      return JSON.stringify(parsed, null, args.indent ?? 2);
    } catch (e) {
      return { content: `Invalid JSON: ${(e as Error).message}`, isError: true };
    }
  },
  tags: ['utility', 'formatting'],
});

const textAnalysisTool = weaveTool({
  name: 'text_analysis',
  description: 'Analyze text: word count, character count, sentence count, reading time.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to analyze' },
    },
    required: ['text'],
  },
  execute: async (args: { text: string }) => {
    const words = args.text.split(/\s+/).filter(Boolean).length;
    const chars = args.text.length;
    const sentences = args.text.split(/[.!?]+/).filter(Boolean).length;
    const readingTime = Math.ceil(words / 200);
    return JSON.stringify({ words, characters: chars, sentences, readingTimeMinutes: readingTime }, null, 2);
  },
  tags: ['utility', 'text'],
});

// ─── Tool catalog ────────────────────────────────────────────

export const BUILTIN_TOOLS: Record<string, Tool> = {
  calculator: calculatorTool,
  datetime: datetimeTool,
  web_search: webSearchTool,
  json_format: jsonFormatterTool,
  text_analysis: textAnalysisTool,
};

/**
 * Create a ToolRegistry pre-loaded with the selected built-in tools
 * plus any custom tools provided.
 */
export function createToolRegistry(toolNames: string[], customTools?: Tool[]): ToolRegistry {
  const registry = weaveToolRegistry();
  for (const name of toolNames) {
    const tool = BUILTIN_TOOLS[name];
    if (tool) registry.register(tool);
  }
  if (customTools) {
    for (const tool of customTools) {
      registry.register(tool);
    }
  }
  return registry;
}

/** Info about all available built-in tools */
export function getAvailableTools(): Array<{ name: string; description: string; tags: string[] }> {
  return Object.values(BUILTIN_TOOLS).map((t) => ({
    name: t.schema.name,
    description: t.schema.description,
    tags: [...(t.schema.tags ?? [])],
  }));
}
