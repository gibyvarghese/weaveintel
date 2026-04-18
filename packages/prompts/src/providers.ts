/**
 * @weaveintel/prompts — Provider-aware render adapters
 *
 * Different LLM providers expect prompt content in different shapes:
 *   - OpenAI chat completions: messages array with role/content objects
 *   - Anthropic messages API: messages array with role/content, system separate
 *   - Simple text APIs: a single concatenated string
 *
 * This module converts a rendered prompt string (or framework render result)
 * into the format expected by each provider, without adding provider SDKs as
 * dependencies. The adapters work with plain objects that match provider shapes.
 *
 * WHY: Prompt templates and frameworks are provider-agnostic. The adapter
 * layer is the last step that translates generic prompt content into the wire
 * format the provider needs. This keeps prompts portable and testable without
 * mocking provider SDKs.
 *
 * INTEGRATION:
 *   - renderPromptRecord() in runtime.ts calls the appropriate adapter based on
 *     the model's provider when `providerAdapter` is supplied via options.
 *   - Framework section roles map to message roles:
 *       'role' section → system message
 *       'task', 'context', 'expectations', 'constraints', 'examples' → user message
 *       'output_contract', 'review_instructions' → user message (appended last)
 *   - For providers that don't support separate system messages (some open-source
 *     models), the SystemAsUserAdapter wraps system content as a user turn.
 *
 * USAGE:
 *   const adapter = openAIAdapter();
 *   const messages = adapter.adapt(frameworkResult, systemHint);
 *
 *   const adapter = anthropicAdapter();
 *   const { system, messages } = adapter.adaptForAnthropic(frameworkResult);
 */

import type { FrameworkRenderResult } from './frameworks.js';
import type { StructuredPromptMessage } from '@weaveintel/core';

// ─── Shared message type ──────────────────────────────────────

// StructuredPromptMessage is imported from @weaveintel/core:
//   { role: 'system' | 'user' | 'assistant'; content: string }

// ─── Adapter interface ────────────────────────────────────────

/**
 * Converts a rendered prompt into a provider-native message representation.
 *
 * Adapters are stateless and reusable across multiple render calls.
 * An adapter does not need to know about the LLM provider SDK — it produces
 * plain objects that match the provider's wire format.
 */
export interface ProviderRenderAdapter {
  /**
   * Human-readable identifier for this adapter.
   * Used in observability traces to record which format was used.
   */
  readonly adapterName: string;

  /**
   * Convert a plain rendered text string into a message array.
   *
   * @param text       - The fully rendered prompt text (post-interpolation).
   * @param systemHint - Optional explicit system message content. When provided,
   *                     this is prepended as a system role message.
   * @returns An array of StructuredPromptMessage ready for the provider.
   */
  adaptText(text: string, systemHint?: string): StructuredPromptMessage[];

  /**
   * Convert a framework render result into a message array.
   *
   * Framework sections are mapped to message roles based on their semantic
   * purpose. The 'role' section becomes the system message; all other sections
   * are assembled into a single user message.
   *
   * @param result     - Output from renderFramework().
   * @param sectionMap - Map from section key → rendered text (post-interpolation).
   * @param systemHint - Additional system content to prepend to the role section.
   * @returns An array of StructuredPromptMessage.
   */
  adaptFramework(
    result: FrameworkRenderResult,
    sectionMap: Record<string, string>,
    systemHint?: string,
  ): StructuredPromptMessage[];
}

// ─── Anthropic-specific output ────────────────────────────────

/**
 * Anthropic's messages API accepts `system` as a top-level string (separate
 * from the messages array). This extended result carries both.
 */
export interface AnthropicAdaptResult {
  /**
   * Top-level system prompt string (maps to the `system` API parameter).
   * null when there is no system content.
   */
  system: string | null;
  /**
   * Messages array for the `messages` API parameter.
   * Contains only 'user' and 'assistant' role messages.
   */
  messages: StructuredPromptMessage[];
}

// ─── Sections that map to system role ────────────────────────

/**
 * Framework section keys that should be rendered as system-role content.
 * All other sections are treated as user-role content.
 *
 * This is the authoritative mapping — adapters use it for consistent behaviour
 * across OpenAI, Anthropic, and other providers.
 */
const SYSTEM_SECTIONS = new Set(['role']);

// ─── OpenAI adapter ───────────────────────────────────────────

/**
 * OpenAI chat completions adapter.
 *
 * Produces a messages array where:
 *   - The 'role' framework section (or systemHint) becomes a `system` message.
 *   - All remaining framework sections are concatenated into a single `user` message.
 *   - When plain text is adapted, the entire text is treated as a `user` message
 *     unless a systemHint is provided.
 *
 * Compatible with: gpt-4o, gpt-4-turbo, gpt-3.5-turbo, and any OpenAI-API-
 * compatible endpoint.
 */
export function openAIAdapter(): ProviderRenderAdapter & {
  /**
   * Produce messages suitable for `openai.chat.completions.create({ messages })`.
   */
  toOpenAIMessages(text: string, systemHint?: string): Array<{ role: string; content: string }>;
} {
  function adaptText(text: string, systemHint?: string): StructuredPromptMessage[] {
    const messages: StructuredPromptMessage[] = [];
    if (systemHint?.trim()) {
      messages.push({ role: 'system', content: systemHint.trim() });
    }
    if (text.trim()) {
      messages.push({ role: 'user', content: text.trim() });
    }
    return messages;
  }

  function adaptFramework(
    _result: FrameworkRenderResult,
    sectionMap: Record<string, string>,
    systemHint?: string,
  ): StructuredPromptMessage[] {
    // Accumulate system and user content from the section map
    const systemParts: string[] = [];
    const userParts: string[] = [];

    if (systemHint?.trim()) systemParts.push(systemHint.trim());

    // Iterate in a consistent order (role first, then the rest alphabetically)
    const roleContent = sectionMap['role'];
    if (roleContent?.trim()) systemParts.push(roleContent.trim());

    for (const [key, content] of Object.entries(sectionMap)) {
      if (key === 'role' || !content?.trim()) continue;
      userParts.push(content.trim());
    }

    const messages: StructuredPromptMessage[] = [];
    if (systemParts.length) {
      messages.push({ role: 'system', content: systemParts.join('\n\n') });
    }
    if (userParts.length) {
      messages.push({ role: 'user', content: userParts.join('\n\n') });
    }
    return messages;
  }

  return {
    adapterName: 'openai',
    adaptText,
    adaptFramework,
    toOpenAIMessages: adaptText,
  };
}

// ─── Anthropic adapter ────────────────────────────────────────

/**
 * Anthropic messages API adapter.
 *
 * The Anthropic API accepts `system` as a separate top-level parameter.
 * This adapter provides both the standard adaptText/adaptFramework interface
 * (which wraps system content into a system-role message) and an
 * `adaptForAnthropic()` method that returns the split { system, messages } shape.
 *
 * Compatible with: claude-3-5-sonnet, claude-3-opus, claude-haiku, and the
 * Anthropic messages endpoint.
 */
export function anthropicAdapter(): ProviderRenderAdapter & {
  /**
   * Produce the split { system, messages } shape for `anthropic.messages.create()`.
   * The system field maps to the top-level `system` API parameter.
   */
  adaptForAnthropic(text: string, systemHint?: string): AnthropicAdaptResult;
  adaptFrameworkForAnthropic(
    result: FrameworkRenderResult,
    sectionMap: Record<string, string>,
    systemHint?: string,
  ): AnthropicAdaptResult;
} {
  function adaptText(text: string, systemHint?: string): StructuredPromptMessage[] {
    const messages: StructuredPromptMessage[] = [];
    if (systemHint?.trim()) {
      messages.push({ role: 'system', content: systemHint.trim() });
    }
    if (text.trim()) {
      messages.push({ role: 'user', content: text.trim() });
    }
    return messages;
  }

  function adaptFramework(
    _result: FrameworkRenderResult,
    sectionMap: Record<string, string>,
    systemHint?: string,
  ): StructuredPromptMessage[] {
    const systemParts: string[] = [];
    const userParts: string[] = [];

    if (systemHint?.trim()) systemParts.push(systemHint.trim());

    const roleContent = sectionMap['role'];
    if (roleContent?.trim()) systemParts.push(roleContent.trim());

    for (const [key, content] of Object.entries(sectionMap)) {
      if (key === 'role' || !content?.trim()) continue;
      userParts.push(content.trim());
    }

    const messages: StructuredPromptMessage[] = [];
    if (systemParts.length) {
      messages.push({ role: 'system', content: systemParts.join('\n\n') });
    }
    if (userParts.length) {
      messages.push({ role: 'user', content: userParts.join('\n\n') });
    }
    return messages;
  }

  function adaptForAnthropic(text: string, systemHint?: string): AnthropicAdaptResult {
    const system = systemHint?.trim() ?? null;
    const messages: StructuredPromptMessage[] = [];
    if (text.trim()) {
      messages.push({ role: 'user', content: text.trim() });
    }
    return { system, messages };
  }

  function adaptFrameworkForAnthropic(
    _result: FrameworkRenderResult,
    sectionMap: Record<string, string>,
    systemHint?: string,
  ): AnthropicAdaptResult {
    const systemParts: string[] = [];
    const userParts: string[] = [];

    if (systemHint?.trim()) systemParts.push(systemHint.trim());

    const roleContent = sectionMap['role'];
    if (roleContent?.trim()) systemParts.push(roleContent.trim());

    for (const [key, content] of Object.entries(sectionMap)) {
      if (key === 'role' || !content?.trim()) continue;
      userParts.push(content.trim());
    }

    return {
      system: systemParts.length ? systemParts.join('\n\n') : null,
      messages: userParts.length
        ? [{ role: 'user', content: userParts.join('\n\n') }]
        : [],
    };
  }

  return {
    adapterName: 'anthropic',
    adaptText,
    adaptFramework,
    adaptForAnthropic,
    adaptFrameworkForAnthropic,
  };
}

// ─── Text adapter (generic / non-chat providers) ──────────────

/**
 * Plain text adapter for providers that accept a single string prompt.
 *
 * Returns a single-element `messages` array with role 'user' containing the
 * full text. When a systemHint is provided, it is prepended with a separator.
 *
 * Use for: simple completion APIs, open-source models, or when you need
 * the rendered text as a single string (system + user joined).
 */
export function textAdapter(): ProviderRenderAdapter & {
  /**
   * Return the combined prompt as a plain string without a messages array.
   * Useful when you need to pass the prompt directly to a model.generate() call.
   */
  toText(text: string, systemHint?: string): string;
} {
  function adaptText(text: string, systemHint?: string): StructuredPromptMessage[] {
    const combined = [systemHint?.trim(), text.trim()].filter(Boolean).join('\n\n');
    return combined ? [{ role: 'user', content: combined }] : [];
  }

  function adaptFramework(
    result: FrameworkRenderResult,
    _sectionMap: Record<string, string>,
    systemHint?: string,
  ): StructuredPromptMessage[] {
    const combined = [systemHint?.trim(), result.text.trim()].filter(Boolean).join('\n\n');
    return combined ? [{ role: 'user', content: combined }] : [];
  }

  function toText(text: string, systemHint?: string): string {
    return [systemHint?.trim(), text.trim()].filter(Boolean).join('\n\n');
  }

  return { adapterName: 'text', adaptText, adaptFramework, toText };
}

// ─── System-as-user adapter ───────────────────────────────────

/**
 * Adapter for models that don't support a system role.
 *
 * Wraps system content in a user turn using a standard header prefix
 * ("<<SYSTEM>>\n...\n<</SYSTEM>>"). Use for open-source chat models
 * that follow the Human/Assistant turn format without a system channel.
 */
export function systemAsUserAdapter(): ProviderRenderAdapter {
  function wrapSystem(system: string): string {
    return `<<SYSTEM>>\n${system.trim()}\n<</SYSTEM>>`;
  }

  function adaptText(text: string, systemHint?: string): StructuredPromptMessage[] {
    const parts: string[] = [];
    if (systemHint?.trim()) parts.push(wrapSystem(systemHint));
    if (text.trim()) parts.push(text.trim());
    return parts.length ? [{ role: 'user', content: parts.join('\n\n') }] : [];
  }

  function adaptFramework(
    _result: FrameworkRenderResult,
    sectionMap: Record<string, string>,
    systemHint?: string,
  ): StructuredPromptMessage[] {
    const parts: string[] = [];
    if (systemHint?.trim()) parts.push(wrapSystem(systemHint));

    const roleContent = sectionMap['role'];
    if (roleContent?.trim()) parts.push(wrapSystem(roleContent));

    for (const [key, content] of Object.entries(sectionMap)) {
      if (key === 'role' || !content?.trim()) continue;
      parts.push(content.trim());
    }

    return parts.length ? [{ role: 'user', content: parts.join('\n\n') }] : [];
  }

  return { adapterName: 'system-as-user', adaptText, adaptFramework };
}

// ─── Adapter factory ──────────────────────────────────────────

/**
 * Known provider names for the adapter factory.
 * Extend this union to add new provider adapters.
 */
export type KnownProvider = 'openai' | 'anthropic' | 'text' | 'system-as-user';

/**
 * Resolve a ProviderRenderAdapter by provider name.
 *
 * Used by renderPromptRecord() in runtime.ts to pick the right adapter
 * without requiring the caller to import each adapter individually.
 *
 * @param provider - One of the known provider names (openai, anthropic, text, system-as-user).
 * @returns The matching adapter; falls back to textAdapter for unknown providers.
 */
export function resolveAdapter(provider: string): ProviderRenderAdapter {
  switch (provider as KnownProvider) {
    case 'openai':         return openAIAdapter();
    case 'anthropic':      return anthropicAdapter();
    case 'system-as-user': return systemAsUserAdapter();
    case 'text':
    default:               return textAdapter();
  }
}
