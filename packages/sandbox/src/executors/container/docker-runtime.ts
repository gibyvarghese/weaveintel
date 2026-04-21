/**
 * @weaveintel/sandbox — DockerRuntime
 *
 * Spawns `docker run` with hardened security flags:
 *   --network=none (overridden per image policy allow-list)
 *   --memory=<N>m
 *   --cpus=<N>
 *   --pids-limit=256
 *   --read-only
 *   --tmpfs /tmp
 *   --cap-drop ALL
 *   --security-opt no-new-privileges
 *   --user 65534 (nobody)
 *
 * Stdout and stderr are capped per `spec.limits.stdoutBytes` / `stderrBytes`.
 * Wall-time is enforced with a hard timeout that kills the container.
 * Integration tests are gated behind process.env.CI_DOCKER.
 */

import { spawn } from 'node:child_process';
import type { ContainerRuntime, ContainerRunSpec, ContainerRunResult, WarmSpec } from './types.js';
import { ResourceLimitExceeded } from './errors.js';

export interface DockerRuntimeOptions {
  /** Path to the docker binary. Defaults to 'docker'. */
  dockerBin?: string;
}

/** Builds the `docker run` argv from a ContainerRunSpec. */
function buildDockerArgs(spec: ContainerRunSpec, networkAllowList: string[]): string[] {
  const memoryMB = spec.limits.memoryMB;
  const cpus = (spec.limits.cpuMillis / 1000).toFixed(3);

  const args: string[] = [
    'run',
    '--rm',
    '--interactive',
    '--read-only',
    '--tmpfs', '/tmp',
    '--pids-limit', '256',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '65534',
    '--memory', `${memoryMB}m`,
    '--cpus', cpus,
  ];

  // Network: none by default, configurable per image policy
  if (networkAllowList.length === 0) {
    args.push('--network', 'none');
  }
  // Note: fine-grained network allow-listing requires CNI or iptables rules;
  // in v1 any non-empty networkAllowList enables bridge network. Phase 3 adds
  // CNI-based egress filtering.

  // Environment variables (allow-listed by caller before reaching here)
  if (spec.env) {
    for (const [k, v] of Object.entries(spec.env)) {
      args.push('--env', `${k}=${v}`);
    }
  }

  args.push(spec.imageDigest);

  if (spec.command && spec.command.length > 0) {
    args.push(...spec.command);
  }

  return args;
}

export class DockerRuntime implements ContainerRuntime {
  readonly name = 'docker' as const;
  private readonly dockerBin: string;

  constructor(opts: DockerRuntimeOptions = {}) {
    this.dockerBin = opts.dockerBin ?? 'docker';
  }

  async run(spec: ContainerRunSpec): Promise<ContainerRunResult> {
    const { wallTimeSeconds, stdoutBytes, stderrBytes } = spec.limits;
    const networkAllowList = spec.networkAllowList ?? [];
    const args = buildDockerArgs(spec, networkAllowList);

    const startMs = Date.now();

    return new Promise<ContainerRunResult>((resolve, reject) => {
      const proc = spawn(this.dockerBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      let stdoutBuf = '';
      let stderrBuf = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;

      // Write stdin payload then close
      if (proc.stdin) {
        proc.stdin.write(spec.stdin, 'utf8');
        proc.stdin.end();
      }

      proc.stdout?.on('data', (chunk: Buffer) => {
        const remaining = stdoutBytes - Buffer.byteLength(stdoutBuf, 'utf8');
        if (remaining <= 0) {
          stdoutTruncated = true;
          return;
        }
        const text = chunk.toString('utf8');
        if (Buffer.byteLength(text, 'utf8') > remaining) {
          stdoutBuf += text.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdoutBuf += text;
        }
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const remaining = stderrBytes - Buffer.byteLength(stderrBuf, 'utf8');
        if (remaining <= 0) {
          stderrTruncated = true;
          return;
        }
        const text = chunk.toString('utf8');
        if (Buffer.byteLength(text, 'utf8') > remaining) {
          stderrBuf += text.slice(0, remaining);
          stderrTruncated = true;
        } else {
          stderrBuf += text;
        }
      });

      // Hard wall-time timeout: kill the container
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new ResourceLimitExceeded('wall_time', wallTimeSeconds, 's'));
      }, wallTimeSeconds * 1000);

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        const wallMs = Date.now() - startMs;
        resolve({
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode: code ?? 1,
          wallMs,
          // cpuMs is not reliably available from plain `docker run`; use wallMs as proxy.
          cpuMs: wallMs,
          truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
        });
      });
    });
  }

  async warm(spec: WarmSpec): Promise<void> {
    const { wallTimeSeconds: _w, ..._ } = { wallTimeSeconds: 120 };
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(this.dockerBin, ['pull', spec.imageDigest]);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`docker pull exited with code ${code}`));
      });
      proc.on('error', reject);
    });
  }

  async shutdown(): Promise<void> {
    // No persistent resources to clean up for plain docker run.
  }
}
