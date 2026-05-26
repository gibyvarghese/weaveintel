import type {
  AttentionAction,
  LiveAgentsObservability,
  Message,
} from '../types.js';
import type { ExecutionContext, MCPToolCallResponse } from '@weaveintel/core';
import { weaveResolveTracer } from '@weaveintel/core';

export function makeId(prefix: string, nowIso: string, suffix: string): string {
  return `${prefix}_${Date.parse(nowIso)}_${suffix}`;
}

export function messageRecipientToFields(action: Extract<AttentionAction, { type: 'DraftMessage' }>): {
  toType: Message['toType'];
  toId: string | null;
} {
  if (action.to.type === 'BROADCAST') {
    return { toType: 'BROADCAST', toId: null };
  }
  if (action.to.type === 'TEAM') {
    return { toType: 'TEAM', toId: action.to.id };
  }
  if (action.to.type === 'HUMAN') {
    return { toType: 'HUMAN', toId: action.to.id };
  }
  return { toType: 'AGENT', toId: action.to.id };
}

export async function withObservedSpan<T>(
  observability: LiveAgentsObservability | undefined,
  executionCtx: ExecutionContext | undefined,
  name: string,
  attributes: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = executionCtx ? weaveResolveTracer(executionCtx, observability?.tracer) : observability?.tracer;
  if (!tracer || !executionCtx) {
    return fn();
  }
  return tracer.withSpan(executionCtx, name, () => fn(), attributes);
}

export function responseSummary(response: MCPToolCallResponse): string {
  return response.content
    .map((part: MCPToolCallResponse['content'][number]) => {
      if (part.type === 'text') {
        return part.text;
      }
      if (part.type === 'resource') {
        return part.text ?? part.uri;
      }
      return `${part.mimeType}:${part.data.slice(0, 24)}`;
    })
    .join('\n')
    .trim();
}

export function responseExternalRef(response: MCPToolCallResponse): string | null {
  const resourceRef = response.content.find((part: MCPToolCallResponse['content'][number]) => part.type === 'resource');
  if (resourceRef && resourceRef.type === 'resource') {
    return resourceRef.uri;
  }
  const textRef = response.content.find((part: MCPToolCallResponse['content'][number]) => part.type === 'text');
  return textRef && textRef.type === 'text' ? textRef.text : null;
}

export function includesEmergencyCondition(requiredConditionDescription: string, emergencyReasonProse: string): boolean {
  const requiredTokens = requiredConditionDescription
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
  if (requiredTokens.length === 0) {
    return true;
  }
  const reason = emergencyReasonProse.toLowerCase();
  return requiredTokens.some((token) => reason.includes(token));
}
