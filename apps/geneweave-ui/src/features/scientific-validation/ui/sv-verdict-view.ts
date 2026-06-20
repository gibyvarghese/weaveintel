/**
 * Hypothesis Validation — Verdict View (v2)
 *
 * - api.get() for all fetches (CSRF-safe)
 * - GRADE quality badge
 * - Bradford Hill score for causal claims
 * - Sub-claim verdicts with individual confidence
 * - Strengths and weaknesses panels
 * - Recommended next steps
 * - Evidence event list (not just counts)
 * - Copy report button
 */
import { h } from '../../../ui/dom.js';
import { api } from '../../../ui/api.js';
import { state } from '../../../ui/state.js';

interface VerdictShape {
  id: string;
  verdict: string;
  confidenceLo: number;
  confidenceHi: number;
  limitations?: string;
  emittedBy?: string;
}

interface SubClaimVerdict {
  subClaimIndex: number;
  verdict: string;
  confidence: number;
  gradeQuality?: string;
}

interface SupervisorJson {
  verdict?: string;
  confidence?: number;
  gradeQuality?: string;
  bradfordHillScore?: number;
  summary?: string;
  subClaimVerdicts?: SubClaimVerdict[];
  strengthsOfEvidence?: string[];
  weaknessesOfEvidence?: string[];
  recommendedNextSteps?: string[];
}

interface SubClaim {
  id: string;
  statement: string;
  claimType: string;
  testabilityScore: number;
  falsificationCriterion?: string;
}

interface EvidenceEvent {
  evidenceId: string;
  kind: string;
  summary: string;
  agentId: string;
  toolKey?: string;
  sourceType?: string;
}

interface BundleData {
  hypothesis: { title: string; statement: string; domainTags?: string[]; traceId?: string };
  verdict: VerdictShape;
  supervisorJson?: SupervisorJson;
  subClaims: SubClaim[];
  evidenceEvents: EvidenceEvent[];
}

const VERDICT_CFG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  supported:   { label: 'Supported',    color: '#059669', bg: 'rgba(5,150,105,.1)',  icon: '✅' },
  refuted:     { label: 'Refuted',      color: '#dc2626', bg: 'rgba(220,38,38,.1)', icon: '❌' },
  inconclusive:{ label: 'Inconclusive', color: '#d97706', bg: 'rgba(217,119,6,.1)', icon: '⚠️' },
  ill_posed:   { label: 'Ill-posed',    color: '#7c3aed', bg: 'rgba(124,58,237,.1)',icon: '🔄' },
  out_of_scope:{ label: 'Out of Scope', color: '#6b7280', bg: 'rgba(107,114,128,.1)',icon: '📭' },
};

const GRADE_CFG: Record<string, { label: string; color: string }> = {
  HIGH:      { label: 'High',      color: '#059669' },
  MODERATE:  { label: 'Moderate',  color: '#d97706' },
  LOW:       { label: 'Low',       color: '#ef4444' },
  VERY_LOW:  { label: 'Very Low',  color: '#dc2626' },
};

const AGENT_EMOJI: Record<string, string> = {
  decomposer: '🧩', literature: '📚', statistical: '📊',
  mathematical: '∑', simulation: '🔬', adversarial: '⚔️', supervisor: '🧠',
};

function agentKey(id: string) { return id.replace(/^sv-/, ''); }

function confidenceBar(lo: number, hi: number, color = 'var(--accent)'): HTMLElement {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const bar = h('div', { style: 'position:relative;height:8px;background:var(--bg4);border-radius:999px;overflow:hidden;margin-top:6px' });
  bar.appendChild(h('div', {
    style: `position:absolute;top:0;bottom:0;left:${pct(Math.max(0, lo))};width:${pct(Math.max(0, hi - lo))};background:${color};border-radius:999px`,
  }));
  return h('div', { style: 'margin-top:4px' },
    bar,
    h('div', { style: 'display:flex;justify-content:space-between;font-size:11px;color:var(--fg3);margin-top:3px' },
      h('span', null, `${Math.round(lo * 100)}%`),
      h('span', null, `CI ${Math.round(lo * 100)}–${Math.round(hi * 100)}%`),
      h('span', null, `${Math.round(hi * 100)}%`),
    ),
  );
}

function section(title: string, children: HTMLElement[]): HTMLElement {
  return h('div', {
    style: 'background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;padding:18px 20px;margin-bottom:14px',
  },
    h('div', { style: 'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:12px' }, title),
    ...children,
  );
}

function verdictPill(v: string): HTMLElement {
  const cfg = VERDICT_CFG[v] ?? VERDICT_CFG['inconclusive']!;
  return h('span', {
    style: `font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;background:${cfg.bg};color:${cfg.color};border:1px solid ${cfg.color}`,
  }, cfg.label);
}

function gradePill(grade: string | undefined): HTMLElement | null {
  if (!grade) return null;
  const gcfg = GRADE_CFG[grade];
  if (!gcfg) return null;
  return h('span', {
    style: `font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:${gcfg.color}18;color:${gcfg.color};border:1px solid ${gcfg.color}`,
    title: 'GRADE evidence quality',
  }, `GRADE: ${gcfg.label}`);
}

export function renderSVVerdictView(options: { render: () => void }): HTMLElement {
  const { render } = options;

  const hypothesisId = (state as any).svHypothesisId as string | null;

  let bundleData: BundleData | null = null;
  let loading = true;
  let loadError = '';
  let supervisorJson: SupervisorJson | null = null;

  const container = h('div', { className: 'dash-view' });

  async function loadBundle() {
    if (!hypothesisId) { loadError = 'No hypothesis selected.'; renderContent(); return; }
    try {
      const hRes = await api.get(`/api/sv/hypotheses/${hypothesisId}`);
      if (!hRes.ok) { loadError = `HTTP ${hRes.status}`; renderContent(); return; }
      const hData = await hRes.json() as {
        hypothesis: { title: string; statement: string; domainTags?: string[]; traceId?: string };
        verdict: VerdictShape | null;
      };

      if (!hData.verdict) { loadError = 'No verdict available yet.'; renderContent(); return; }

      // Try to get the full bundle (may include supervisorJson + evidence)
      const bRes = await api.get(`/api/sv/verdicts/${hData.verdict.id}/bundle`);
      if (bRes.ok) {
        const b = await bRes.json() as BundleData;
        bundleData = b;
        supervisorJson = b.supervisorJson ?? null;
      } else {
        bundleData = {
          hypothesis: hData.hypothesis,
          verdict: hData.verdict,
          subClaims: [],
          evidenceEvents: [],
        };
      }

      // If limitations field looks like JSON (supervisor emitted full JSON), parse it
      if (!supervisorJson && bundleData.verdict.limitations) {
        try {
          const parsed = JSON.parse(bundleData.verdict.limitations) as SupervisorJson;
          if (parsed.verdict) supervisorJson = parsed;
        } catch { /* it's plain text */ }
      }

      loading = false;
    } catch (err: unknown) {
      loadError = err instanceof Error ? err.message : 'Network error';
    }
    renderContent();
  }

  function renderContent() {
    while (container.firstChild) container.removeChild(container.firstChild);

    const inner = h('div', { style: 'max-width:860px;margin:0 auto;padding-bottom:40px' });

    // ── Top bar ─────────────────────────────────────────────────────────────
    inner.appendChild(h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:22px' },
      h('div', { style: 'width:40px;height:40px;border-radius:10px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0' }, '🔬'),
      h('div', { style: 'flex:1;min-width:0' },
        h('h2', { style: 'font-size:20px;font-weight:800;color:var(--fg);margin:0 0 2px' }, bundleData?.hypothesis.title || 'Validation Verdict'),
        h('div', { style: 'font-size:12px;color:var(--fg3)' }, 'Scientific Validation Result'),
      ),
      h('div', { style: 'display:flex;gap:8px;flex-shrink:0' },
        bundleData?.hypothesis.traceId ? h('button', {
          className: 'nav-btn',
          title: 'Copy trace ID',
          onClick: () => {
            void navigator.clipboard?.writeText(bundleData?.hypothesis.traceId ?? '');
          },
        }, '📋 Trace') : null,
        h('button', {
          className: 'nav-btn active',
          onClick: () => {
            (state as any).svView = 'submit';
            (state as any).svHypothesisId = null;
            (state as any).svVerdict = null;
            render();
          },
        }, '+ New Hypothesis'),
      ),
    ));

    if (loadError) {
      inner.appendChild(h('div', {
        style: 'background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.2);border-radius:10px;padding:14px 16px;color:var(--danger);font-size:13px',
      }, loadError));
      container.appendChild(h('div', { className: 'dash-view' }, inner));
      return;
    }
    if (loading || !bundleData) {
      inner.appendChild(h('div', { style: 'color:var(--fg3);font-size:13px;text-align:center;padding:40px 0' }, 'Loading verdict…'));
      container.appendChild(h('div', { className: 'dash-view' }, inner));
      return;
    }

    const v = bundleData.verdict;
    const cfg = VERDICT_CFG[v.verdict] ?? VERDICT_CFG['inconclusive']!;
    const sj = supervisorJson;
    const gradeQ = sj?.gradeQuality;
    const bhScore = sj?.bradfordHillScore;

    // ── Verdict hero card ───────────────────────────────────────────────────
    inner.appendChild(h('div', {
      style: `background:${cfg.bg};border:2px solid ${cfg.color};border-radius:16px;padding:24px 28px;margin-bottom:16px`,
    },
      h('div', { style: 'display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap' },
        h('div', { style: 'display:flex;align-items:center;gap:12px;flex:1;min-width:200px' },
          h('span', { style: 'font-size:36px;flex-shrink:0' }, cfg.icon),
          h('div', null,
            h('div', { style: `font-size:24px;font-weight:900;color:${cfg.color}` }, cfg.label),
            h('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap' },
              gradeQ ? (gradePill(gradeQ) ?? h('span', null)) : h('span', null),
              bhScore !== undefined && bhScore > 0 ? h('span', {
                style: 'font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:rgba(99,102,241,.15);color:#6366f1;border:1px solid #6366f1',
                title: 'Bradford Hill causality score (0–9)',
              }, `BH: ${bhScore}/9`) : null,
              h('span', { style: 'font-size:11px;color:var(--fg3)' }, `by ${v.emittedBy ?? 'supervisor'}`),
            ),
          ),
        ),
        h('div', { style: 'min-width:200px;flex:1' },
          h('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:4px' }, 'Confidence Interval'),
          confidenceBar(v.confidenceLo, v.confidenceHi, cfg.color),
        ),
      ),
      sj?.summary ? h('div', {
        style: 'margin-top:16px;font-size:13px;color:var(--fg);line-height:1.6;background:rgba(0,0,0,.05);border-radius:8px;padding:12px 14px',
      }, sj.summary) : (v.limitations ? h('div', {
        style: 'margin-top:12px;font-size:13px;color:var(--fg2);font-style:italic',
      }, v.limitations) : null),
    ));

    // ── Hypothesis statement ─────────────────────────────────────────────────
    if (bundleData.hypothesis.statement) {
      inner.appendChild(h('div', {
        style: 'background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;padding:14px 18px;margin-bottom:14px',
      },
        h('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:6px' }, 'Hypothesis'),
        h('div', { style: 'font-size:13px;color:var(--fg);line-height:1.6' }, bundleData.hypothesis.statement),
        bundleData.hypothesis.domainTags?.length ? h('div', { style: 'display:flex;gap:5px;flex-wrap:wrap;margin-top:8px' },
          ...bundleData.hypothesis.domainTags.map(t =>
            h('span', { style: 'font-size:10px;padding:2px 8px;border-radius:999px;background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent)' }, t)
          )
        ) : null,
      ));
    }

    // ── Sub-claim verdicts (from supervisor JSON) ────────────────────────────
    if (sj?.subClaimVerdicts?.length) {
      inner.appendChild(section('Sub-claim Verdicts', [
        h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
          ...sj.subClaimVerdicts.map((scv, i) => {
            const scCfg = VERDICT_CFG[scv.verdict?.toLowerCase() === 'supported' ? 'supported' : scv.verdict?.toLowerCase().includes('contra') ? 'refuted' : 'inconclusive'] ?? VERDICT_CFG['inconclusive']!;
            const sc = bundleData!.subClaims[scv.subClaimIndex] ?? bundleData!.subClaims[i];
            return h('div', {
              style: `display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:9px;background:var(--bg);border:1px solid var(--bg4)`,
            },
              h('span', { style: `font-size:16px;flex-shrink:0;margin-top:1px` }, scCfg.icon),
              h('div', { style: 'flex:1;min-width:0' },
                h('div', { style: 'display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:3px' },
                  verdictPill(scCfg === VERDICT_CFG['supported'] ? 'supported' : scCfg === VERDICT_CFG['refuted'] ? 'refuted' : 'inconclusive'),
                  h('span', { style: 'font-size:11px;color:var(--fg3)' }, `${Math.round((scv.confidence ?? 0) * 100)}% confidence`),
                  scv.gradeQuality ? (gradePill(scv.gradeQuality) ?? h('span', null)) : null,
                ),
                sc ? h('div', { style: 'font-size:12px;color:var(--fg2);line-height:1.5' }, sc.statement) :
                  h('div', { style: 'font-size:12px;color:var(--fg3)' }, `Sub-claim ${scv.subClaimIndex}`),
              ),
            );
          }),
        ),
      ]));
    } else if (bundleData.subClaims.length) {
      // Fallback: show raw sub-claims without verdicts
      inner.appendChild(section('Sub-claims', [
        h('div', { style: 'display:flex;flex-direction:column;gap:7px' },
          ...bundleData.subClaims.map(sc => h('div', {
            style: 'display:flex;gap:9px;align-items:flex-start;padding:9px 11px;background:var(--bg);border:1px solid var(--bg4);border-radius:8px',
          },
            h('span', {
              style: 'font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;background:var(--bg4);color:var(--fg2);flex-shrink:0;text-transform:uppercase',
            }, sc.claimType),
            h('div', { style: 'flex:1' },
              h('div', { style: 'font-size:12px;color:var(--fg);line-height:1.5' }, sc.statement),
              h('div', { style: 'font-size:10px;color:var(--fg3);margin-top:2px' }, `Testability: ${(sc.testabilityScore * 100).toFixed(0)}%`),
            ),
          )),
        ),
      ]));
    }

    // ── Strengths and weaknesses ─────────────────────────────────────────────
    if (sj?.strengthsOfEvidence?.length || sj?.weaknessesOfEvidence?.length) {
      inner.appendChild(h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px' },
        sj.strengthsOfEvidence?.length ? h('div', {
          style: 'background:rgba(5,150,105,.07);border:1px solid rgba(5,150,105,.2);border-radius:12px;padding:14px 16px',
        },
          h('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#059669;margin-bottom:8px' }, '✅ Evidence Strengths'),
          h('ul', { style: 'display:flex;flex-direction:column;gap:5px;padding:0;list-style:none' },
            ...sj.strengthsOfEvidence.map(s =>
              h('li', { style: 'display:flex;gap:6px;font-size:12px;color:var(--fg2);line-height:1.45' },
                h('span', { style: 'flex-shrink:0;color:#059669;margin-top:1px' }, '·'),
                h('span', null, s),
              )
            )
          ),
        ) : h('div', null),
        sj.weaknessesOfEvidence?.length ? h('div', {
          style: 'background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:12px;padding:14px 16px',
        },
          h('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#ef4444;margin-bottom:8px' }, '⚠️ Evidence Weaknesses'),
          h('ul', { style: 'display:flex;flex-direction:column;gap:5px;padding:0;list-style:none' },
            ...sj.weaknessesOfEvidence.map(w =>
              h('li', { style: 'display:flex;gap:6px;font-size:12px;color:var(--fg2);line-height:1.45' },
                h('span', { style: 'flex-shrink:0;color:#ef4444;margin-top:1px' }, '·'),
                h('span', null, w),
              )
            )
          ),
        ) : h('div', null),
      ));
    }

    // ── Recommended next steps ───────────────────────────────────────────────
    if (sj?.recommendedNextSteps?.length) {
      inner.appendChild(section('Recommended Next Steps', [
        h('ol', { style: 'display:flex;flex-direction:column;gap:7px;padding:0;list-style:none;counter-reset:steps' },
          ...sj.recommendedNextSteps.map((step, i) =>
            h('li', { style: 'display:flex;gap:10px;align-items:flex-start;font-size:13px;color:var(--fg2);line-height:1.5' },
              h('span', {
                style: 'width:22px;height:22px;border-radius:50%;background:var(--accent-dim);color:var(--accent);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0',
              }, String(i + 1)),
              h('span', null, step),
            )
          ),
        ),
      ]));
    }

    // ── Evidence events ──────────────────────────────────────────────────────
    if (bundleData.evidenceEvents.length) {
      const maxShown = 12;
      const shown = bundleData.evidenceEvents.slice(0, maxShown);
      const extra = bundleData.evidenceEvents.length - shown.length;

      inner.appendChild(section(`Evidence Events (${bundleData.evidenceEvents.length})`, [
        h('div', { style: 'display:flex;flex-direction:column;gap:6px' },
          ...shown.map(ev => {
            const key = agentKey(ev.agentId);
            const emoji = AGENT_EMOJI[key] ?? '🤖';
            return h('div', {
              style: 'display:flex;gap:9px;align-items:flex-start;padding:8px 10px;background:var(--bg);border:1px solid var(--bg4);border-radius:8px',
            },
              h('span', { style: 'font-size:13px;flex-shrink:0;margin-top:1px' }, emoji),
              h('div', { style: 'flex:1;min-width:0' },
                h('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:2px' },
                  h('span', { style: 'font-size:11px;font-weight:600;color:var(--fg2)' }, key),
                  h('span', { style: 'font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg3);color:var(--fg3);border:1px solid var(--bg4)' }, ev.kind),
                  ev.toolKey ? h('span', { style: 'font-size:10px;font-family:var(--mono);color:var(--fg3)' }, ev.toolKey) : null,
                ),
                h('div', { style: 'font-size:12px;color:var(--fg2);line-height:1.45' }, ev.summary),
              ),
            );
          }),
          extra > 0 ? h('div', { style: 'font-size:12px;color:var(--fg3);text-align:center;padding:6px' }, `… and ${extra} more events`) : null,
        ),
      ]));
    }

    // ── Actions ──────────────────────────────────────────────────────────────
    inner.appendChild(h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-top:8px' },
      bundleData.verdict.id ? h('a', {
        href: `/api/sv/verdicts/${bundleData.verdict.id}/bundle`,
        download: `verdict-${bundleData.verdict.id}.json`,
        className: 'nav-btn',
        style: 'text-decoration:none',
      }, '⬇ Download Evidence Bundle') : null,
      h('button', {
        className: 'nav-btn',
        onClick: () => {
          if (!bundleData) return;
          const text = [
            `Hypothesis: ${bundleData.hypothesis.title}`,
            `Statement: ${bundleData.hypothesis.statement}`,
            `Verdict: ${cfg.label}`,
            `Confidence: ${Math.round(v.confidenceLo * 100)}–${Math.round(v.confidenceHi * 100)}%`,
            gradeQ ? `GRADE Quality: ${gradeQ}` : '',
            sj?.summary ? `Summary: ${sj.summary}` : '',
          ].filter(Boolean).join('\n');
          void navigator.clipboard?.writeText(text);
        },
      }, '📋 Copy Summary'),
    ));

    container.appendChild(inner);
  }

  // Kick off
  const cachedVerdict = (state as any).svVerdict as VerdictShape | null;
  if (cachedVerdict && hypothesisId) {
    loading = false;
    bundleData = {
      hypothesis: { title: '', statement: '' },
      verdict: cachedVerdict,
      subClaims: [],
      evidenceEvents: [],
    };
    renderContent();
  }
  void loadBundle();

  return container;
}
