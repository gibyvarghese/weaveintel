import type { ContentPart, ModelRequest, ModelResponse, CapabilityId } from '@weaveintel/core';
import { Capabilities, unsupportedPart } from '@weaveintel/core';
import { googleAdapter, translate } from '@weaveintel/tools/schema';

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

export interface GeminiModelMetadata {
  pattern: RegExp;
  capabilities: CapabilityId[];
  maxContextTokens: number;
  maxOutputTokens: number;
}

export interface ParsedCandidate {
  text: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | undefined;
}

const mimeOf = (m: string | undefined, fallback: string): string => (m ?? fallback).split(';')[0]!.trim().toLowerCase();

/** File types Gemini reads inline: PDF, text, images, audio and video. Office files are not among them. */
export function geminiReadsMime(mime: string): boolean {
  return mime === 'application/pdf' || /^(text|image|audio|video)\//.test(mime);
}

/**
 * Translate one content part for Gemini. Every part is sent properly or
 * refused with an `UnsupportedContentError` naming the capability: a part
 * with no content is never sent as an empty inline blob, and file types
 * Gemini cannot read (Word, Excel, zip ...) are refused rather than sent blind.
 */
export function partToGeminiPart(part: ContentPart, who: { provider?: string; modelId?: string } = { provider: 'google' }): GeminiPart {
  if (part.type === 'text') return { text: part.text };
  if (part.type !== 'image' && part.type !== 'audio' && part.type !== 'file') {
    throw unsupportedPart(part, who);
  }
  const fallback = part.type === 'image' ? 'image/png' : part.type === 'audio' ? 'audio/wav' : 'application/octet-stream';
  const mime = mimeOf(part.mimeType, fallback);
  if (part.type === 'file' && !geminiReadsMime(mime)) throw unsupportedPart(part, who);
  if (part.base64) return { inlineData: { mimeType: mime, data: part.base64 } };
  if (part.url && /^(https?|gs):\/\//.test(part.url)) return { fileData: { mimeType: mime, fileUri: part.url } };
  throw unsupportedPart(part, { ...who, reason: part.url ? 'only http(s) or gs:// links can be sent' : 'the part has no content' });
}

export function buildGeminiRequest(
  request: ModelRequest,
): { contents: GeminiContent[]; systemInstruction?: GeminiContent } {
  const contents: GeminiContent[] = [];
  let systemInstruction: GeminiContent | undefined;

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      // A system instruction carries text only: any other part is refused, never dropped.
      const text = typeof msg.content === 'string' ? msg.content : msg.content
        .map((p) => {
          if (p.type === 'text') return p.text;
          throw unsupportedPart(p, { provider: 'google', reason: 'a system instruction takes only text' });
        })
        .join('\n');
      const existing = systemInstruction?.parts[0]?.text ?? '';
      systemInstruction = {
        role: 'user',
        parts: [{ text: existing ? `${existing}\n${text}` : text }],
      };
      continue;
    }

    if (msg.role === 'tool' && msg.toolCallId) {
      let payload: Record<string, unknown>;
      const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      try {
        const parsed = JSON.parse(raw) as unknown;
        payload = (parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>) : { result: parsed };
      } catch {
        payload = { result: raw };
      }
      contents.push({
        role: 'function',
        parts: [{
          functionResponse: { name: msg.name ?? msg.toolCallId, response: payload },
        }],
      });
      continue;
    }

    const role: GeminiContent['role'] = msg.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];

    if (typeof msg.content === 'string') {
      if (msg.content) parts.push({ text: msg.content });
    } else {
      for (const cp of msg.content) parts.push(partToGeminiPart(cp));
    }

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || '{}') as Record<string, unknown>;
        } catch {
          // keep empty
        }
        parts.push({ functionCall: { name: tc.name, args } });
      }
    }

    if (parts.length === 0) parts.push({ text: '' });
    contents.push({ role, parts });
  }

  return { contents, systemInstruction };
}

export function buildGeminiTools(tools: ModelRequest['tools']): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return translate(tools, googleAdapter);
}

export function buildGeminiToolConfig(
  toolChoice: ModelRequest['toolChoice'],
): Record<string, unknown> | undefined {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') {
    switch (toolChoice) {
      case 'auto':
        return { functionCallingConfig: { mode: 'AUTO' } };
      case 'none':
        return { functionCallingConfig: { mode: 'NONE' } };
      case 'required':
        return { functionCallingConfig: { mode: 'ANY' } };
      default:
        return { functionCallingConfig: { mode: 'AUTO' } };
    }
  }
  return {
    functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.name] },
  };
}

export const GEMINI_MODEL_METADATA: GeminiModelMetadata[] = [
  {
    // Gemini 2.5 / 2.0 Pro & Flash families
    pattern: /gemini-(2\.\d|3\.\d|2|3)(?:\.\d)?-(pro|flash)/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.StructuredOutput,
      Capabilities.Vision,
      Capabilities.PdfInput,
      Capabilities.AudioInput,
      Capabilities.DocumentInput,
      Capabilities.Multimodal,
      Capabilities.Reasoning,
    ],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 65_536,
  },
  {
    pattern: /gemini-1\.5-(pro|flash)/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.StructuredOutput,
      Capabilities.Vision,
      Capabilities.PdfInput,
      Capabilities.AudioInput,
      Capabilities.DocumentInput,
      Capabilities.Multimodal,
    ],
    maxContextTokens: 1_048_576,
    maxOutputTokens: 8_192,
  },
  {
    pattern: /gemini/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.Vision,
      Capabilities.PdfInput,
      Capabilities.AudioInput,
      Capabilities.DocumentInput,
      Capabilities.Multimodal,
    ],
    maxContextTokens: 32_768,
    maxOutputTokens: 8_192,
  },
];

export const GEMINI_DEFAULT_METADATA: GeminiModelMetadata = {
  pattern: /.*/,
  capabilities: [Capabilities.Chat, Capabilities.Streaming],
  maxContextTokens: 32_768,
  maxOutputTokens: 8_192,
};

export function resolveGeminiMetadata(modelId: string): GeminiModelMetadata {
  return GEMINI_MODEL_METADATA.find((m) => m.pattern.test(modelId)) ?? GEMINI_DEFAULT_METADATA;
}

export function mapFinishReason(reason: string | undefined): ModelResponse['finishReason'] {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'content_filter';
    case 'TOOL_CODE':
    case 'MALFORMED_FUNCTION_CALL':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

export function parseCandidate(candidate: Record<string, unknown> | undefined): ParsedCandidate {
  const result: ParsedCandidate = {
    text: '',
    reasoning: '',
    toolCalls: [],
    finishReason: candidate?.['finishReason'] as string | undefined,
  };
  const content = candidate?.['content'] as Record<string, unknown> | undefined;
  const parts = content?.['parts'];
  if (!Array.isArray(parts)) return result;

  let toolIndex = 0;
  for (const raw of parts as Array<Record<string, unknown>>) {
    if (typeof raw['text'] === 'string') {
      if (raw['thought'] === true) {
        result.reasoning += raw['text'] as string;
      } else {
        result.text += raw['text'] as string;
      }
      continue;
    }
    const fc = raw['functionCall'] as Record<string, unknown> | undefined;
    if (fc && typeof fc['name'] === 'string') {
      result.toolCalls.push({
        id: `gemini-tool-${toolIndex++}`,
        name: String(fc['name']),
        arguments: JSON.stringify(fc['args'] ?? {}),
      });
    }
  }
  return result;
}

export function parseUsage(raw: Record<string, unknown>): ModelResponse['usage'] {
  const usage = raw['usageMetadata'] as Record<string, number> | undefined;
  return {
    promptTokens: usage?.['promptTokenCount'] ?? 0,
    completionTokens: usage?.['candidatesTokenCount'] ?? 0,
    totalTokens:
      usage?.['totalTokenCount'] ??
      ((usage?.['promptTokenCount'] ?? 0) + (usage?.['candidatesTokenCount'] ?? 0)),
  };
}
