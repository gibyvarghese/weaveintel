/**
 * Computer Use API — tool registry for weaveAgent.
 *
 * Provides ToolRegistry implementations of the three Anthropic CUA built-in
 * tools so they work inside weaveAgent's standard ReAct loop:
 *
 *   `computer`          — screenshot + mouse/keyboard actions
 *   `bash`              — shell command execution
 *   `str_replace_editor`— file view / create / str_replace / undo_edit
 *
 * The `computer` tool returns screenshots in the JSON format recognised by
 * weaveAgent's visionLoop:
 *   `{ "type": "image", "base64": "<data>", "mimeType": "image/png" }`
 *
 * When no real display is available (headless / CI), the screenshot fallback
 * returns a textual description of the environment so the agent can still
 * reason about what to do next using the bash + editor tools.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { weaveToolRegistry, weaveTool } from '@weaveintel/core';
import type { ToolRegistry } from '@weaveintel/core';

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────

export interface CuaToolRegistryOptions {
  /**
   * Display dimensions passed to the Anthropic `computer_20241022` tool
   * definition. Default: 1280 × 800.
   */
  displayWidth?: number;
  displayHeight?: number;
  /**
   * Override screenshot implementation. Receives the display number and must
   * return a base64-encoded PNG. When omitted, scrot is tried on Linux and
   * screencapture on macOS; falls back to a text description.
   */
  screenshot?: (displayNumber?: number) => Promise<string>;
  /**
   * Override action implementation (click, type, key, scroll, mouse_move).
   * When omitted, xdotool is tried on Linux; falls back to a no-op on macOS.
   */
  performAction?: (action: string, params: Record<string, unknown>) => Promise<void>;
  /**
   * Working directory for bash commands. Defaults to process.cwd().
   */
  cwd?: string;
  /**
   * Maximum bash command execution time in milliseconds. Default: 30 000.
   */
  bashTimeoutMs?: number;
  /**
   * Display number for X11 tools. Default: 0.
   */
  displayNumber?: number;
}

// ── Screenshot helpers ─────────────────────────────────────────

async function takeScreenshot(opts: CuaToolRegistryOptions): Promise<string> {
  const display = opts.displayNumber ?? 0;
  if (opts.screenshot) {
    return opts.screenshot(display);
  }

  const platform = process.platform;
  try {
    if (platform === 'linux') {
      const { stdout } = await execFileAsync('scrot', ['-z', '--output-file', '/dev/stdout'], {
        encoding: 'base64',
        env: { ...process.env, DISPLAY: `:${display}` },
        timeout: 10_000,
      });
      return stdout;
    }
    if (platform === 'darwin') {
      const tmpPath = `/tmp/cua-screenshot-${Date.now()}.png`;
      await execFileAsync('screencapture', ['-x', tmpPath], { timeout: 10_000 });
      const data = await readFile(tmpPath);
      return data.toString('base64');
    }
  } catch {
    // fall through to text description
  }

  // Headless / unsupported platform: return a text-described "screenshot"
  let description = 'Terminal / headless environment. No display available.\n';
  try {
    const { stdout } = await execFileAsync('pwd', [], { timeout: 3_000 });
    description += `Current directory: ${stdout.trim()}\n`;
    const { stdout: ls } = await execFileAsync('ls', ['-la', '--color=never'], {
      cwd: opts.cwd ?? process.cwd(),
      timeout: 3_000,
    });
    description += `Files:\n${ls}`;
  } catch { /* ignore */ }

  // Encode text description as base64 PNG placeholder
  return Buffer.from(description, 'utf-8').toString('base64');
}

// ── Action helpers ──────────────────────────────────────────────

async function performComputerAction(
  action: string,
  params: Record<string, unknown>,
  opts: CuaToolRegistryOptions,
): Promise<void> {
  if (opts.performAction) {
    return opts.performAction(action, params);
  }
  if (process.platform !== 'linux') return; // xdotool not available on macOS
  const display = opts.displayNumber ?? 0;
  const env = { ...process.env, DISPLAY: `:${display}` };

  try {
    switch (action) {
      case 'left_click':
        await execFileAsync('xdotool', ['mousemove', String(params['x']), String(params['y']), 'click', '1'], { env, timeout: 5_000 });
        break;
      case 'right_click':
        await execFileAsync('xdotool', ['mousemove', String(params['x']), String(params['y']), 'click', '3'], { env, timeout: 5_000 });
        break;
      case 'double_click':
        await execFileAsync('xdotool', ['mousemove', String(params['x']), String(params['y']), 'click', '--repeat', '2', '1'], { env, timeout: 5_000 });
        break;
      case 'type':
        await execFileAsync('xdotool', ['type', '--clearmodifiers', '--', String(params['text'])], { env, timeout: 10_000 });
        break;
      case 'key':
        await execFileAsync('xdotool', ['key', '--clearmodifiers', '--', String(params['key'])], { env, timeout: 5_000 });
        break;
      case 'scroll':
        {
          const button = Number(params['direction'] === 'down' ? 5 : 4);
          const count = Number(params['amount'] ?? 3);
          await execFileAsync('xdotool', ['mousemove', String(params['x']), String(params['y']), 'click', '--repeat', String(count), String(button)], { env, timeout: 5_000 });
        }
        break;
      case 'mouse_move':
        await execFileAsync('xdotool', ['mousemove', String(params['x']), String(params['y'])], { env, timeout: 5_000 });
        break;
      default:
        // unknown action — no-op
    }
  } catch { /* ignore xdotool errors */ }
}

// ── Tool implementations ────────────────────────────────────────

type ComputerArgs = {
  action: string;
  coordinate?: [number, number];
  text?: string;
  key?: string;
  direction?: string;
  amount?: number;
};
type BashArgs = { command: string; restart?: boolean };
type EditorArgs = {
  command: 'view' | 'create' | 'str_replace' | 'insert' | 'undo_edit';
  path: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  new_file_text?: string;
};

function makeComputerTool(opts: CuaToolRegistryOptions) {
  return weaveTool<ComputerArgs>({
    name: 'computer',
    description: 'Take a screenshot, move the mouse, click, type text, or press keys.',
    parameters: {
      type: 'object',
      required: ['action'],
      properties: {
        action:     { type: 'string', enum: ['screenshot', 'left_click', 'right_click', 'double_click', 'type', 'key', 'scroll', 'mouse_move', 'left_click_drag'] },
        coordinate: { type: 'array', items: { type: 'integer' }, description: '[x, y] pixel coordinates' },
        text:       { type: 'string', description: 'Text to type' },
        key:        { type: 'string', description: 'Key sequence (xdotool format)' },
        direction:  { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount:     { type: 'integer', description: 'Scroll amount' },
      },
    },
    tags: ['computer-use'],
    async execute(args: ComputerArgs) {
      const { action, coordinate, text, key, direction, amount } = args;
      const params: Record<string, unknown> = {};
      if (coordinate) { params['x'] = coordinate[0]; params['y'] = coordinate[1]; }
      if (text) params['text'] = text;
      if (key) params['key'] = key;
      if (direction) params['direction'] = direction;
      if (amount) params['amount'] = amount;

      if (action === 'screenshot') {
        const base64 = await takeScreenshot(opts);
        return JSON.stringify({ type: 'image', base64, mimeType: 'image/png' });
      }

      await performComputerAction(action, params, opts);
      return `Action executed: ${action}${coordinate ? ` at (${coordinate[0]}, ${coordinate[1]})` : ''}`;
    },
  });
}

function makeBashTool(opts: CuaToolRegistryOptions) {
  return weaveTool<BashArgs>({
    name: 'bash',
    description: 'Execute a bash command and return its stdout/stderr output.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        restart: { type: 'boolean', description: 'Restart the bash session (clears environment)' },
      },
    },
    tags: ['computer-use'],
    async execute({ command }: BashArgs) {
      const cwd = opts.cwd ?? process.cwd();
      const timeout = opts.bashTimeoutMs ?? 30_000;
      try {
        const { stdout, stderr } = await execFileAsync(
          '/bin/bash',
          ['-c', command],
          { cwd, timeout, maxBuffer: 2 * 1024 * 1024 },
        );
        const out = stdout ?? '';
        const err = stderr ?? '';
        return out + (err ? `\nSTDERR:\n${err}` : '');
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        return { content: `Command failed: ${err.message}\n${err.stderr ?? ''}`, isError: true };
      }
    },
  });
}

function makeTextEditorTool(opts: CuaToolRegistryOptions) {
  const cwd = opts.cwd ?? process.cwd();
  return weaveTool<EditorArgs>({
    name: 'str_replace_editor',
    description: 'View, create, or edit files using string replacement.',
    parameters: {
      type: 'object',
      required: ['command', 'path'],
      properties: {
        command:     { type: 'string', enum: ['view', 'create', 'str_replace', 'insert', 'undo_edit'] },
        path:        { type: 'string', description: 'File path (relative to working dir)' },
        file_text:     { type: 'string', description: 'Full content for create command' },
        old_str:       { type: 'string', description: 'Existing text to replace (str_replace command)' },
        new_str:       { type: 'string', description: 'Replacement text (str_replace command)' },
        insert_line:   { type: 'integer', description: 'Line number to insert at (insert command)' },
        new_file_text: { type: 'string', description: 'Text to insert (insert command); also accepted as alias for file_text on create' },
      },
    },
    tags: ['computer-use'],
    async execute(args: EditorArgs) {
      const { command, path: filePath, file_text, old_str, new_str } = args;
      const resolvedPath = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`;

      switch (command) {
        case 'view': {
          try {
            const s = await stat(resolvedPath);
            if (s.isDirectory()) {
              const entries = await readdir(resolvedPath);
              return `Directory: ${resolvedPath}\n${entries.map(e => `  ${e}`).join('\n')}`;
            }
            const content = await readFile(resolvedPath, 'utf-8');
            const lines = content.split('\n');
            return lines.map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
          } catch (e: unknown) {
            return { content: `Cannot view ${filePath}: ${(e as Error).message}`, isError: true };
          }
        }
        case 'create': {
          try {
            // Accept file_text (Anthropic spec) or new_file_text (common model alias)
            const content = file_text ?? args.new_file_text ?? '';
            await writeFile(resolvedPath, content, 'utf-8');
            return `Created ${filePath}`;
          } catch (e: unknown) {
            return { content: `Cannot create ${filePath}: ${(e as Error).message}`, isError: true };
          }
        }
        case 'str_replace': {
          if (!old_str) return { content: 'str_replace requires old_str', isError: true };
          try {
            const content = await readFile(resolvedPath, 'utf-8');
            if (!content.includes(old_str)) return { content: `old_str not found in ${filePath}`, isError: true };
            const updated = content.replace(old_str, new_str ?? '');
            await writeFile(resolvedPath, updated, 'utf-8');
            return `Replaced in ${filePath}`;
          } catch (e: unknown) {
            return { content: `Cannot edit ${filePath}: ${(e as Error).message}`, isError: true };
          }
        }
        case 'insert': {
          try {
            const content = await readFile(resolvedPath, 'utf-8');
            const lines = content.split('\n');
            const at = Math.min(args.insert_line ?? lines.length, lines.length);
            lines.splice(at, 0, args.new_file_text ?? '');
            await writeFile(resolvedPath, lines.join('\n'), 'utf-8');
            return `Inserted at line ${at} in ${filePath}`;
          } catch (e: unknown) {
            return { content: `Cannot insert in ${filePath}: ${(e as Error).message}`, isError: true };
          }
        }
        default:
          return { content: `Unknown command: ${command}`, isError: true };
      }
    },
  });
}

// ── Public factory ──────────────────────────────────────────────

/**
 * Build a ToolRegistry containing the three Anthropic CUA tools.
 *
 * Pass this registry to `weaveAgent({ tools: createCuaToolRegistry() })`.
 * Also pass `{ metadata: { computerUseTools: [...] } }` to the model request
 * via a CUA-wrapped model so Anthropic receives them in native format.
 */
export function createCuaToolRegistry(opts: CuaToolRegistryOptions = {}): ToolRegistry {
  const registry = weaveToolRegistry();
  registry.register(makeComputerTool(opts));
  registry.register(makeBashTool(opts));
  registry.register(makeTextEditorTool(opts));
  return registry;
}
