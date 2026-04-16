/**
 * @weaveintel/sandbox/cse — ContainerProvider interface
 *
 * All provider implementations must satisfy this contract.
 * Session support and browser support are optional capabilities.
 */

import type {
  CSEConfig,
  CSEHealthStatus,
  CSEProviderKind,
  CSESession,
  ExecutionRequest,
  ExecutionResult,
} from '../types.js';

export interface ContainerProvider {
  readonly kind: CSEProviderKind;
  /** If true, the provider can create persistent session containers. */
  readonly supportsSession: boolean;
  /** If true, the provider can run browser automation workloads. */
  readonly supportsBrowser: boolean;

  /** Called once after construction. Should validate credentials / connectivity. */
  initialize(config: CSEConfig): Promise<void>;

  /**
   * Execute code in an ephemeral container.
   * The container is created, code runs, output is captured, container is destroyed.
   */
  execute(request: ExecutionRequest, config: CSEConfig): Promise<ExecutionResult>;

  /**
   * Create (or reuse) a persistent session container for a chat.
   * Session containers stay alive for repeated executions.
   */
  createSession(chatId: string, config: CSEConfig, withBrowser: boolean): Promise<CSESession>;

  /**
   * Execute code inside an already-running session container.
   */
  executeInSession(
    session: CSESession,
    request: ExecutionRequest,
    config: CSEConfig,
  ): Promise<ExecutionResult>;

  /** Terminate and clean up a session container. */
  terminateSession(session: CSESession, config: CSEConfig): Promise<void>;

  /** Quick health check — verifies credentials and reachability. */
  healthCheck(config: CSEConfig): Promise<CSEHealthStatus>;
}

// ─── Helpers shared across providers ──────────────────────────

/**
 * Build the shell command that runs code of a given language.
 * Code is expected to be written to /workspace/code.<ext> before invoking.
 */
export function buildRunCommand(language: ExecutionRequest['language']): string[] {
  switch (language ?? 'python') {
    case 'python':      return ['python', '/workspace/code.py'];
    case 'javascript':  return ['node', '/workspace/code.js'];
    case 'typescript':  return ['npx', 'tsx', '/workspace/code.ts'];
    case 'bash':
    case 'shell':       return ['bash', '/workspace/code.sh'];
    default:            return ['python', '/workspace/code.py'];
  }
}

/** File extension for the given language. */
export function languageExt(language: ExecutionRequest['language']): string {
  switch (language ?? 'python') {
    case 'python':      return 'py';
    case 'javascript':  return 'js';
    case 'typescript':  return 'ts';
    case 'bash':
    case 'shell':       return 'sh';
    default:            return 'py';
  }
}

/** Try to parse the last line of stdout as JSON (agent output convention). */
export function tryParseOutput(stdout: string): unknown | undefined {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith('{') || line.startsWith('[')) {
      try { return JSON.parse(line); } catch { /* skip */ }
    }
  }
  return undefined;
}
