/**
 * Hypothesis Validation — Verdict View
 *
 * Displays the final verdict produced by the supervisor agent after all
 * specialist agents have completed their analysis. Shows the verdict label,
 * confidence interval, sub-claims, evidence summary, and provides a bundle
 * download link.
 */
import { h } from '../../../ui/dom.js';
import { state } from '../../../ui/state.js';

interface VerdictShape {
  id: string;
  verdict: 'supported' | 'refuted' | 'inconclusive' | 'needs_revision';
  confidenceLo: number;
  confidenceHi: number;
  limitations?: string;
  emittedBy?: string;
  keyEvidenceIds?: string[];
  falsifiers?: string[];
}

interface SubClaim {
  id: string;
  statement: string;
  claimType: string;
  testabilityScore: number;
}

interface BundleData {
  hypothesis: { title: string; statement: string; traceId?: string };
  verdict: VerdictShape;
  subClaims: SubClaim[];
  evidenceEvents: { evidenceId: string; kind: string; summary: string; agentId: string }[];
}

const VERDICT_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  supported: { label: 'Supported', color: '#059669', bg: 'rgba(5,150,105,.09)', icon: '✅' },
  refuted: { label: 'Refuted', color: '#dc2626', bg: 'rgba(220,38,38,.09)', icon: '❌' },
  inconclusive: { label: 'Inconclusive', color: '#d97706', bg: 'rgba(217,119,6,.09)', icon: '⚠️' },
  needs_revision: { label: 'Needs Revision', color: '#7c3aed', bg: 'rgba(124,58,237,.09)', icon: '🔄' },
};

function confidenceBar(lo: number, hi: number): HTMLElement {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const width = Math.max(0, Math.min(1, hi - lo));
  const left = Math.max(0, Math.min(1, lo));
  const bar = h('div', {
    style: 'position:relative;height:10px;background:var(--bg4);border-radius:999px;overflow:hidden',
  });
  const fill = h('div', {
    style: `position:absolute;top:0;bottom:0;left:${pct(left)};width:${pct(width)};background:var(--solid);border-radius:999px`,
  });
  bar.appendChild(fill);
  return h('div', { style: 'margin-top:6px' },
    bar,
    h('div', { style: 'display:flex;justify-content:space-between;font-size:11px;color:var(--fg3);margin-top:4px' },
      h('span', null, `${Math.round(lo * 100)}% lo`),
      h('span', null, `${Math.round(hi * 100)}% hi`),
    ),
  );
}

export function renderSVVerdictView(options: { render: () => void }): HTMLElement {
  const { render } = options;

  const hypothesisId = (state as any).svHypothesisId as string | null;
  const cachedVerdict = (state as any).svVerdict as VerdictShape | null;

  let bundleData: BundleData | null = null;
  let loading = true;
  let loadError = '';

  const container = h('div', { className: 'dash-view' },
    h('div', { style: 'max-width:800px;margin:0 auto' },
      h('div', { style: 'font-size:13px;color:var(--fg3);margin-top:24px' }, 'Loading verdict…')
    )
  );

  async function loadBundle() {
    if (!hypothesisId) return;
    try {
      // First fetch the full hypothesis to get the verdict ID
      const hRes = await fetch(`/api/sv/hypotheses/${hypothesisId}`, { credentials: 'include' });
      if (!hRes.ok) { loadError = `Error ${hRes.status}`; renderContent(); return; }
      const hData = await hRes.json() as { hypothesis: { title: string; statement: string; traceId?: string }; verdict: VerdictShape | null };

      if (!hData.verdict) {
        loadError = 'No verdict available yet.';
        renderContent();
        return;
      }

      // Fetch the full bundle
      const bRes = await fetch(`/api/sv/verdicts/${hData.verdict.id}/bundle`, { credentials: 'include' });
      if (!bRes.ok) {
        // Fallback to partial data
        bundleData = {
          hypothesis: hData.hypothesis,
          verdict: hData.verdict,
          subClaims: [],
          evidenceEvents: [],
        };
      } else {
        bundleData = await bRes.json() as BundleData;
      }
      loading = false;
    } catch (err: unknown) {
      loadError = err instanceof Error ? err.message : 'Network error';
    }
    renderContent();
  }

  function renderContent() {
    while (container.firstChild) container.removeChild(container.firstChild);

    const inner = h('div', { style: 'max-width:800px;margin:0 auto' },
      h('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:24px' },
        h('span', { style: 'font-size:22px' }, '🔬'),
        h('h2', { style: 'font-size:20px;font-weight:700;color:var(--fg);margin:0' }, 'Validation Verdict'),
        h('button', {
          className: 'nav-btn',
          style: 'margin-left:auto',
          onClick: () => {
            (state as any).svView = 'submit';
            (state as any).svHypothesisId = null;
            (state as any).svVerdict = null;
            render();
          },
        }, '+ New Hypothesis'),
      ),
    );

    if (loadError) {
      inner.appendChild(h('div', { style: 'color:var(--danger);font-size:14px' }, loadError));
      container.appendChild(inner);
      return;
    }
    if (loading || !bundleData) {
      inner.appendChild(h('div', { style: 'color:var(--fg3);font-size:13px' }, 'Loading…'));
      container.appendChild(inner);
      return;
    }

    const v = bundleData.verdict;
    const cfg = (VERDICT_CONFIG[v.verdict as keyof typeof VERDICT_CONFIG] ?? VERDICT_CONFIG['inconclusive'])!;

    // ── Verdict card ──
    inner.appendChild(h('div', {
      style: `background:${cfg.bg};border:2px solid ${cfg.color};border-radius:14px;padding:24px 28px;margin-bottom:20px`,
    },
      h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:12px' },
        h('span', { style: 'font-size:32px' }, cfg.icon),
        h('div', null,
          h('div', { style: `font-size:22px;font-weight:800;color:${cfg.color}` }, cfg.label),
          h('div', { style: 'font-size:12px;color:var(--fg3);margin-top:2px' },
            `Emitted by: ${v.emittedBy ?? 'supervisor'}`,
          ),
        ),
      ),
      h('div', { style: 'font-size:13px;font-weight:600;color:var(--fg2);margin-bottom:4px' }, 'Confidence Interval'),
      confidenceBar(v.confidenceLo, v.confidenceHi),
      v.limitations ? h('div', {
        style: 'margin-top:14px;font-size:13px;color:var(--fg2);background:var(--bg2);border-radius:8px;padding:10px 14px',
      }, h('span', { style: 'font-weight:600' }, 'Limitations: '), v.limitations) : null,
    ));

    // ── Sub-claims ──
    if (bundleData.subClaims.length) {
      inner.appendChild(h('div', {
        style: 'background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;padding:20px 24px;margin-bottom:16px',
      },
        h('div', { style: 'font-size:13px;font-weight:700;color:var(--fg);margin-bottom:12px' }, `Sub-Claims (${bundleData.subClaims.length})`),
        h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
          ...bundleData.subClaims.map(sc => h('div', {
            style: 'display:flex;gap:10px;align-items:flex-start;padding:8px 10px;background:var(--bg3);border-radius:8px',
          },
            h('span', {
              style: `font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;background:var(--bg4);color:var(--fg2);flex-shrink:0;margin-top:1px;text-transform:uppercase`,
            }, sc.claimType),
            h('div', { style: 'flex:1' },
              h('div', { style: 'font-size:13px;color:var(--fg)' }, sc.statement),
              h('div', { style: 'font-size:11px;color:var(--fg3);margin-top:2px' },
                `Testability: ${(sc.testabilityScore * 100).toFixed(0)}%`),
            ),
          )),
        ),
      ));
    }

    // ── Evidence summary ──
    if (bundleData.evidenceEvents.length) {
      const kindCounts: Record<string, number> = {};
      bundleData.evidenceEvents.forEach(ev => { kindCounts[ev.kind] = (kindCounts[ev.kind] ?? 0) + 1; });
      inner.appendChild(h('div', {
        style: 'background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;padding:16px 20px;margin-bottom:16px',
      },
        h('div', { style: 'font-size:13px;font-weight:700;color:var(--fg);margin-bottom:10px' },
          `Evidence (${bundleData.evidenceEvents.length} events)`),
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
          ...Object.entries(kindCounts).map(([kind, count]) => h('div', {
            style: 'font-size:12px;padding:4px 12px;border-radius:999px;background:var(--bg3);border:1px solid var(--bg4);color:var(--fg2)',
          }, `${kind}: ${count}`))
        ),
      ));
    }

    // ── Download bundle ──
    if (bundleData.verdict.id) {
      inner.appendChild(h('div', { style: 'margin-top:4px' },
        h('a', {
          href: `/api/sv/verdicts/${bundleData.verdict.id}/bundle`,
          download: `verdict-${bundleData.verdict.id}.json`,
          className: 'nav-btn',
          style: 'display:inline-block;text-decoration:none',
        }, '⬇ Download Evidence Bundle'),
      ));
    }

    container.appendChild(inner);
  }

  // Kick off loading
  void loadBundle();

  // If we already have a cached verdict from the live stream, use it as initial display
  if (cachedVerdict && hypothesisId) {
    loading = false;
    bundleData = {
      hypothesis: { title: '', statement: '' },
      verdict: cachedVerdict,
      subClaims: [],
      evidenceEvents: [],
    };
    renderContent();
    // Re-fetch the full bundle async
    void loadBundle();
  }

  return container;
}
