import type { AccountSessionProvider } from '../types.js';
import type { ExecutionContext, MCPToolCallResponse } from '@weaveintel/core';

export async function sessionHasTool(
  session: Awaited<ReturnType<AccountSessionProvider['getSession']>>,
  toolName: string,
): Promise<boolean> {
  if (session.discoverCapabilities) {
    const namespacePrefix = toolName.includes('.') ? toolName.slice(0, toolName.indexOf('.')) : undefined;
    let cursor: string | undefined;

    do {
      const page = await session.discoverCapabilities({
        cursor,
        namespacePrefix,
        limit: 100,
      });
      if (page.items.some((item) => item.kind === 'tool' && item.name === toolName)) {
        return true;
      }
      cursor = page.nextCursor;
    } while (cursor);

    return false;
  }

  const tools = await session.listTools();
  return tools.some((tool) => tool.name === toolName);
}

export async function executeSessionTool(
  session: Awaited<ReturnType<AccountSessionProvider['getSession']>>,
  ctx: ExecutionContext,
  request: { name: string; arguments: Record<string, unknown> },
): Promise<MCPToolCallResponse> {
  if (session.streamToolCall) {
    let finalOutput: MCPToolCallResponse | undefined;
    for await (const event of session.streamToolCall(ctx, request)) {
      if (event.output) {
        finalOutput = event.output;
      }
      if (event.type === 'final_output' && event.output) {
        return event.output;
      }
    }
    if (finalOutput) {
      return finalOutput;
    }
  }

  return session.callTool(ctx, request);
}
