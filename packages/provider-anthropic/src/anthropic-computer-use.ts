/**
 * @weaveintel/provider-anthropic — Computer Use tools
 *
 * Provides builders for Anthropic's computer use tools:
 * - Computer tool (screenshots, mouse, keyboard)
 * - Text editor tool (view, create, edit files)
 * - Bash tool (run shell commands)
 *
 * These are Anthropic-specific tool types that differ from standard
 * function-calling tools. They use special `type` values and
 * require the `computer-use-2024-10-22` beta header.
 */

// ─── Computer Use tool types ─────────────────────────────────

export interface AnthropicComputerTool {
  type: 'computer_20241022';
  name: 'computer';
  display_width_px: number;
  display_height_px: number;
  display_number?: number;
}

export interface AnthropicTextEditorTool {
  type: 'text_editor_20241022';
  name: 'str_replace_editor';
}

export interface AnthropicBashTool {
  type: 'bash_20241022';
  name: 'bash';
}

export type AnthropicComputerUseTool =
  | AnthropicComputerTool
  | AnthropicTextEditorTool
  | AnthropicBashTool;

// ─── Computer Use result types ───────────────────────────────

export interface ComputerToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  >;
  is_error?: boolean;
}

// ─── Builders ────────────────────────────────────────────────

/**
 * Create a computer tool for screenshots, mouse clicks, and keyboard input.
 *
 * @example
 * ```ts
 * const tools = [
 *   weaveAnthropicComputerTool(1024, 768),
 *   weaveAnthropicTextEditorTool(),
 *   weaveAnthropicBashTool(),
 * ];
 * ```
 */
export function weaveAnthropicComputerTool(
  displayWidthPx: number,
  displayHeightPx: number,
  displayNumber?: number,
): AnthropicComputerTool {
  const tool: AnthropicComputerTool = {
    type: 'computer_20241022',
    name: 'computer',
    display_width_px: displayWidthPx,
    display_height_px: displayHeightPx,
  };
  if (displayNumber !== undefined) {
    tool.display_number = displayNumber;
  }
  return tool;
}

/** Create a text editor tool for viewing and editing files. */
export function weaveAnthropicTextEditorTool(): AnthropicTextEditorTool {
  return {
    type: 'text_editor_20241022',
    name: 'str_replace_editor',
  };
}

/** Create a bash tool for running shell commands. */
export function weaveAnthropicBashTool(): AnthropicBashTool {
  return {
    type: 'bash_20241022',
    name: 'bash',
  };
}

/**
 * Build a tool result content block for returning a screenshot.
 *
 * @param toolUseId - The id from the tool_use content block
 * @param base64Image - Base64-encoded screenshot data
 * @param mediaType - Image media type (default: "image/png")
 */
export function weaveAnthropicScreenshotResult(
  toolUseId: string,
  base64Image: string,
  mediaType: string = 'image/png',
): ComputerToolResult {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: base64Image,
        },
      },
    ],
  };
}

/**
 * Build a tool result content block with text output.
 *
 * @param toolUseId - The id from the tool_use content block
 * @param text - The text output from the tool execution
 * @param isError - Whether this is an error result
 */
export function weaveAnthropicTextResult(
  toolUseId: string,
  text: string,
  isError: boolean = false,
): ComputerToolResult {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [{ type: 'text', text }],
    is_error: isError,
  };
}

/** The beta header required for computer use. */
export const COMPUTER_USE_BETA = 'computer-use-2024-10-22';
