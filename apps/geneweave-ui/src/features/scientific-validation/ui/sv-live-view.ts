/**
 * Hypothesis Validation — Live Deliberation View (v2)
 *
 * - api.post() for cancel (CSRF-safe)
 * - api.get() for status polling
 * - Hypothesis header (title, statement, domain tags)
 * - Agent activity tracker showing which agents have produced output
 * - Elapsed time counter
 * - Improved event and turn rendering
 * - Empty state with animated indicator
 */
import { h } from '../../../ui/dom.js';
import { api } from '../../../ui/api.js';
import { state } from '../../../ui/state.js';

interface EvidenceEvent {
  evidenceId: string;
  stepId: string;
  agentId: string;
  kind: string;
  summary: string;
  sourceType?: string;
  toolKey?: string;
}

interface DialogueTurn {
  roundIndex: number;
  fromAgent: string;
  toAgent?: string;
  message: string;
  dissent?: boolean;
}

interface VerdictEvent {
  verdictId: string;
  verdict: string;
  confidenceLo: number;
  confidenceHi: number;
}

const AGENT_META: Record<string, { emoji: string; name: string; color: string; role: string }> = {
  decomposer:   { emoji: '🧩', name: 'Dylan',  color: '#6366f1', role: 'Decomposer' },
  literature:   { emoji: '📚', name: 'Larry',  color: '#0ea5e9', role: 'Literature' },
  statistical:  { emoji: '📊', name: 'Stella', color: '#8b5cf6', role: 'Statistical' },
  mathematical: { emoji: '∑',  name: 'Max',    color: '#d97706', role: 'Mathematical' },
  simulation:   { emoji: '🔬', name: 'Sima',   color: '#14b8a6', role: 'Simulation' },
  adversarial:  { emoji: '⚔️', name: 'Ada',    color: '#ef4444', role: 'Adversarial' },
  supervisor:   { emoji: '🧠', name: 'geneWeave', color: '#059669', role: 'Supervisor' },
};

function agentKey(id: string): string {
  return id.replace(/^sv-/, '').replace(/-/g, '_');
}

function agentInfo(id: string) {
  return AGENT_META[agentKey(id)] ?? { emoji: '🤖', name: id, color: '#6b7280', role: id };
}

const KIND_COLOR: Record<string, string> = {
  tool_call: '#0ea5e9', tool_error: '#ef4444', model_inference: '#8b5cf6',
  supports: '#059669', refutes: '#ef4444', neutral: '#6b7280', inconclusive: '#d97706',
};

function kindPill(kind: string) {
  const color = KIND_COLOR[kind] ?? '#6b7280';
  return h('span', {
    style: `font-size:10px;font-weight:700;color:white;background:${color};border-radius:4px;padding:2px 7px;letter-spacing:.04em;text-transform:uppercase;flex-shrink:0`,
  }, kind.replace(/_/g, ' '));
}

export function renderSVLiveView(options: { render: () => void }): HTMLElement {
  const { render } = options;
  const hypothesisId = (state as any).svHypothesisId as string | null;
  const cachedHyp = (state as any).svHypothesis as { title?: string; statement?: string; domainTags?: string[] } | null;

  if (!hypothesisId) {
    return h('div', { className: 'dash-view' },
      h('div', { style: 'max-width:860px;margin:0 auto;padding-top:40px;text-align:center' },
        h('p', { style: 'color:var(--fg3)' }, 'No hypothesis selected.'),
        h('button', {
          className: 'nav-btn active',
          style: 'margin-top:12px',
          onClick: () => { (state as any).svView = 'submit'; render(); },
        }, '← Back to Submit'),
      )
    );
  }

  // ── Mutable state ─────────────────────────────────────────────────────────
  let statusPoll: ReturnType<typeof setInterval> | null = null;
  let evidenceES: EventSource | null = null;
  let dialogueES: EventSource | null = null;
  let startTime = Date.now();
  let timerHandle: ReturnType<typeof setInterval> | null = null;
  let hypothesisData: { title: string; statement: string; domainTags: string[]; status: string } | null = null;
  const activeAgents = new Set<string>();
  let eventCount = 0;
  let turnCount = 0;

  // ── DOM nodes ─────────────────────────────────────────────────────────────
  const eventsEl = h('div', { style: 'display:flex;flex-direction:column;gap:8px' });
  const turnsEl  = h('div', { style: 'display:flex;flex-direction:column;gap:7px' });
  const statusEl = h('span', { style: 'font-size:12px;color:var(--fg3)' }, 'Connecting…');
  const elapsedEl = h('span', { style: 'font-size:12px;color:var(--fg3);font-variant-numeric:tabular-nums' }, '0:00');
  const agentTrackerEl = h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px' });
  const eventCountEl = h('span', { style: 'font-size:11px;color:var(--fg3);margin-left:4px' }, '');
  const turnCountEl  = h('span', { style: 'font-size:11px;color:var(--fg3);margin-left:4px' }, '');

  // Hypothesis header (populated once loaded)
  const hypTitleEl = h('div', {
    style: 'font-size:16px;font-weight:700;color:var(--fg);margin-bottom:4px',
  }, cachedHyp?.title ?? 'Loading…');
  const hypStatementEl = h('div', {
    style: 'font-size:12px;color:var(--fg3);line-height:1.5;max-height:60px;overflow:hidden;text-overflow:ellipsis',
  }, cachedHyp?.statement ?? '');
  const hypTagsEl = h('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;margin-top:6px' });

  // ── Agent tracker ─────────────────────────────────────────────────────────
  function refreshAgentTracker() {
    while (agentTrackerEl.firstChild) agentTrackerEl.removeChild(agentTrackerEl.firstChild);
    Object.entries(AGENT_META).forEach(([key, meta]) => {
      const active = activeAgents.has(key);
      agentTrackerEl.appendChild(h('div', {
        style: `display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;border:1px solid ${active ? meta.color : 'var(--bg4)'};background:${active ? `${meta.color}18` : 'transparent'};transition:all .3s`,
      },
        h('span', { style: 'font-size:12px' }, meta.emoji),
        h('span', { style: `font-size:11px;font-weight:600;color:${active ? meta.color : 'var(--fg3)'}` }, meta.name),
        active ? h('span', {
          style: `width:6px;height:6px;border-radius:50%;background:${meta.color};animation:sv-pulse 1.2s ease-in-out infinite`,
        }) : null,
      ));
    });
  }
  refreshAgentTracker();

  // ── Elapsed timer ─────────────────────────────────────────────────────────
  function startTimer() {
    startTime = Date.now();
    timerHandle = setInterval(() => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      const m = Math.floor(sec / 60);
      const s = String(sec % 60).padStart(2, '0');
      elapsedEl.textContent = `${m}:${s}`;
    }, 1000);
  }

  // ── Evidence event rendering ──────────────────────────────────────────────
  function appendEvidence(ev: EvidenceEvent) {
    const info = agentInfo(ev.agentId);
    activeAgents.add(agentKey(ev.agentId));
    refreshAgentTracker();
    eventCount++;
    eventCountEl.textContent = `(${eventCount})`;

    const item = h('div', {
      style: 'display:flex;gap:10px;align-items:flex-start;background:var(--bg2);border:1px solid var(--bg4);border-radius:10px;padding:10px 13px;animation:sv-fadein .25s ease-out',
    },
      h('div', {
        style: `width:32px;height:32px;border-radius:8px;background:${info.color}18;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0`,
      }, info.emoji),
      h('div', { style: 'flex:1;min-width:0' },
        h('div', { style: 'display:flex;align-items:center;gap:7px;margin-bottom:4px;flex-wrap:wrap' },
          h('span', { style: `font-size:12px;font-weight:700;color:${info.color}` }, info.name),
          h('span', { style: 'font-size:10px;color:var(--fg3)' }, info.role),
          kindPill(ev.kind),
          ev.toolKey ? h('span', { style: 'font-size:10px;color:var(--fg3);font-family:var(--mono);background:var(--bg3);padding:1px 6px;border-radius:4px' }, ev.toolKey) : null,
        ),
        h('div', { style: 'font-size:12px;color:var(--fg);line-height:1.5' }, ev.summary),
      ),
    );
    eventsEl.appendChild(item);
    eventsEl.scrollTop = eventsEl.scrollHeight;
  }

  // ── Dialogue turn rendering ───────────────────────────────────────────────
  function appendTurn(turn: DialogueTurn) {
    const info = agentInfo(turn.fromAgent);
    activeAgents.add(agentKey(turn.fromAgent));
    refreshAgentTracker();
    turnCount++;
    turnCountEl.textContent = `(${turnCount})`;

    const msg = turn.message.length > 400 ? turn.message.slice(0, 400) + '…' : turn.message;
    const item = h('div', {
      style: `display:flex;gap:9px;align-items:flex-start;background:${turn.dissent ? 'rgba(239,68,68,.06)' : 'var(--bg2)'};border:1px solid ${turn.dissent ? 'rgba(239,68,68,.25)' : 'var(--bg4)'};border-radius:10px;padding:9px 12px;animation:sv-fadein .25s ease-out`,
    },
      h('div', {
        style: `width:28px;height:28px;border-radius:7px;background:${info.color}18;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0`,
      }, info.emoji),
      h('div', { style: 'flex:1;min-width:0' },
        h('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:3px' },
          h('span', { style: `font-size:12px;font-weight:700;color:${info.color}` }, info.name),
          turn.toAgent ? h('span', { style: 'font-size:10px;color:var(--fg3)' }, `→ ${agentInfo(turn.toAgent).name}`) : null,
          h('span', { style: 'font-size:10px;color:var(--fg3)' }, `Round ${turn.roundIndex}`),
          turn.dissent ? h('span', { style: 'font-size:10px;font-weight:700;color:var(--danger);background:rgba(239,68,68,.1);padding:1px 6px;border-radius:4px' }, 'DISSENT') : null,
        ),
        h('div', { style: 'font-size:12px;color:var(--fg);line-height:1.5;white-space:pre-wrap;word-break:break-word' }, msg),
      ),
    );
    turnsEl.appendChild(item);
    turnsEl.scrollTop = turnsEl.scrollHeight;
  }

  // ── Empty state ───────────────────────────────────────────────────────────
  function emptyState(label: string) {
    return h('div', {
      style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:28px 0;gap:10px;color:var(--fg3)',
    },
      h('div', {
        style: 'width:36px;height:36px;border-radius:50%;border:3px solid var(--bg4);border-top-color:var(--accent);animation:sv-spin 1s linear infinite',
      }),
      h('div', { style: 'font-size:12px' }, label),
    );
  }

  eventsEl.appendChild(emptyState('Waiting for evidence…'));
  turnsEl.appendChild(emptyState('Waiting for agent dialogue…'));

  // ── SSE streams ───────────────────────────────────────────────────────────
  function startStreams() {
    evidenceES = new EventSource(`/api/sv/hypotheses/${hypothesisId}/events`, { withCredentials: true });
    let firstEvent = true;
    evidenceES.addEventListener('evidence', (e: MessageEvent) => {
      if (firstEvent) {
        while (eventsEl.firstChild) eventsEl.removeChild(eventsEl.firstChild);
        firstEvent = false;
      }
      appendEvidence(JSON.parse(e.data) as EvidenceEvent);
    });
    evidenceES.onerror = () => { statusEl.textContent = 'Evidence stream closed'; };

    dialogueES = new EventSource(`/api/sv/hypotheses/${hypothesisId}/dialogue`, { withCredentials: true });
    let firstTurn = true;
    dialogueES.addEventListener('turn', (e: MessageEvent) => {
      if (firstTurn) {
        while (turnsEl.firstChild) turnsEl.removeChild(turnsEl.firstChild);
        firstTurn = false;
      }
      appendTurn(JSON.parse(e.data) as DialogueTurn);
    });
    dialogueES.addEventListener('verdict', (e: MessageEvent) => {
      const v = JSON.parse(e.data) as VerdictEvent;
      (state as any).svVerdict = v;
      (state as any).svView = 'verdict';
      cleanup();
      render();
    });
    dialogueES.onerror = () => { statusEl.textContent = 'Dialogue stream closed'; };
  }

  function cleanup() {
    if (statusPoll)  clearInterval(statusPoll);
    if (timerHandle) clearInterval(timerHandle);
    if (evidenceES)  { evidenceES.close();  evidenceES = null; }
    if (dialogueES)  { dialogueES.close(); dialogueES = null; }
  }

  // ── Status polling ────────────────────────────────────────────────────────
  async function pollStatus() {
    try {
      const r = await api.get(`/api/sv/hypotheses/${hypothesisId}`);
      if (!r.ok) return;
      const data = await r.json() as {
        hypothesis: { title: string; statement: string; domainTags: string[]; status: string };
        verdict: { id?: string; verdict?: string } | null;
      };
      const hyp = data.hypothesis;

      // Populate header once
      if (!hypothesisData) {
        hypothesisData = hyp;
        hypTitleEl.textContent = hyp.title;
        hypStatementEl.textContent = hyp.statement;
        while (hypTagsEl.firstChild) hypTagsEl.removeChild(hypTagsEl.firstChild);
        (hyp.domainTags ?? []).forEach(tag => {
          hypTagsEl.appendChild(h('span', {
            style: 'font-size:10px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent)',
          }, tag));
        });
      }

      const statusLabels: Record<string, string> = {
        queued: 'Queued — waiting for agent pool…',
        running: 'Deliberating…',
        verdict: 'Verdict ready',
        abandoned: 'Abandoned',
      };
      statusEl.textContent = statusLabels[hyp.status] ?? hyp.status;

      if (hyp.status === 'verdict' || hyp.status === 'abandoned') {
        (state as any).svHypothesis = hyp;
        if (data.verdict) (state as any).svVerdict = data.verdict;
        (state as any).svView = hyp.status === 'verdict' ? 'verdict' : 'submit';
        if (hyp.status !== 'verdict') (state as any).svHypothesisId = null;
        cleanup();
        render();
      }
    } catch { /* ignore */ }
  }

  // ── Kick off ──────────────────────────────────────────────────────────────
  setTimeout(() => {
    startStreams();
    startTimer();
    statusPoll = setInterval(() => { void pollStatus(); }, 4_000);
    void pollStatus();
  }, 100);

  // ── Layout ────────────────────────────────────────────────────────────────
  const view = h('div', { className: 'dash-view' },
    // Inject animation keyframes once
    h('style', null, `
      @keyframes sv-pulse{0%,100%{opacity:.4;transform:scale(.9)}50%{opacity:1;transform:scale(1.1)}}
      @keyframes sv-spin{to{transform:rotate(360deg)}}
      @keyframes sv-fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
    `),
    h('div', { style: 'max-width:920px;margin:0 auto;padding-bottom:40px' },

      // Page header
      h('div', { style: 'display:flex;align-items:flex-start;gap:14px;margin-bottom:20px' },
        h('div', { style: 'width:40px;height:40px;border-radius:10px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0' }, '🔬'),
        h('div', { style: 'flex:1;min-width:0' },
          hypTitleEl,
          hypStatementEl,
          hypTagsEl,
        ),
        h('div', { style: 'display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0' },
          h('div', { style: 'display:flex;align-items:center;gap:8px' },
            statusEl,
            h('span', { style: 'color:var(--fg3);font-size:12px' }, '·'),
            elapsedEl,
          ),
          h('div', { style: 'display:flex;gap:7px' },
            h('button', {
              className: 'nav-btn',
              style: 'color:var(--danger)',
              onClick: async () => {
                try {
                  await api.post(`/api/sv/hypotheses/${hypothesisId}/cancel`, {});
                } catch { /* ignore */ }
                (state as any).svView = 'submit';
                (state as any).svHypothesisId = null;
                cleanup();
                render();
              },
            }, 'Cancel'),
            h('button', {
              className: 'nav-btn',
              onClick: () => {
                (state as any).svView = 'submit';
                (state as any).svHypothesisId = null;
                cleanup();
                render();
              },
            }, '← Back'),
          ),
        ),
      ),

      // Agent tracker
      h('div', {
        style: 'background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;padding:12px 16px;margin-bottom:18px',
      },
        h('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:8px' }, 'Agent Activity'),
        agentTrackerEl,
      ),

      // Two-column stream panels
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px' },
        // Evidence panel
        h('div', {
          style: 'background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;display:flex;flex-direction:column;overflow:hidden',
        },
          h('div', {
            style: 'padding:10px 14px;border-bottom:1px solid var(--bg4);display:flex;align-items:center;justify-content:space-between',
          },
            h('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3)' }, 'Evidence'),
            eventCountEl,
          ),
          h('div', {
            style: 'flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;max-height:480px',
          }, eventsEl),
        ),

        // Dialogue panel
        h('div', {
          style: 'background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;display:flex;flex-direction:column;overflow:hidden',
        },
          h('div', {
            style: 'padding:10px 14px;border-bottom:1px solid var(--bg4);display:flex;align-items:center;justify-content:space-between',
          },
            h('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3)' }, 'Agent Dialogue'),
            turnCountEl,
          ),
          h('div', {
            style: 'flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:7px;max-height:480px',
          }, turnsEl),
        ),
      ),
    ),
  );

  // Cleanup when removed from DOM
  const obs = new MutationObserver(() => {
    if (!document.body.contains(view)) { cleanup(); obs.disconnect(); }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  return view;
}
