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
/**
 * Remove a finished run's scratch folder, and never let failing to do so break the run.
 *
 * WHAT THIS IS (plain language)
 * Each execution gets a temporary folder on the host that the container reads its code from and
 * writes its results into. When the run is over the folder is rubbish and should go. This throws it
 * away — and, crucially, treats "I could not throw it away" as a housekeeping problem rather than as
 * the run having failed.
 *
 * **THE BUG THIS EXISTS TO FIX, WHICH WAS MEASURED RATHER THAN IMAGINED.** The tidy-up sat in a
 * `finally`, and a `finally` that throws REPLACES whatever the function was about to return. On macOS
 * the container releases its mount of that folder a moment after the process exits, so a deletion
 * issued immediately gets `EACCES` — and `force: true` forgives a folder that is already gone, not one
 * the operating system will not let you touch yet. The result was that a run whose code had executed
 * perfectly, and whose output was already in hand, was reported to the caller as "the sandbox failed
 * to run the code". Under one run at a time it almost never happened; with forty at once it happened
 * forty times out of forty.
 *
 * WHEN TO USE / NOT USE: call it in the `finally` of any execution that made a scratch folder. Do not
 * use it where a failure to delete genuinely matters — this deliberately gives up quietly.
 *
 * @param workDir Absolute path of the scratch folder to remove.
 * @param attempts How many times to try before giving up. @defaultValue 5
 * @param waitMs How long to wait between tries, in milliseconds; the wait grows with each try.
 *   @defaultValue 40
 * @returns nothing, and **never throws**. A folder that survives is left for the operating system to
 *   clear out of its temporary directory, which is what that directory is for.
 * @remarks Retries because the condition is momentary — the container is letting go of the mount. Five
 *   short attempts cover it without adding a noticeable pause to a run that had no trouble at all: the
 *   first attempt succeeds in the ordinary case and nothing waits.
 */
export async function discardScratchFolder(workDir: string, attempts = 5, waitMs = 40): Promise<void> {
  const { rm } = await import('node:fs/promises');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(workDir, { recursive: true, force: true });
      return;
    } catch {
      // THE LAST ATTEMPT GIVES UP WITHOUT A WORD TO THE CALLER. Whatever the caller was returning is
      // the thing that matters; an undeleted temporary folder is not their problem and must not become
      // their error.
      if (attempt === attempts - 1) return;
      await new Promise((resolve) => setTimeout(resolve, waitMs * (attempt + 1)));
    }
  }
}

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
