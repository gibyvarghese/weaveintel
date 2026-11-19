import { createHardenedFetch } from '@weaveintel/core';
import type { OutboundUrlPolicy } from '@weaveintel/core';

const client = createHardenedFetch({ errorTag: 'external.mcp-tool' });

export function mcpFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  policy?: Omit<OutboundUrlPolicy, 'errorTag' | 'allowCrossOriginRedirects'>,
): Promise<Response> {
  return client.fetch(url, init, {
    timeoutMs,
    policy: { ...policy, allowCrossOriginRedirects: false },
  });
}
