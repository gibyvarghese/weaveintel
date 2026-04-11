/**
 * @weaveintel/core — Content moderation contracts
 *
 * Why: Content moderation is a first-class capability distinct from
 * classification. It provides category-level flagging with confidence scores,
 * input type tracking, and is provider-agnostic so any moderation service
 * (OpenAI, Azure, custom) can implement the same contract.
 */

import type { ExecutionContext } from './context.js';

// ─── Moderation types ────────────────────────────────────────

export interface ModerationRequest {
  readonly input: string | ModerationInput[];
  readonly model?: string;
}

export type ModerationInput =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly imageUrl: string };

export interface ModerationCategory {
  readonly category: string;
  readonly flagged: boolean;
  readonly score: number;
  readonly appliedInputTypes?: readonly string[];
}

export interface ModerationResult {
  readonly id: string;
  readonly model: string;
  readonly flagged: boolean;
  readonly categories: readonly ModerationCategory[];
}

export interface ModerationResponse {
  readonly results: readonly ModerationResult[];
}

// ─── Moderation model interface ──────────────────────────────

export interface ModerationModel {
  moderate(ctx: ExecutionContext, request: ModerationRequest): Promise<ModerationResponse>;
}
