/**
 * @weaveintel/sandbox/cse — Local Docker provider
 *
 * Runs code in a local Docker container. Suitable for development and
 * environments without a cloud provider.
 *
 * Security posture:
 *  • --network=none by default (outbound blocked)
 *  • --read-only root filesystem with /tmp as tmpfs
 *  • --user=65534 (nobody)
 *  • --cap-drop=ALL
 *  • --security-opt no-new-privileges
 *  • CPU/memory hard limits enforced by Docker cgroups
 *
 * Session mode keeps a container alive with 'sleep infinity' and uses
 * 'docker exec' to run successive code snippets.
 */

import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ContainerProvider } from './base.js';
import { buildRunCommand, languageExt, tryParseOutput } from './base.js';
import type {
  CSEConfig,
  CSEHealthStatus,
  CSESession,
  ExecutionRequest,
  ExecutionResult,
} from '../types.js';

const DEFAULT_EXECUTION_IMAGE = 'python:3.12-slim';
const DEFAULT_BROWSER_IMAGE = 'mcr.microsoft.com/playwright:v1.44.0-jammy';

function appendContainerEnvArgs(args: string[], env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    args.push('-e', `${key}=${value}`);
  }
}

function pythonContainerEnv(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    TMPDIR: `${homeDir}/.tmp`,
    PIP_NO_CACHE_DIR: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    MPLCONFIGDIR: `${homeDir}/.config/matplotlib`,
  };
}

function dockerExecEnvArgs(env: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    args.push('-e', `${key}=${value}`);
  }
  return args;
}

// ─── Helpers ──────────────────────────────────────────────────

function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; stdin?: string | Buffer } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
      }, opts.timeoutMs);
    }

    if (opts.stdin) {
      proc.stdin?.write(opts.stdin);
      proc.stdin?.end();
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1, durationMs: Date.now() - start });
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr: err.message, exitCode: -1, durationMs: Date.now() - start });
    });
  });
}

async function collectArtifacts(outputDir: string): Promise<ExecutionResult['artifacts']> {
  const artifacts: ExecutionResult['artifacts'] = [];
  try {
    const files = await readdir(outputDir);
    for (const file of files) {
      const filePath = join(outputDir, file);
      try {
        const data = await readFile(filePath);
        const mimeType = guessMime(file);
        artifacts.push({
          name: file,
          mimeType,
          data: data.toString('base64'),
          sizeBytes: data.byteLength,
        });
      } catch { /* skip unreadable files */ }
    }
  } catch { /* output dir may not exist */ }
  return artifacts;
}

function guessMime(name: string): string {
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.txt')) return 'text/plain';
  if (name.endsWith('.html')) return 'text/html';
  if (name.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

function sanitizeWorkspaceFileName(name: string): string {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const cleaned = normalized
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, '_'))
    .join('/');
  return cleaned || `file_${randomUUID().slice(0, 8)}`;
}

// ─── Provider ────────────────────────────────────────────────

export class LocalDockerProvider implements ContainerProvider {
  readonly kind = 'local' as const;
  readonly supportsSession = true;
  readonly supportsBrowser = true;

  async initialize(_config: CSEConfig): Promise<void> {
    const { exitCode } = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
    if (exitCode !== 0) throw new Error('Docker daemon is not available. Start Docker Desktop or Docker Engine.');
    // Orphan cleanup: remove any cse_session containers left over from a previous
    // crashed/killed server instance. These containers are identified by the
    // 'cse.managed=true' label we attach at creation time.
    await this.cleanupOrphanContainers();
  }

  /** Remove all cse.managed containers left over from a previous server instance. */
  private async cleanupOrphanContainers(): Promise<void> {
    const { stdout, exitCode } = await run('docker', [
      'ps', '-a',
      '--filter', 'label=cse.managed=true',
      '--format', '{{.Names}}',
    ]);
    if (exitCode !== 0 || !stdout.trim()) return;
    const names = stdout.trim().split('\n').map(n => n.trim()).filter(Boolean);
    if (names.length === 0) return;
    // Best-effort: ignore errors for individual containers
    await run('docker', ['rm', '-f', ...names]).catch(() => {});
  }

  async execute(request: ExecutionRequest, config: CSEConfig): Promise<ExecutionResult> {
    const executionId = randomUUID();
    const workDir = join(tmpdir(), `cse_${executionId}`);
    const outputDir = join(workDir, 'output');
    const lang = request.language ?? 'python';
    const ext = languageExt(lang);
    const codeFile = join(workDir, `code.${ext}`);

    try {
      await mkdir(workDir, { recursive: true });
      await mkdir(outputDir, { recursive: true });

      // Write code
      await writeFile(codeFile, request.code, 'utf8');

      // Write injected files
      if (request.files) {
        for (const f of request.files) {
          const dest = join(workDir, f.name);
          await writeFile(dest, f.binary ? Buffer.from(f.content, 'base64') : f.content);
        }
      }

      const image = request.withBrowser
        ? (config.browserImage ?? DEFAULT_BROWSER_IMAGE)
        : (config.executionImage ?? DEFAULT_EXECUTION_IMAGE);

      const timeoutMs = request.timeoutMs ?? config.timeoutMs ?? 30_000;
      const memoryMb = config.memoryMb ?? 512;
      const cpuCount = config.cpuCount ?? 1;
      const networkMode = (request.networkAccess ?? config.networkAccess) ? 'bridge' : 'none';

      const dockerArgs = [
        'run',
        '--rm',
        '--name', `cse_${executionId}`,
        '--network', networkMode,
        `--memory=${memoryMb}m`,
        `--memory-swap=${memoryMb}m`,     // disable swap
        `--cpus=${cpuCount}`,
        '--user=65534',                    // nobody
        '--cap-drop=ALL',
        '--security-opt', 'no-new-privileges',
        '--read-only',
        '--tmpfs', '/tmp:size=100m,noexec,nosuid',
        '--tmpfs', '/nonexistent:size=200m,nosuid,uid=65534,gid=65534,mode=1777',
        // Mount workspace read-only, output dir read-write
        '-v', `${workDir}:/workspace:ro`,
        '-v', `${outputDir}:/workspace/output:rw`,
      ];

      appendContainerEnvArgs(dockerArgs, pythonContainerEnv('/tmp'));

      // Inject env vars
      if (request.env) {
        for (const [k, v] of Object.entries(request.env)) {
          // Only allow alphanumeric keys (OWASP: prevent injection via env key names)
          if (/^[A-Z_][A-Z0-9_]*$/i.test(k)) {
            dockerArgs.push('-e', `${k}=${v}`);
          }
        }
      }

      const runCmd = buildRunCommand(lang);
      dockerArgs.push(image, ...runCmd);

      const result = await run('docker', dockerArgs, { timeoutMs: timeoutMs + 2_000 });
      const artifacts = await collectArtifacts(outputDir);

      return {
        executionId,
        status: result.exitCode === 0 ? 'success' : result.exitCode === 137 ? 'killed' : 'error',
        stdout: result.stdout.slice(0, 100_000),
        stderr: result.stderr.slice(0, 20_000),
        output: result.exitCode === 0 ? tryParseOutput(result.stdout) : undefined,
        error: result.exitCode !== 0 ? result.stderr.slice(0, 2_000) || `Exit code ${result.exitCode}` : undefined,
        artifacts,
        durationMs: result.durationMs,
        providerInfo: { provider: 'local', containerId: `cse_${executionId}` },
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  async createSession(chatId: string, config: CSEConfig, withBrowser: boolean): Promise<CSESession> {
    const sessionId = randomUUID();
    const containerName = `cse_session_${sessionId.slice(0, 8)}`;
    const image = withBrowser
      ? (config.browserImage ?? DEFAULT_BROWSER_IMAGE)
      : (config.executionImage ?? DEFAULT_EXECUTION_IMAGE);

    const memoryMb = config.memoryMb ?? 512;
    const cpuCount = config.cpuCount ?? 1;
    const networkMode = config.networkAccess ? 'bridge' : 'none';

    const dockerArgs = [
      'run', '-d',
      '--name', containerName,
      '--network', networkMode,
      `--memory=${memoryMb}m`,
      `--memory-swap=${memoryMb}m`,
      `--cpus=${cpuCount}`,
      '--user=65534',
      '--cap-drop=ALL',
      '--security-opt', 'no-new-privileges',
      '--tmpfs', '/tmp:size=100m,noexec,nosuid',
      '--tmpfs', '/nonexistent:size=200m,nosuid,uid=65534,gid=65534,mode=1777',
      '--tmpfs', '/workspace:size=1g,exec,nosuid,uid=65534,gid=65534,mode=1777',
      '--label', `cse.created=${Date.now()}`,
      '--label', 'cse.managed=true',
    ];

    appendContainerEnvArgs(dockerArgs, {
      ...pythonContainerEnv('/workspace'),
      PATH: '/workspace/.pyuser/bin:/usr/local/bin:/usr/bin:/bin',
    });

    dockerArgs.push(
      image,
      // Use a finite max lifetime instead of sleep infinity.
      // Even if the server crashes and forgets about this container,
      // it will self-destruct after maxLifetimeSec seconds.
      // Configurable via CSE_SESSION_MAX_LIFETIME_S (default 3600 = 1 hour).
      'sleep', String(Number(process.env['CSE_SESSION_MAX_LIFETIME_S'] ?? 3600)),
    );

    const { exitCode, stderr } = await run('docker', dockerArgs);
    if (exitCode !== 0) throw new Error(`Failed to create session container: ${stderr}`);

    const workspaceInit = await run('docker', [
      'exec',
      containerName,
      'sh',
      '-lc',
      'mkdir -p /workspace/output /workspace/.pyuser /workspace/.cache /workspace/.mplconfig && chmod 1777 /workspace /workspace/output /workspace/.pyuser /workspace/.cache /workspace/.mplconfig',
    ]);
    if (workspaceInit.exitCode !== 0) {
      await run('docker', ['rm', '-f', containerName]);
      throw new Error(`Failed to initialize session workspace: ${workspaceInit.stderr}`);
    }

    return {
      sessionId,
      chatId,
      provider: 'local',
      executionImage: image,
      handle: containerName,
      status: 'ready',
      hasBrowser: withBrowser,
      networkAccess: config.networkAccess ?? false,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      executionCount: 0,
    };
  }

  async executeInSession(
    session: CSESession,
    request: ExecutionRequest,
    config: CSEConfig,
  ): Promise<ExecutionResult> {
    const executionId = randomUUID();
    const lang = request.language ?? 'python';
    const ext = languageExt(lang);
    const remoteCode = `/workspace/code_${executionId}.${ext}`;
    const timeoutMs = request.timeoutMs ?? config.timeoutMs ?? 30_000;
    const execEnvArgs = dockerExecEnvArgs({
      ...pythonContainerEnv('/workspace'),
      PATH: '/workspace/.pyuser/bin:/usr/local/bin:/usr/bin:/bin',
    });

    // Write code file into the running container via stdin pipe
    const writeResult = await run('docker', [
      'exec', '-i', ...execEnvArgs, session.handle,
      'sh', '-c', `cat > ${remoteCode}`,
    ], { stdin: request.code });

    if (writeResult.exitCode !== 0) {
      return {
        executionId,
        sessionId: session.sessionId,
        status: 'error',
        stdout: '',
        stderr: writeResult.stderr,
        error: 'Failed to write code to session container',
        artifacts: [],
        durationMs: writeResult.durationMs,
        providerInfo: { provider: 'local', containerId: session.handle },
      };
    }

    // Write injected files into the running session container under /workspace.
    if (request.files) {
      for (const file of request.files) {
        const fileName = sanitizeWorkspaceFileName(file.name);
        const remotePath = `/workspace/${fileName}`;
        const writeFileResult = await run('docker', [
          'exec', '-i', ...execEnvArgs, session.handle,
          'sh', '-c', `cat > ${remotePath}`,
        ], {
          stdin: file.binary ? Buffer.from(file.content, 'base64') : file.content,
        });

        if (writeFileResult.exitCode !== 0) {
          return {
            executionId,
            sessionId: session.sessionId,
            status: 'error',
            stdout: '',
            stderr: writeFileResult.stderr,
            error: `Failed to write injected file to session container: ${fileName}`,
            artifacts: [],
            durationMs: writeFileResult.durationMs,
            providerInfo: { provider: 'local', containerId: session.handle },
          };
        }
      }
    }

    // Build exec command
    const runCmd = buildRunCommand(lang).map((p) => (p.includes('code.py') || p.includes('code.js') || p.includes('code.sh') || p.includes('code.ts') ? remoteCode : p));

    const start = Date.now();
    const execResult = await run('docker', [
      'exec', '-w', '/workspace', ...execEnvArgs, session.handle,
      ...runCmd,
    ], { timeoutMs });

    const artifacts = await this.collectArtifactsFromSession(session, execEnvArgs);

    // Cleanup code file
    await run('docker', ['exec', session.handle, 'rm', '-f', remoteCode]);

    return {
      executionId,
      sessionId: session.sessionId,
      status: execResult.exitCode === 0 ? 'success' : 'error',
      stdout: execResult.stdout.slice(0, 100_000),
      stderr: execResult.stderr.slice(0, 20_000),
      output: execResult.exitCode === 0 ? tryParseOutput(execResult.stdout) : undefined,
      error: execResult.exitCode !== 0 ? execResult.stderr.slice(0, 2_000) || `Exit ${execResult.exitCode}` : undefined,
      artifacts,
      durationMs: Date.now() - start,
      providerInfo: { provider: 'local', containerId: session.handle },
    };
  }

  private async collectArtifactsFromSession(
    session: CSESession,
    execEnvArgs: string[],
  ): Promise<ExecutionResult['artifacts']> {
    const extractScript = [
      'import base64, json, os',
      'root = "/workspace/output"',
      'artifacts = []',
      'if os.path.isdir(root):',
      '  for name in os.listdir(root):',
      '    path = os.path.join(root, name)',
      '    if not os.path.isfile(path):',
      '      continue',
      '    with open(path, "rb") as f:',
      '      data = f.read()',
      '    artifacts.append({',
      '      "name": name,',
      '      "data": base64.b64encode(data).decode("ascii"),',
      '      "sizeBytes": len(data),',
      '    })',
      'print(json.dumps(artifacts))',
    ].join('\n');

    const extractResult = await run('docker', [
      'exec', ...execEnvArgs, session.handle,
      'python', '-c', extractScript,
    ]);

    if (extractResult.exitCode !== 0 || !extractResult.stdout.trim()) {
      return [];
    }

    type SessionArtifact = { name: string; data: string; sizeBytes: number };
    let parsed: SessionArtifact[] = [];

    try {
      parsed = JSON.parse(extractResult.stdout) as SessionArtifact[];
    } catch {
      return [];
    }

    const artifacts: ExecutionResult['artifacts'] = [];
    for (const artifact of parsed) {
      const safeName = sanitizeWorkspaceFileName(artifact.name);
      artifacts.push({
        name: safeName,
        mimeType: guessMime(safeName),
        data: artifact.data,
        sizeBytes: Number.isFinite(artifact.sizeBytes) ? artifact.sizeBytes : 0,
      });
    }
    return artifacts;
  }

  async terminateSession(session: CSESession, _config: CSEConfig): Promise<void> {
    await run('docker', ['rm', '-f', session.handle]);
  }

  async healthCheck(_config: CSEConfig): Promise<CSEHealthStatus> {
    const { exitCode, stderr } = await run('docker', ['info', '--format', '{{.ServerVersion}}']);
    return {
      provider: 'local',
      healthy: exitCode === 0,
      error: exitCode !== 0 ? stderr.trim() : undefined,
    };
  }
}
