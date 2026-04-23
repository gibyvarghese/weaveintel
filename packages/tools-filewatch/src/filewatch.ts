/**
 * @weaveintel/tools-filewatch — Local filesystem MCP server
 * Optional sandbox root via ctx.metadata.filewatchBasePath.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';

export interface FilewatchCredentials { basePath?: string; }

export interface FilewatchEntry { path: string; isDirectory: boolean; size: number; mtimeMs: number; }

export interface FilewatchAdapter {
  list(creds: FilewatchCredentials, relPath: string): Promise<FilewatchEntry[]>;
  read(creds: FilewatchCredentials, relPath: string, encoding?: BufferEncoding): Promise<string>;
  write(creds: FilewatchCredentials, relPath: string, content: string, encoding?: BufferEncoding): Promise<{ writtenBytes: number }>;
  subscribe(creds: FilewatchCredentials, relPath: string): Promise<{ subscribed: true; path: string }>;
}

function extractCredentials(ctx: ExecutionContext): FilewatchCredentials {
  return { basePath: ctx.metadata?.['filewatchBasePath'] as string | undefined };
}

function resolvePath(basePath: string | undefined, relPath: string): string {
  const base = basePath ? path.resolve(basePath) : process.cwd();
  const full = path.resolve(base, relPath || '.');
  if (!full.startsWith(base)) throw new Error('Path escapes configured filewatch base path');
  return full;
}

export const liveFilewatchAdapter: FilewatchAdapter = {
  async list(creds, relPath) {
    const dir = resolvePath(creds.basePath, relPath || '.');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: FilewatchEntry[] = [];
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      const st = await fs.stat(p);
      out.push({ path: p, isDirectory: ent.isDirectory(), size: st.size, mtimeMs: st.mtimeMs });
    }
    return out;
  },
  async read(creds, relPath, encoding = 'utf8') {
    const file = resolvePath(creds.basePath, relPath);
    return fs.readFile(file, { encoding });
  },
  async write(creds, relPath, content, encoding = 'utf8') {
    const file = resolvePath(creds.basePath, relPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { encoding });
    return { writtenBytes: Buffer.byteLength(content, encoding) };
  },
  async subscribe(creds, relPath) {
    const p = resolvePath(creds.basePath, relPath || '.');
    return { subscribed: true, path: p };
  },
};

export interface FilewatchMCPServerOptions { adapter?: FilewatchAdapter; }

export function createFilewatchMCPServer(opts: FilewatchMCPServerOptions = {}) {
  const adapter = opts.adapter ?? liveFilewatchAdapter;
  const server = weaveMCPServer(
    { name: 'filewatch', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  describeT('filewatch.list', 'List files and directories', 'read-only');
  describeT('filewatch.read', 'Read file content', 'read-only');
  describeT('filewatch.write', 'Write file content', 'write');
  describeT('filewatch.subscribe', 'Subscribe to file path changes', 'read-only');

  server.addTool({ name: 'filewatch.list', description: 'List directory entries.', inputSchema: { type: 'object', properties: { path: { type: 'string', default: '.' } } } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    const items = await adapter.list(creds, String(args['path'] ?? '.'));
    return { content: [{ type: 'text', text: JSON.stringify(items) }] };
  });

  server.addTool({ name: 'filewatch.read', description: 'Read a text file.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, encoding: { type: 'string', default: 'utf8' } }, required: ['path'] } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    const text = await adapter.read(creds, String(args['path']), (args['encoding'] as BufferEncoding | undefined) ?? 'utf8');
    return { content: [{ type: 'text', text }] };
  });

  server.addTool({ name: 'filewatch.write', description: 'Write text to a file (creates parent dirs).', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string', default: 'utf8' } }, required: ['path', 'content'] } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    const result = await adapter.write(creds, String(args['path']), String(args['content']), (args['encoding'] as BufferEncoding | undefined) ?? 'utf8');
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.addTool({ name: 'filewatch.subscribe', description: 'Subscribe to path changes.', inputSchema: { type: 'object', properties: { path: { type: 'string', default: '.' } } } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    const result = await adapter.subscribe(creds, String(args['path'] ?? '.'));
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  return server;
}
