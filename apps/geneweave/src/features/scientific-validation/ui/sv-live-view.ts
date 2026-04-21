/**
 * Scientific Validation — Live Deliberation View
 *
 * Streams evidence events and agent-dialogue turns via SSE as the
 * multi-agent workflow runs. When the run reaches a terminal status
 * ('verdict' or 'abandoned') it transitions to the verdict view.
 */
import { h } from '../../../ui/dom.js';
import { state } from '../../../ui/state.js';

// ── SSE stream helpers ───────────────────────────────────────────────────────

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
  citesEvidenceIds?: string[];
}

interface VerdictEvent {
  verdictId: string;
  verdict: string;
  confidenceLo: number;
  confidenceHi: number;
}

const AGENT_EMOJI: Record<string, string> = {
  decomposer: '🧩',
  literature: '📚',
  statistical: '📊',
  mathematical: '∑',
  simulation: '🔬',
  adversarial: '🧐',
  supervisor: '🧠',
};

function agentLabel(id: string): string {
  return id.replace(/^sv-/, '').replace(/-/g, ' ');
}

function kindBadge(kind: string): HTMLElement {
  const colours: Record<string, string> = {
    supports: '#059669', refutes: '#dc2626', neutral: '#6b7280', inconclusive: '#d97706',
  };
  const bg = colours[kind] ?? '#6b7280';
  return h('span', {
    style: `font-size:10px;font-weight:700;color:white;background:${bg};border-radius:4px;padding:2px 7px;letter-spacing:.04em;text-transform:uppercase`,
  }, kind);
}

// ── Component ────────────────────────────────────────────────────────────────

export function renderSVLiveView(options: { render: () => void }): HTMLElement {
  const { render } = options;
  const hypothesisId = (state as any).svHypothesisId as string | null;

  if (!hypothesisId) {
    return h('div', { className: 'dash-view' },
      h('p', { style: 'color:var(--fg3)' }, 'No hypothesis selected.')
    );
  }

  const eventsEl = h('div', {
    style: 'display:flex;flex-direction:column;gap:10px;max-height:380px;overflow-y:auto',
  });
  const turnsEl = h('div', {
    style: 'display:flex;flex-direction:column;gap:8px;max-height:380px;overflow-y:auto',
  });
  const statusEl = h('div', {
    style: 'font-size:13px;color:var(--fg3);margin-bottom:8px',
  }, 'Connecting…');

  // ── Poll hypothesis status ───────────────────────────────────────────────
  let statusPoll: ReturnType<typeof setInterval> | null = null;
  let evidenceES: EventSource | null = null;
  let dialogueES: EventSource | null = null;

  function startStreams() {
    // Evidence stream
    evidenceES = new EventSource(`/api/sv/hypotheses/${hypothesisId}/events`, { withCredentials: true });
    evidenceES.addEventListener('evidence', (e: MessageEvent) => {
      const ev = JSON.parse(e.data) as EvidenceEvent;
      const icon = h('span', { style: 'font-size:16px;flex-shrink:0' },
        AGENT_EMOJI[agentLabel(ev.agentId)] ?? '🔬'
      );
      const item = h('div', {
        style: 'display:flex;gap:10px;align-items:flex-start;background:var(--bg2);border:1px solid var(--bg4);border-radius:10px;padding:10px 12px',
      },
        icon,
        h('div', { style: 'flex:1;min-width:0' },
          h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:4px' },
            h('span', { style: 'font-size:12px;font-weight:600;color:var(--fg2)' }, agentLabel(ev.agentId)),
            h('span', { style: 'font-size:11px;color:var(--fg3)' }, ev.stepId),
            kindBadge(ev.kind),
          ),
          h('div', { style: 'font-size:13px;color:var(--fg)' }, ev.summary),
          ev.toolKey ? h('div', { style: 'font-size:11px;color:var(--fg3);margin-top:3px' }, `Tool: ${ev.toolKey}`) : null,
        ),
      );
      eventsEl.appendChild(item);
      eventsEl.scrollTop = eventsEl.scrollHeight;
    });
    evidenceES.onerror = () => {
      statusEl.textContent = 'Evidence stream closed.';
    };

    // Dialogue stream
    dialogueES = new EventSource(`/api/sv/hypotheses/${hypothesisId}/dialogue`, { withCredentials: true });
    dialogueES.addEventListener('turn', (e: MessageEvent) => {
      const turn = JSON.parse(e.data) as DialogueTurn;
      const item = h('div', {
        style: `display:flex;gap:8px;align-items:flex-start;background:${turn.dissent ? 'rgba(220,38,38,.07)' : 'var(--bg2)'};border:1px solid ${turn.dissent ? 'rgba(220,38,38,.22)' : 'var(--bg4)'};border-radius:10px;padding:9px 12px`,
      },
        h('span', { style: 'font-size:15px;flex-shrink:0' }, AGENT_EMOJI[agentLabel(turn.fromAgent)] ?? '🤖'),
        h('div', { style: 'flex:1;min-width:0' },
          h('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:3px' },
            h('span', { style: 'font-size:12px;font-weight:600;color:var(--fg2)' }, agentLabel(turn.fromAgent)),
            turn.toAgent ? h('span', { style: 'font-size:11px;color:var(--fg3)' }, `→ ${agentLabel(turn.toAgent)}`) : null,
            h('span', { style: 'font-size:10px;color:var(--fg3)' }, `Round ${turn.roundIndex}`),
            turn.dissent ? h('span', { style: 'font-size:10px;color:var(--danger);font-weight:700' }, 'DISSENT') : null,
          ),
          h('div', { style: 'font-size:13px;color:var(--fg);line-height:1.5' }, turn.message),
        ),
      );
      turnsEl.appendChild(item);
      turnsEl.scrollTop = turnsEl.scrollHeight;
    });
    dialogueES.addEventListener('verdict', (e: MessageEvent) => {
      const v = JSON.parse(e.data) as VerdictEvent;
      (state as any).svVerdict = v;
      (state as any).svView = 'verdict';
      cleanup();
      render();
    });
    dialogueES.onerror = () => {
      statusEl.textContent = 'Dialogue stream closed.';
    };
  }

  function cleanup() {
    if (statusPoll) clearInterval(statusPoll);
    if (evidenceES) { evidenceES.close(); evidenceES = null; }
    if (dialogueES) { dialogueES.close(); dialogueES = null; }
  }

  // Poll hypothesis status to detect terminal state even if SSE missed verdict event
  async function pollStatus() {
    try {
      const r = await fetch(`/api/sv/hypotheses/${hypothesisId}`, { credentials: 'include' });
      if (!r.ok) return;
      const data = await r.json() as { hypothesis: { status: string }; verdict: unknown };
      const h2 = data.hypothesis;
      statusEl.textContent = `Status: ${h2.status}`;
      if (h2.status === 'verdict' || h2.status === 'abandoned') {
        (state as any).svHypothesis = data.hypothesis;
        if (data.verdict) (state as any).svVerdict = data.verdict;
        if (h2.status === 'verdict') (state as any).svView = 'verdict';
        cleanup();
        render();
      }
    } catch { /* ignore */ }
  }

  // Kick off streams and polling after DOM is attached
  setTimeout(() => {
    startStreams();
    statusPoll = setInterval(() => { void pollStatus(); }, 4_000);
    void pollStatus();
  }, 100);

  const view = h('div', { className: 'dash-view' },
    h('div', { style: 'max-width:860px;margin:0 auto' },
      h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:24px' },
        h('span', { style: 'font-size:22px' }, '🔬'),
        h('div', null,
          h('h2', { style: 'font-size:20px;font-weight:700;color:var(--fg);margin:0 0 2px' }, 'Live Deliberation'),
          statusEl,
        ),
        h('button', {
          className: 'nav-btn',
          style: 'margin-left:auto',
          onClick: () => {
            (state as any).svView = 'submit';
            cleanup();
            render();
          },
        }, '← Back'),
      ),
      h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:20px' },
        h('div', null,
          h('div', { style: 'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:10px' }, 'Evidence Events'),
          eventsEl,
        ),
        h('div', null,
          h('div', { style: 'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:10px' }, 'Agent Dialogue'),
          turnsEl,
        ),
      ),
    )
  );

  // Cleanup streams when the element is removed from DOM
  const obs = new MutationObserver(() => {
    if (!document.body.contains(view)) {
      cleanup();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  return view;
}
