import type { MCPToolCallResponse } from '@weaveintel/core';

export function nowIso(): string {
  return new Date().toISOString();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function normalizeMCPContent(content: unknown): MCPToolCallResponse['content'] {
  if (!Array.isArray(content)) return [];

  return content.flatMap<MCPToolCallResponse['content'][number]>((item) => {
    const value = item as Record<string, unknown>;
    const type = String(value['type'] ?? '');
    if (type === 'text') {
      return [{ type: 'text', text: String(value['text'] ?? '') }];
    }
    if (type === 'image') {
      return [{ type: 'image', data: String(value['data'] ?? ''), mimeType: String(value['mimeType'] ?? '') }];
    }
    if (type === 'resource') {
      const resource = (value['resource'] ?? {}) as Record<string, unknown>;
      return [{
        type: 'resource',
        uri: String(resource['uri'] ?? ''),
        text: typeof resource['text'] === 'string' ? resource['text'] : undefined,
      }];
    }
    if (type === 'resource_link') {
      return [{
        type: 'resource',
        uri: String(value['uri'] ?? ''),
        text: typeof value['name'] === 'string' ? value['name'] : undefined,
      }];
    }
    if (type === 'audio') {
      return [{ type: 'text', text: `[audio:${String(value['mimeType'] ?? 'unknown')}]` }];
    }
    return [{ type: 'text', text: JSON.stringify(value) }];
  });
}

export function parsePathValue(root: unknown, dottedPath?: string): unknown {
  if (!dottedPath) return root;
  const segments = dottedPath.split('.').filter(Boolean);
  let current: unknown = root;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function applyMergedInput(
  baseArgs: Record<string, unknown> | undefined,
  mergeKey: string | undefined,
  mergedInput: unknown,
): Record<string, unknown> {
  const args = { ...(baseArgs ?? {}) };
  if (mergeKey) {
    args[mergeKey] = mergedInput;
  }
  return args;
}
