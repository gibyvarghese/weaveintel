/**
 * Wraps a Model so every `generate()` and `stream()` call includes the
 * Anthropic Computer Use native tool definitions in `request.metadata`
 * (where the Anthropic provider picks them up to merge into the API body
 * and add the `computer-use-2024-10-22` beta header automatically).
 *
 * Usage:
 * ```ts
 * const base  = weaveAnthropic('claude-opus-4-8');
 * const model  = wrapModelForCua(base, 1280, 800);
 * const tools  = createCuaToolRegistry();
 * const agent  = weaveAgent({ model, tools, visionLoop: true, ... });
 * ```
 */

import type { Model, ModelRequest, ExecutionContext } from '@weaveintel/core';
import type { AnthropicComputerUseTool } from '@weaveintel/provider-anthropic';
import {
  weaveAnthropicComputerTool,
  weaveAnthropicTextEditorTool,
  weaveAnthropicBashTool,
} from '@weaveintel/provider-anthropic';

export interface WrapModelForCuaOptions {
  displayWidth?:  number;
  displayHeight?: number;
  displayNumber?: number;
}

/**
 * Wraps `model` so every API request includes the three CUA tool definitions
 * and the computer-use beta header (added automatically by the Anthropic
 * provider when `computerUseTools` is present in request metadata).
 */
export function wrapModelForCua(
  model: Model,
  opts: WrapModelForCuaOptions = {},
): Model {
  const cuaTools: AnthropicComputerUseTool[] = [
    weaveAnthropicComputerTool(
      opts.displayWidth  ?? 1280,
      opts.displayHeight ?? 800,
      opts.displayNumber,
    ),
    weaveAnthropicBashTool(),
    weaveAnthropicTextEditorTool(),
  ];

  function injectCuaMetadata(request: ModelRequest): ModelRequest {
    const existing = (request.metadata ?? {}) as Record<string, unknown>;
    return {
      ...request,
      metadata: {
        ...existing,
        computerUseTools: [
          ...((existing['computerUseTools'] as AnthropicComputerUseTool[] | undefined) ?? []),
          ...cuaTools,
        ],
      },
    };
  }

  const wrapped: Model = {
    ...model,
    generate(ctx: ExecutionContext, request: ModelRequest) {
      return model.generate(ctx, injectCuaMetadata(request));
    },
  };

  if (model.stream) {
    const baseStream = model.stream.bind(model);
    wrapped.stream = (ctx: ExecutionContext, request: ModelRequest) =>
      baseStream(ctx, injectCuaMetadata(request));
  }

  return wrapped;
}
