/**
 * GeneWeave — Kaggle Live Competition Runs UI (M21)
 *
 * Custom admin view for the `kgl_competition_run` table. Lists runs and, on
 * row click, shows the full pipeline timeline (steps + events) for the
 * selected run end-to-end.
 *
 * Rendered when admin tab schema has customView = 'kaggle-competition-runs'.
 */

import { h } from './dom.js';
import { api } from './api.js';
import type {
  KglCompetitionRunRow,
  KglRunStepRow,
  KglRunEventRow,
} from '../db-types.js';

interface RunsState {
  loading: boolean;
  error: string | null;
  runs: KglCompetitionRunRow[];
  selectedRunId: string | null;
  detailLoading: boolean;
  detailError: string | null;
  run: KglCompetitionRunRow | null;
  steps: KglRunStepRow[];
  events: KglRunEventRow[];
}

const runsState: RunsState = {
  loading: false,
  error: null,
  runs: [],
  selectedRunId: null,
  detailLoading: false,
  detailError: null,
  run: null,
  steps: [],
  events: [],
};

const STATUS_COLOR: Record<string, string> = {
  queued: '#6b7280',
  running: '#2563eb',
  completed: '#16a34a',
  abandoned: '#9ca3af',
  failed: '#dc2626',
};

function statusBadge(status: string): HTMLElement {
  const color = STATUS_COLOR[status] ?? '#6b7280';
  return h('span', {
    style: `display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff;background:${color};`,
  }, status);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function durationMs(startIso: string | null, endIso: string | null): string {
  if (!startIso) return '—';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

async function loadRuns(render: () => void): Promise<void> {
  runsState.loading = true;
  runsState.error = null;
  render();
  try {
    const resp = await api.get('/api/admin/kaggle-competition-runs?limit=200');
    const data = await resp.json() as { 'kaggle-competition-runs'?: KglCompetitionRunRow[] };
    runsState.runs = data['kaggle-competition-runs'] ?? [];
  } catch (err) {
    runsState.error = `Failed to load runs: ${(err as Error).message}`;
  }
  runsState.loading = false;
  render();
}

async function loadRunDetail(runId: string, render: () => void): Promise<void> {
  runsState.selectedRunId = runId;
  runsState.detailLoading = true;
  runsState.detailError = null;
  runsState.run = null;
  runsState.steps = [];
  runsState.events = [];
  render();
  try {
    const resp = await api.get(`/api/admin/kaggle-competition-runs/${encodeURIComponent(runId)}`);
    const data = await resp.json() as {
      'kaggle-competition-run'?: KglCompetitionRunRow;
      steps?: KglRunStepRow[];
      events?: KglRunEventRow[];
    };
    runsState.run = data['kaggle-competition-run'] ?? null;
    runsState.steps = (data.steps ?? []).slice().sort((a, b) => a.step_index - b.step_index);
    runsState.events = (data.events ?? []).slice().sort((a, b) =>
      (a.created_at ?? '').localeCompare(b.created_at ?? ''),
    );
  } catch (err) {
    runsState.detailError = `Failed to load run: ${(err as Error).message}`;
  }
  runsState.detailLoading = false;
  render();
}

function renderRunRow(run: KglCompetitionRunRow, render: () => void): HTMLElement {
  const isSelected = runsState.selectedRunId === run.id;
  return h('tr', {
    style: `cursor:pointer;background:${isSelected ? 'var(--accent-bg, #eef4ff)' : 'transparent'};`,
    onclick: () => { void loadRunDetail(run.id, render); },
  },
    h('td', { style: 'padding:6px 8px;font-size:12px;' }, run.title || run.competition_ref),
    h('td', { style: 'padding:6px 8px;' }, statusBadge(run.status)),
    h('td', { style: 'padding:6px 8px;font-size:11px;color:var(--fg2);font-family:monospace;' },
      run.competition_ref.replace(/^https?:\/\/(?:www\.)?kaggle\.com\/competitions\//, '')),
    h('td', { style: 'padding:6px 8px;font-size:12px;text-align:right;' }, String(run.step_count ?? 0)),
    h('td', { style: 'padding:6px 8px;font-size:12px;text-align:right;' }, String(run.event_count ?? 0)),
    h('td', { style: 'padding:6px 8px;font-size:11px;color:var(--fg2);' }, fmtDate(run.started_at)),
    h('td', { style: 'padding:6px 8px;font-size:11px;color:var(--fg2);' }, durationMs(run.started_at, run.completed_at)),
  );
}

function renderRunsList(render: () => void): HTMLElement {
  if (runsState.loading) {
    return h('div', { style: 'padding:12px;color:var(--fg2);font-size:13px;' }, 'Loading runs…');
  }
  if (runsState.error) {
    return h('div', { style: 'padding:12px;color:#dc2626;font-size:13px;' }, runsState.error);
  }
  if (runsState.runs.length === 0) {
    return h('div', { style: 'padding:24px;color:var(--fg2);font-size:13px;text-align:center;' },
      'No live competition runs yet. Click ▶ Start Live Run on a Tracked Competition to launch one.');
  }
  return h('div', { style: 'overflow:auto;border:1px solid var(--border1);border-radius:6px;' },
    h('table', { style: 'width:100%;border-collapse:collapse;font-size:12px;' },
      h('thead', { style: 'background:var(--bg2);' },
        h('tr', {},
          h('th', { style: 'text-align:left;padding:8px;font-weight:600;border-bottom:1px solid var(--border1);' }, 'Title'),
          h('th', { style: 'text-align:left;padding:8px;font-weight:600;border-bottom:1px solid var(--border1);' }, 'Status'),
          h('th', { style: 'text-align:left;padding:8px;font-weight:600;border-bottom:1px solid var(--border1);' }, 'Competition'),
          h('th', { style: 'text-align:right;padding:8px;font-weight:600;border-bottom:1px solid var(--border1);' }, 'Steps'),
          h('th', { style: 'text-align:right;padding:8px;font-weight:600;border-bottom:1px solid var(--border1);' }, 'Events'),
          h('th', { style: 'text-align:left;padding:8px;font-weight:600;border-bottom:1px solid var(--border1);' }, 'Started'),
          h('th', { style: 'text-align:left;padding:8px;font-weight:600;border-bottom:1px solid var(--border1);' }, 'Duration'),
        )
      ),
      h('tbody', {}, ...runsState.runs.map(r => renderRunRow(r, render))),
    ),
  );
}

function renderStepCard(step: KglRunStepRow, events: KglRunEventRow[]): HTMLElement {
  const stepEvents = events.filter(e => e.step_id === step.id);
  const color = STATUS_COLOR[step.status] ?? '#6b7280';
  return h('div', {
    style: `border-left:3px solid ${color};padding:10px 12px;margin-bottom:10px;background:var(--bg2);border-radius:4px;`,
  },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;' },
      h('div', { style: 'flex:1;' },
        h('span', { style: 'font-size:11px;color:var(--fg2);margin-right:8px;' }, `Step ${step.step_index + 1}`),
        h('span', { style: 'font-size:13px;font-weight:600;' }, step.title),
      ),
      statusBadge(step.status),
    ),
    h('div', { style: 'font-size:11px;color:var(--fg2);margin-bottom:6px;' },
      `Role: ${step.role}`,
      step.agent_id ? ` · Agent: ${step.agent_id}` : '',
    ),
    step.description ? h('div', { style: 'font-size:12px;color:var(--fg1);margin-bottom:6px;' }, step.description) : null,
    step.summary ? h('div', { style: 'font-size:12px;color:var(--fg1);margin-bottom:6px;font-style:italic;' }, step.summary) : null,
    h('div', { style: 'display:flex;gap:12px;font-size:11px;color:var(--fg2);' },
      h('span', {}, `Started: ${fmtDate(step.started_at)}`),
      h('span', {}, `Completed: ${fmtDate(step.completed_at)}`),
      step.started_at ? h('span', {}, `Duration: ${durationMs(step.started_at, step.completed_at)}`) : null,
    ),
    stepEvents.length > 0 ? h('div', { style: 'margin-top:8px;padding-top:8px;border-top:1px dashed var(--border1);' },
      h('div', { style: 'font-size:11px;color:var(--fg2);margin-bottom:4px;' }, `${stepEvents.length} event(s)`),
      ...stepEvents.map(ev => renderEventLine(ev)),
    ) : null,
  );
}

function renderEventLine(ev: KglRunEventRow): HTMLElement {
  return h('div', { style: 'font-size:11px;padding:3px 0;display:flex;gap:8px;align-items:flex-start;' },
    h('span', { style: 'color:var(--fg2);font-family:monospace;min-width:88px;' },
      ev.created_at ? new Date(ev.created_at).toLocaleTimeString() : ''),
    h('span', { style: 'color:#2563eb;font-weight:600;min-width:120px;' }, ev.kind),
    h('span', { style: 'color:var(--fg1);flex:1;' }, ev.summary),
  );
}

function renderRunDetail(render: () => void): HTMLElement {
  if (!runsState.selectedRunId) {
    return h('div', { style: 'padding:24px;color:var(--fg2);font-size:13px;text-align:center;border:1px dashed var(--border1);border-radius:6px;' },
      'Select a run above to see its full pipeline flow, step status, and event timeline.');
  }
  if (runsState.detailLoading) {
    return h('div', { style: 'padding:12px;color:var(--fg2);font-size:13px;' }, 'Loading run detail…');
  }
  if (runsState.detailError) {
    return h('div', { style: 'padding:12px;color:#dc2626;font-size:13px;' }, runsState.detailError);
  }
  const run = runsState.run;
  if (!run) return h('div', {}, '');

  const orphanEvents = runsState.events.filter(e => !e.step_id);

  return h('div', { style: 'border:1px solid var(--border1);border-radius:6px;padding:14px;background:var(--bg1);' },
    // Header
    h('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;gap:12px;' },
      h('div', { style: 'flex:1;' },
        h('h3', { style: 'margin:0 0 4px;font-size:15px;' }, run.title || run.competition_ref),
        h('div', { style: 'font-size:11px;color:var(--fg2);font-family:monospace;' }, `Run ID: ${run.id}`),
        h('div', { style: 'font-size:11px;color:var(--fg2);font-family:monospace;' }, `Competition: ${run.competition_ref}`),
        run.mesh_id ? h('div', { style: 'font-size:11px;color:var(--fg2);font-family:monospace;' }, `Mesh: ${run.mesh_id}`) : null,
      ),
      h('div', { style: 'text-align:right;' },
        statusBadge(run.status),
        h('div', { style: 'font-size:11px;color:var(--fg2);margin-top:6px;' },
          `${run.step_count ?? 0} steps · ${run.event_count ?? 0} events`),
        h('div', { style: 'font-size:11px;color:var(--fg2);margin-top:2px;' },
          `Started: ${fmtDate(run.started_at)}`),
        run.completed_at ? h('div', { style: 'font-size:11px;color:var(--fg2);margin-top:2px;' },
          `Completed: ${fmtDate(run.completed_at)}`) : null,
        h('button', {
          style: 'margin-top:8px;padding:4px 10px;font-size:11px;cursor:pointer;border:1px solid var(--border1);background:var(--bg2);border-radius:4px;',
          onclick: () => { void loadRunDetail(run.id, render); },
        }, '↻ Refresh'),
      ),
    ),
    run.objective ? h('div', { style: 'padding:8px 10px;background:var(--bg2);border-radius:4px;font-size:12px;margin-bottom:12px;' },
      h('div', { style: 'font-size:10px;color:var(--fg2);margin-bottom:2px;text-transform:uppercase;letter-spacing:0.5px;' }, 'Objective'),
      run.objective,
    ) : null,
    run.summary ? h('div', { style: `padding:8px 10px;border-radius:4px;font-size:12px;margin-bottom:12px;background:${run.status === 'failed' ? '#fee2e2' : 'var(--bg2)'};color:${run.status === 'failed' ? '#991b1b' : 'var(--fg1)'};` },
      h('div', { style: 'font-size:10px;margin-bottom:2px;text-transform:uppercase;letter-spacing:0.5px;opacity:0.7;' },
        run.status === 'failed' ? 'Failure Reason' : 'Summary'),
      run.summary,
    ) : null,

    // Steps timeline
    h('h4', { style: 'margin:16px 0 8px;font-size:13px;color:var(--fg2);text-transform:uppercase;letter-spacing:0.5px;' }, 'Pipeline Steps'),
    runsState.steps.length === 0
      ? h('div', { style: 'font-size:12px;color:var(--fg2);font-style:italic;' }, 'No steps recorded.')
      : h('div', {}, ...runsState.steps.map(s => renderStepCard(s, runsState.events))),

    // Run-level (orphan) events
    orphanEvents.length > 0 ? h('div', { style: 'margin-top:16px;' },
      h('h4', { style: 'margin:0 0 8px;font-size:13px;color:var(--fg2);text-transform:uppercase;letter-spacing:0.5px;' },
        `Run-Level Events (${orphanEvents.length})`),
      h('div', { style: 'background:var(--bg2);padding:10px;border-radius:4px;' },
        ...orphanEvents.map(ev => renderEventLine(ev)),
      ),
    ) : null,
  );
}

export function renderKglCompetitionRunsView(options: { render: () => void }): HTMLElement {
  const { render } = options;

  if (runsState.runs.length === 0 && !runsState.loading && !runsState.error) {
    void loadRuns(render);
  }

  return h('div', { style: 'max-width:1200px;display:flex;flex-direction:column;gap:14px;' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;' },
      h('div', {},
        h('h3', { style: 'margin:0 0 2px;font-size:16px;' }, 'Live Competition Runs'),
        h('p', { style: 'margin:0;font-size:12px;color:var(--fg2);' },
          'Top-level live-agent mesh runs created by ▶ Start Live Run. Click a row to see the full pipeline flow end-to-end.'),
      ),
      h('button', {
        style: 'padding:6px 12px;font-size:12px;cursor:pointer;border:1px solid var(--border1);background:var(--bg2);border-radius:4px;',
        onclick: () => { void loadRuns(render); },
      }, '↻ Refresh List'),
    ),
    renderRunsList(render),
    renderRunDetail(render),
  );
}
