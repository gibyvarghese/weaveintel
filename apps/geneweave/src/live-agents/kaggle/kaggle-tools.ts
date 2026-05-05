/**
 * Kaggle tools — exposes the live Kaggle adapter as a `weaveAgent` ToolRegistry.
 *
 * These tools let an LLM-driven agent (the Kaggle Strategist) drive the entire
 * competition pipeline through a ReAct loop: discover competitions, inspect
 * one, push kernels, poll status, fetch logs, iterate.
 *
 * Tools intentionally OMIT submission. Submitting to Kaggle is gated on
 * dual-control human approval and is not exposed here.
 */

import {
  weaveToolRegistry as createToolRegistry,
  weaveTool as defineTool,
  type Tool,
  type ToolRegistry,
} from '@weaveintel/core';
import { liveKaggleAdapter, type KaggleAdapter, type KaggleCredentials } from '@weaveintel/tools-kaggle';

/**
 * Resolve Kaggle credentials from KAGGLE_USERNAME / KAGGLE_KEY env vars.
 * Throws a clear error if either is missing. Called lazily at tool-execute
 * time so the kaggle tools can be registered in `tool_catalog` at boot even
 * when the host process has no kaggle creds (e.g. local dev without
 * `.env`). Tools that aren't invoked won't crash.
 */
export function resolveKaggleCredsFromEnv(): KaggleCredentials {
  const username = process.env['KAGGLE_USERNAME'];
  const key = process.env['KAGGLE_KEY'];
  if (!username || !key) {
    throw new Error(
      'Kaggle credentials missing: set KAGGLE_USERNAME and KAGGLE_KEY in env to invoke kaggle_* tools.',
    );
  }
  return { username, key };
}

export interface KaggleToolDefaults {
  /** Default `timeoutSeconds` for `kaggle_wait_for_kernel`. Default 300. */
  defaultWaitTimeoutSec?: number;
  /** Hard cap on `timeoutSeconds`. Default 600. */
  maxWaitTimeoutSec?: number;
  /** Default `pollIntervalSeconds` for `kaggle_wait_for_kernel`. Default 10. */
  defaultPollIntervalSec?: number;
  /** Bytes of head retained in `kaggle_get_kernel_output`. Default 4000. */
  outputHeadBytes?: number;
  /** Bytes of tail retained in `kaggle_get_kernel_output`. Default 4000. */
  outputTailBytes?: number;
}

export interface KaggleToolsOptions {
  /** Override the Kaggle HTTP adapter. Defaults to `liveKaggleAdapter`. */
  adapter?: KaggleAdapter;
  /** Pin credentials. When omitted they are resolved lazily from env on each
   *  tool execution via `resolveKaggleCredsFromEnv()`. */
  credentials?: KaggleCredentials;
  /** Operational defaults sourced from the catch-all (or matched) playbook
   *  config in DB. All fields fall back to the historical hard-coded values
   *  when omitted, so test/example call sites can keep ignoring this. */
  defaults?: KaggleToolDefaults;
}

/** Strip whatever the LLM passed (slug, ref, URL) down to `<owner>/<slug>` or just `<slug>`. */
function normalizeCompetitionRef(value: string): string {
  if (!value) return '';
  const m = value.match(/competitions\/([^/?#]+)/);
  if (m && m[1]) return m[1];
  return value.replace(/^\/+|\/+$/g, '');
}

function normalizeKernelRef(value: string): string {
  if (!value) return '';
  // Kaggle returns `/code/<owner>/<slug>` from push; status/output need `<owner>/<slug>`.
  return value.replace(/^\/+(code\/)?/, '').replace(/\/+$/, '');
}

export function createKaggleTools(opts: KaggleToolsOptions = {}): ToolRegistry {
  const adapter: KaggleAdapter = opts.adapter ?? liveKaggleAdapter;
  const getCreds = (): KaggleCredentials => opts.credentials ?? resolveKaggleCredsFromEnv();
  const defaults = opts.defaults ?? {};
  const defaultWaitTimeoutSec = defaults.defaultWaitTimeoutSec ?? 300;
  const maxWaitTimeoutSec = defaults.maxWaitTimeoutSec ?? 600;
  const defaultPollIntervalSec = defaults.defaultPollIntervalSec ?? 10;
  const outputHeadBytes = defaults.outputHeadBytes ?? 4000;
  const outputTailBytes = defaults.outputTailBytes ?? 4000;
  const reg = createToolRegistry();

  reg.register(
    defineTool({
      name: 'kaggle_list_competitions',
      description:
        'List active Kaggle competitions. Returns up to 20 competitions with id, title, evaluation metric, deadline, and reward. Use to find a competition to work on.',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'number', description: 'Page index (default 1)' },
          search: { type: 'string', description: 'Optional substring search.' },
        },
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const page = (args['page'] as number | undefined) ?? 1;
        const search = args['search'] as string | undefined;
        const list = await adapter.listCompetitions(getCreds(), { page, search });
        return JSON.stringify(
          list.slice(0, 20).map((c) => ({
            id: c.id,
            title: c.title,
            evaluationMetric: c.evaluationMetric,
            deadline: c.deadline,
            reward: c.reward,
            category: c.category,
          })),
          null,
          2,
        );
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_get_competition',
      description:
        'Fetch the full description, evaluation metric, deadline, and metadata of a single Kaggle competition. Always call this once before planning a kernel.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'Competition slug, e.g. arc-prize-2026-arc-agi-3.' } },
        required: ['ref'],
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const ref = normalizeCompetitionRef(args['ref'] as string);
        const c = await adapter.getCompetition(getCreds(), ref);
        return JSON.stringify(c, null, 2);
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_list_competition_files',
      description:
        'List the data files Kaggle will mount at /kaggle/input/<slug>/ for a competition. Returns name, size (bytes), and creationDate.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'Competition slug.' } },
        required: ['ref'],
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const ref = normalizeCompetitionRef(args['ref'] as string);
        const files = await adapter.listCompetitionFiles(getCreds(), ref);
        return JSON.stringify(files, null, 2);
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_get_competition_file',
      description:
        "Download a single small text file (README.md, agents.md, llms.txt, sample_submission.csv/.json/.py, etc.) from a Kaggle competition's data bundle WITHOUT pushing a kernel. Use this in Phase 1 to learn the competition's submission contract — the required filename, format (CSV/JSON/Python script), expected columns, or framework conventions. Returns { fileName, sizeBytes, truncated, binary, content }. Content is truncated at 64 KiB. Binary files return a hex preview only.",
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Competition slug.' },
          fileName: { type: 'string', description: 'Exact file name as returned by kaggle_list_competition_files (e.g. README.md, agents.md, sample_submission.csv).' },
          maxBytes: { type: 'number', description: 'Optional truncation cap. Default 65536.' },
        },
        required: ['ref', 'fileName'],
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const ref = normalizeCompetitionRef(args['ref'] as string);
        const fileName = String(args['fileName'] ?? '').trim();
        if (!fileName) return JSON.stringify({ error: 'fileName is required' });
        const maxBytes = (args['maxBytes'] as number | undefined) ?? 65536;
        try {
          const out = await adapter.downloadCompetitionFile(getCreds(), ref, fileName, { maxBytes });
          return JSON.stringify(out, null, 2);
        } catch (err) {
          return JSON.stringify({
            error: 'download_failed',
            fileName,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_push_kernel',
      description:
        "Create or update a private Python kernel on Kaggle and run it. Provide the full Python source as `code`. The kernel will mount the competition data at /kaggle/input/<slug>/. Returns { kernelRef, kernelUrl } — use kernelRef for status and output calls.",
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Short kebab-case slug for the kernel (3-40 chars).' },
          title: { type: 'string', description: 'Human-readable kernel title.' },
          competitionRef: { type: 'string', description: 'Competition slug to attach as a data source.' },
          code: { type: 'string', description: 'Full Python script to run.' },
        },
        required: ['slug', 'title', 'competitionRef', 'code'],
      },
      tags: ['kaggle', 'write'],
      riskLevel: 'external-side-effect',
      execute: async (args) => {
        const slug = (args['slug'] as string).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
        const title = args['title'] as string;
        const competitionRef = normalizeCompetitionRef(args['competitionRef'] as string);
        const code = args['code'] as string;
        // Guard: refuse empty / trivially-small kernel pushes. The strategist
        // sometimes drops the source string under context-window pressure and
        // ends up pushing zero-byte kernels. Force it to re-emit instead of
        // silently shipping an empty notebook.
        const codeBytes = Buffer.byteLength(code ?? '', 'utf8');
        if (codeBytes < 200) {
          return JSON.stringify({
            error: 'empty_or_tiny_source',
            codeBytes,
            message:
              'kaggle_push_kernel rejected: source code is empty or under 200 bytes. ' +
              'Re-emit the FULL Python script in the `code` argument and call this tool again. ' +
              'Do NOT retry with the same empty source; do NOT change the slug to bypass this check.',
          });
        }
        const creds = getCreds();
        const username = creds.username;
        // Kaggle returns 409 Conflict when a notebook title (or slug) already
        // exists on the account. The strategist often re-uses titles like
        // "ARC-AGI-3 Scout - Iteration 1" across runs, so first try the
        // requested title/slug; if that 409s, retry once with a short
        // timestamp suffix that guarantees uniqueness without losing the
        // operator-facing label.
        const tryPush = async (s: string, t: string) =>
          adapter.pushKernel(creds, {
            slug: `${username}/${s}`,
            title: t,
            language: 'python',
            kernelType: 'script',
            isPrivate: true,
            enableGpu: false,
            enableInternet: false,
            competitionSource: competitionRef,
            source: code,
          });
        let result;
        try {
          result = await tryPush(slug, title);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/\b409\b/.test(msg)) throw err;
          const suffix = `-${Date.now().toString(36).slice(-5)}`;
          const slug2 = `${slug.slice(0, 40 - suffix.length)}${suffix}`;
          const title2 = `${title.slice(0, 50 - suffix.length)}${suffix}`;
          result = await tryPush(slug2, title2);
        }
        return JSON.stringify(
          {
            kernelRef: normalizeKernelRef(result.ref),
            kernelUrl: result.url,
            versionNumber: result.versionNumber,
          },
          null,
          2,
        );
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_get_kernel_status',
      description:
        "Get the current status of a kernel (queued|running|complete|error|cancelRequested|cancelAcknowledged). Use kernelRef from kaggle_push_kernel.",
      parameters: {
        type: 'object',
        properties: { kernelRef: { type: 'string', description: 'owner/slug returned from kaggle_push_kernel.' } },
        required: ['kernelRef'],
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const ref = normalizeKernelRef(args['kernelRef'] as string);
        const status = await adapter.getKernelStatus(getCreds(), ref);
        return JSON.stringify(status, null, 2);
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_wait_for_kernel',
      description:
        'Poll the kernel status until it reaches a terminal state (complete/error/cancelled) or the timeout elapses. Returns the final status object.',
      parameters: {
        type: 'object',
        properties: {
          kernelRef: { type: 'string' },
          timeoutSeconds: { type: 'number', description: 'Max time to wait. Default 300, max 600.' },
          pollIntervalSeconds: { type: 'number', description: 'Poll interval. Default 10.' },
        },
        required: ['kernelRef'],
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const ref = normalizeKernelRef(args['kernelRef'] as string);
        const timeoutMs =
          Math.min(((args['timeoutSeconds'] as number | undefined) ?? defaultWaitTimeoutSec), maxWaitTimeoutSec) * 1000;
        const intervalMs = Math.max(((args['pollIntervalSeconds'] as number | undefined) ?? defaultPollIntervalSec), 5) * 1000;
        const deadline = Date.now() + timeoutMs;
        const terminal = new Set(['complete', 'error', 'cancelAcknowledged', 'cancelRequested']);
        let last: unknown = null;
        while (Date.now() < deadline) {
          const status = await adapter.getKernelStatus(getCreds(), ref);
          last = status;
          const s = (status as { status?: string }).status ?? '';
          if (terminal.has(s)) return JSON.stringify({ ...status, terminal: true }, null, 2);
          await new Promise((r) => setTimeout(r, intervalMs));
        }
        return JSON.stringify({ ...(last as object), terminal: false, timedOut: true }, null, 2);
      },
    }),
  );

  reg.register(
    defineTool({
      name: 'kaggle_get_kernel_output',
      description:
        'Fetch the kernel log and list of output files after it has finished. Returns { logExcerpt, outputFiles[] }.',
      parameters: {
        type: 'object',
        properties: { kernelRef: { type: 'string' } },
        required: ['kernelRef'],
      },
      tags: ['kaggle', 'read'],
      riskLevel: 'read-only',
      execute: async (args) => {
        const ref = normalizeKernelRef(args['kernelRef'] as string);
        const out = await adapter.getKernelOutput(getCreds(), ref);
        // Many kernels print critical info (file inventory, framework READMEs)
        // EARLY in the log and the failure trace LATE. Naive trailing-only
        // truncation drops the inventory. Keep both ends.
        const raw = (out as { log?: string }).log ?? '';
        // Some Kaggle responses return a JSON-array-of-stream-events string;
        // flatten to plain stdout/stderr text first.
        let log = raw;
        if (raw.startsWith('[') && raw.includes('"stream_name"')) {
          try {
            const events = JSON.parse(raw) as Array<{ stream_name?: string; data?: string }>;
            log = events.map((e) => e.data ?? '').join('');
          } catch {
            /* fall back to raw */
          }
        }
        const HEAD = outputHeadBytes;
        const TAIL = outputTailBytes;
        const display = log.length > HEAD + TAIL + 200
          ? `${log.slice(0, HEAD)}\n\n...[${log.length - HEAD - TAIL} chars truncated]...\n\n${log.slice(-TAIL)}`
          : log;
        // Inline the contents of small JSON output files (cv_scores.json,
        // metrics.json, scores.json) so the strategist can read actual CV
        // numbers between iterations instead of just seeing a signed URL with
        // size=0 metadata. Without this, "iterate based on CV" is impossible.
        const outFiles = ((out as { files?: Array<{ fileName?: string; url?: string }> }).files ?? []);
        const inlinedContents: Record<string, unknown> = {};
        const SCORE_FILE_RE = /^(cv_scores?|metrics?|scores?|results?)\.json$/i;
        for (const f of outFiles) {
          const name = f.fileName ?? '';
          const url = f.url ?? '';
          if (!name || !url) continue;
          if (!SCORE_FILE_RE.test(name)) continue;
          try {
            const resp = await fetch(url);
            if (!resp.ok) continue;
            const text = await resp.text();
            if (text.length > 8192) continue;
            try {
              inlinedContents[name] = JSON.parse(text);
            } catch {
              inlinedContents[name] = text;
            }
          } catch {
            /* best-effort; never block the tool call */
          }
        }
        const enriched: Record<string, unknown> = { ...(out as object), log: display };
        if (Object.keys(inlinedContents).length > 0) {
          enriched['inlinedScoreFiles'] = inlinedContents;
        }
        return JSON.stringify(enriched, null, 2);
      },
    }),
  );

  return reg;
}

/**
 * Build a map of kaggle tools keyed by tool name (`kaggle_*`).
 *
 * Used by `BUILTIN_TOOLS` so kaggle tools are visible in `tool_catalog` and
 * can be bound to live-agent definitions via `live_agent_tool_bindings`.
 *
 * Credentials are resolved lazily from `KAGGLE_USERNAME` / `KAGGLE_KEY` at
 * the moment a tool is invoked, so this map can be constructed at startup
 * even if no kaggle creds are configured. Operators can still see the tools
 * in the admin panel and gate them through `tool_policies`.
 */
export function createKaggleToolMap(opts: KaggleToolsOptions = {}): Record<string, Tool> {
  const reg = createKaggleTools(opts);
  const map: Record<string, Tool> = {};
  for (const tool of reg.list()) map[tool.schema.name] = tool;
  return map;
}
