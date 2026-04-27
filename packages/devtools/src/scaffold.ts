/**
 * @weaveintel/devtools — Project scaffolding
 *
 * Generate boilerplate project structures for new weaveIntel applications.
 */

export type TemplateType =
  | 'basic-agent'
  | 'tool-calling-agent'
  | 'rag-pipeline'
  | 'workflow'
  | 'multi-agent'
  | 'mcp-server'
  | 'full-stack';

export interface ScaffoldFile {
  path: string;
  content: string;
}

export interface ScaffoldTemplate {
  name: string;
  type: TemplateType;
  description: string;
  files: ScaffoldFile[];
  dependencies: string[];
  devDependencies: string[];
}

export interface ScaffoldOptions {
  projectName: string;
  template: TemplateType;
  description?: string;
  includeTests?: boolean;
  includeDocker?: boolean;
}

/**
 * Generate a project scaffold from the selected template.
 */
export function scaffold(opts: ScaffoldOptions): ScaffoldTemplate {
  const tpl = TEMPLATES[opts.template];
  if (!tpl) {
    throw new Error(`Unknown template: ${opts.template}`);
  }

  const files = tpl.files.map((f) => ({
    path: f.path,
    content: f.content
      .replace(/{{PROJECT_NAME}}/g, opts.projectName)
      .replace(/{{DESCRIPTION}}/g, opts.description ?? tpl.description),
  }));

  if (opts.includeTests !== false) {
    files.push({
      path: 'src/__tests__/index.test.ts',
      content: `import { describe, it, expect } from 'vitest';

describe('${opts.projectName}', () => {
  it('should be defined', () => {
    expect(true).toBe(true);
  });
});
`,
    });
  }

  if (opts.includeDocker) {
    files.push({
      path: 'Dockerfile',
      content: `FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
`,
    });
  }

  return {
    name: opts.projectName,
    type: opts.template,
    description: opts.description ?? tpl.description,
    files,
    dependencies: [...tpl.dependencies],
    devDependencies: [...tpl.devDependencies],
  };
}

/**
 * List all available scaffold templates.
 */
export function listTemplates(): Array<{ type: TemplateType; description: string }> {
  return Object.entries(TEMPLATES).map(([type, tpl]) => ({
    type: type as TemplateType,
    description: tpl.description,
  }));
}

// ─── Built-in templates ──────────────────────────────────────

interface BuiltInTemplate {
  description: string;
  files: ScaffoldFile[];
  dependencies: string[];
  devDependencies: string[];
}

const TEMPLATES: Record<TemplateType, BuiltInTemplate> = {
  'basic-agent': {
    description: 'Simple agent with a model and system prompt',
    files: [
      {
        path: 'package.json',
        content: `{
  "name": "{{PROJECT_NAME}}",
  "type": "module",
  "scripts": { "build": "tsc -b", "start": "node dist/index.js" }
}`,
      },
      {
        path: 'src/index.ts',
        content: `import { weaveContext } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';

const agent = weaveAgent({ name: '{{PROJECT_NAME}}', model: undefined as any, systemPrompt: '{{DESCRIPTION}}' });
const ctx = weaveContext({ userId: 'dev' });
// const result = await agent.run(ctx, { messages: [{ role: 'user', content: 'Hello' }] });
console.log('Agent ready:', agent.config.name);
`,
      },
    ],
    dependencies: ['@weaveintel/core', '@weaveintel/agents'],
    devDependencies: ['typescript'],
  },

  'tool-calling-agent': {
    description: 'Agent with tool registry and tool-calling loop',
    files: [
      {
        path: 'package.json',
        content: `{
  "name": "{{PROJECT_NAME}}",
  "type": "module",
  "scripts": { "build": "tsc -b", "start": "node dist/index.js" }
}`,
      },
      {
        path: 'src/index.ts',
        content: `import { weaveContext, weaveToolRegistry, weaveTool } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';

const tools = weaveToolRegistry();
tools.register(weaveTool({ name: 'greet', description: 'Greet a user', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, execute: async (_ctx, input) => ({ result: 'Hello ' + input.name }) }));

const agent = weaveAgent({ name: '{{PROJECT_NAME}}', model: undefined as any, tools, systemPrompt: '{{DESCRIPTION}}' });
console.log('Tool-calling agent ready:', agent.config.name);
`,
      },
    ],
    dependencies: ['@weaveintel/core', '@weaveintel/agents'],
    devDependencies: ['typescript'],
  },

  'rag-pipeline': {
    description: 'Retrieval-Augmented Generation pipeline with vector store',
    files: [
      {
        path: 'package.json',
        content: `{
  "name": "{{PROJECT_NAME}}",
  "type": "module",
  "scripts": { "build": "tsc -b", "start": "node dist/index.js" }
}`,
      },
      {
        path: 'src/index.ts',
        content: `import { weaveContext } from '@weaveintel/core';
// RAG pipeline scaffold
console.log('RAG pipeline scaffold: {{PROJECT_NAME}}');
`,
      },
    ],
    dependencies: ['@weaveintel/core', '@weaveintel/retrieval'],
    devDependencies: ['typescript'],
  },

  'workflow': {
    description: 'Multi-step workflow with branching and approvals',
    files: [
      {
        path: 'package.json',
        content: `{
  "name": "{{PROJECT_NAME}}",
  "type": "module",
  "scripts": { "build": "tsc -b", "start": "node dist/index.js" }
}`,
      },
      {
        path: 'src/index.ts',
        content: `import { weaveContext } from '@weaveintel/core';
// Workflow scaffold
console.log('Workflow scaffold: {{PROJECT_NAME}}');
`,
      },
    ],
    dependencies: ['@weaveintel/core', '@weaveintel/workflows'],
    devDependencies: ['typescript'],
  },

  'multi-agent': {
    description: 'Hierarchical multi-agent system with supervisor',
    files: [
      {
        path: 'package.json',
        content: `{
  "name": "{{PROJECT_NAME}}",
  "type": "module",
  "scripts": { "build": "tsc -b", "start": "node dist/index.js" }
}`,
      },
      {
        path: 'src/index.ts',
        content: `import { weaveContext } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
// Multi-agent scaffold (use weaveAgent with the \`workers\` option for supervisor mode)
console.log('Multi-agent scaffold: {{PROJECT_NAME}}');
`,
      },
    ],
    dependencies: ['@weaveintel/core', '@weaveintel/agents'],
    devDependencies: ['typescript'],
  },

  'mcp-server': {
    description: 'MCP (Model Context Protocol) server with tools and resources',
    files: [
      {
        path: 'package.json',
        content: `{
  "name": "{{PROJECT_NAME}}",
  "type": "module",
  "scripts": { "build": "tsc -b", "start": "node dist/index.js" }
}`,
      },
      {
        path: 'src/index.ts',
        content: `// MCP Server scaffold
console.log('MCP Server scaffold: {{PROJECT_NAME}}');
`,
      },
    ],
    dependencies: ['@weaveintel/core', '@weaveintel/mcp-server'],
    devDependencies: ['typescript'],
  },

  'full-stack': {
    description: 'Full-stack application with geneWeave chatbot UI',
    files: [
      {
        path: 'package.json',
        content: `{
  "name": "{{PROJECT_NAME}}",
  "type": "module",
  "scripts": { "build": "tsc -b", "start": "node dist/index.js" }
}`,
      },
      {
        path: 'src/index.ts',
        content: `// Full-stack scaffold based on geneWeave
console.log('Full-stack scaffold: {{PROJECT_NAME}}');
`,
      },
    ],
    dependencies: ['@weaveintel/core', '@weaveintel/agents', '@weaveintel/geneweave'],
    devDependencies: ['typescript'],
  },
};
