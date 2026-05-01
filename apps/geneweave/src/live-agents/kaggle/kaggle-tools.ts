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
  type ToolRegistry,
} from '@weaveintel/core';
import type { KaggleAdapter, KaggleCredentials } from '@weaveintel/tools-kaggle';

export interface KaggleToolsOptions {
  adapter: KaggleAdapter;
  credentials: KaggleCredentials;
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

export function createKaggleTools(opts: KaggleToolsOptions): ToolRegistry {
  const { adapter, credentials } = opts;
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
        const list = await adapter.listCompetitions(credentials, { page, search });
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
        const c = await adapter.getCompetition(credentials, ref);
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
        const files = await adapter.listCompetitionFiles(credentials, ref);
        return JSON.stringify(files, null, 2);
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
        const username = credentials.username;
        const result = await adapter.pushKernel(credentials, {
          slug: `${username}/${slug}`,
          title,
          language: 'python',
          kernelType: 'script',
          isPrivate: true,
          enableGpu: false,
          enableInternet: false,
          competitionSource: competitionRef,
          source: code,
        });
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
        const status = await adapter.getKernelStatus(credentials, ref);
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
        const timeoutMs = Math.min(((args['timeoutSeconds'] as number | undefined) ?? 300), 600) * 1000;
        const intervalMs = Math.max(((args['pollIntervalSeconds'] as number | undefined) ?? 10), 5) * 1000;
        const deadline = Date.now() + timeoutMs;
        const terminal = new Set(['complete', 'error', 'cancelAcknowledged', 'cancelRequested']);
        let last: unknown = null;
        while (Date.now() < deadline) {
          const status = await adapter.getKernelStatus(credentials, ref);
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
        const out = await adapter.getKernelOutput(credentials, ref);
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
        const HEAD = 4000;
        const TAIL = 4000;
        const display = log.length > HEAD + TAIL + 200
          ? `${log.slice(0, HEAD)}\n\n...[${log.length - HEAD - TAIL} chars truncated]...\n\n${log.slice(-TAIL)}`
          : log;
        return JSON.stringify({ ...(out as object), log: display }, null, 2);
      },
    }),
  );

  return reg;
}
