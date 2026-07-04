/**
 * Conversation-history translation.
 *
 * When a routing decision swaps providers mid-conversation, the prior
 * messages still carry tool calls / results in the *source* provider's
 * shape. This module re-shapes each message so that the *target* provider
 * accepts the conversation as a continuation rather than a fresh start.
 *
 * The transformation is intentionally lossy on provider-specific metadata
 * (e.g. Anthropic `cache_control` markers) but preserves logical role and
 * tool-call/result identity.
 */

import type { Message } from '@weaveintel/core';
import type { ProviderToolAdapter } from './types.js';

export function translateConversationHistory(
  messages: readonly Message[],
  _from: ProviderToolAdapter,
  to: ProviderToolAdapter,
): Message[] {
  // The `_from` adapter is currently unused — `Message` is already the
  // canonical core shape, so we only need to ask the destination adapter
  // to reshape each message into its expected layout. The parameter is
  // kept in the signature for forward compatibility (e.g. when source
  // metadata needs to be unwrapped before retargeting).
  const out: Message[] = [];
  for (const m of messages) {
    const next = to.reshapeMessage(m);
    if (next !== null) out.push(next);
  }
  return out;
}
