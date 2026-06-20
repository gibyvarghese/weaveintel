/**
 * Hypothesis Validation — Submit View (v2)
 *
 * - api.get() for loadRecent (CSRF-safe)
 * - Interactive domain-tag chips
 * - Character counter on statement
 * - Budget selection from API
 * - Tips panel on what makes a good hypothesis
 */
import { h } from '../../../ui/dom.js';
import { api } from '../../../ui/api.js';
import { state } from '../../../ui/state.js';

const SUGGESTED_DOMAINS = [
  'biology', 'chemistry', 'physics', 'mathematics', 'medicine',
  'epidemiology', 'climate', 'economics', 'psychology', 'neuroscience',
  'materials', 'engineering', 'nutrition', 'genetics', 'pharmacology',
];

const STATEMENT_MAX = 1500;

export function renderSVSubmitView(options: { render: () => void }): HTMLElement {
  const { render } = options;

  let submitting = false;
  let error = '';
  const tags: string[] = [];
  let budgetId = '';

  // ── Inputs ───────────────────────────────────────────────────────────────
  const titleInput = h('input', {
    type: 'text',
    placeholder: 'e.g. "30 min daily exercise reduces cardiovascular risk by ≥15% in adults over 50"',
    style: 'width:100%;padding:10px 13px;border-radius:9px;border:1.5px solid var(--bg4);background:var(--bg);color:var(--fg);font-size:14px;transition:border-color .18s',
    onFocus: (e: Event) => { (e.target as HTMLInputElement).style.borderColor = 'var(--accent)'; },
    onBlur: (e: Event) => { (e.target as HTMLInputElement).style.borderColor = 'var(--bg4)'; },
  }) as HTMLInputElement;

  const charCountEl = h('div', { style: 'font-size:11px;color:var(--fg3);text-align:right;margin-top:3px' }, `0 / ${STATEMENT_MAX}`);
  const statementArea = h('textarea', {
    placeholder: 'State the hypothesis precisely. Include: population, intervention/condition, comparison, outcome metric and direction of effect.\n\nExample: "In adults aged 50–70 (P), 30 min of moderate-intensity aerobic exercise 5×/week (I) compared to sedentary lifestyle (C) reduces 10-year cardiovascular event risk by ≥15% (O)."',
    rows: '6',
    style: 'width:100%;padding:10px 13px;border-radius:9px;border:1.5px solid var(--bg4);background:var(--bg);color:var(--fg);font-size:13px;font-family:var(--font);resize:vertical;line-height:1.55;transition:border-color .18s',
    onFocus: (e: Event) => { (e.target as HTMLTextAreaElement).style.borderColor = 'var(--accent)'; },
    onBlur: (e: Event) => { (e.target as HTMLTextAreaElement).style.borderColor = 'var(--bg4)'; },
    onInput: () => {
      const len = statementArea.value.length;
      charCountEl.textContent = `${len} / ${STATEMENT_MAX}`;
      charCountEl.style.color = len > STATEMENT_MAX * 0.9 ? 'var(--warn)' : 'var(--fg3)';
    },
  }) as HTMLTextAreaElement;

  // ── Tag chips ─────────────────────────────────────────────────────────────
  const chipsEl = h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;min-height:28px;margin-top:8px' });
  const tagTextInput = h('input', {
    type: 'text',
    placeholder: 'Add domain tag…',
    style: 'flex:1;min-width:120px;padding:5px 10px;border-radius:999px;border:1.5px solid var(--bg4);background:var(--bg);color:var(--fg);font-size:12px',
    onKeyDown: (e: KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ',') && tagTextInput.value.trim()) {
        e.preventDefault();
        addTag(tagTextInput.value.trim());
        tagTextInput.value = '';
      }
    },
  }) as HTMLInputElement;

  function addTag(tag: string) {
    const clean = tag.replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 24);
    if (!clean || tags.includes(clean)) return;
    tags.push(clean);
    renderChips();
  }

  function removeTag(tag: string) {
    const idx = tags.indexOf(tag);
    if (idx >= 0) tags.splice(idx, 1);
    renderChips();
  }

  function renderChips() {
    while (chipsEl.firstChild) chipsEl.removeChild(chipsEl.firstChild);
    tags.forEach(tag => {
      chipsEl.appendChild(h('div', {
        style: 'display:flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;background:var(--accent-dim);border:1px solid var(--accent);color:var(--accent);font-size:12px;font-weight:500',
      },
        h('span', null, tag),
        h('button', {
          style: 'font-size:13px;line-height:1;color:var(--accent);padding:0 0 0 2px',
          onClick: () => removeTag(tag),
        }, '×'),
      ));
    });
  }

  // Suggested domain chips
  const suggestionsEl = h('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;margin-top:8px' },
    ...SUGGESTED_DOMAINS.map(d => h('button', {
      style: 'padding:3px 10px;border-radius:999px;border:1px solid var(--bg4);background:var(--bg3);color:var(--fg3);font-size:11px;cursor:pointer;transition:all .15s',
      onMouseEnter: (e: Event) => { (e.target as HTMLButtonElement).style.borderColor = 'var(--accent)'; (e.target as HTMLButtonElement).style.color = 'var(--accent)'; },
      onMouseLeave: (e: Event) => { (e.target as HTMLButtonElement).style.borderColor = 'var(--bg4)'; (e.target as HTMLButtonElement).style.color = 'var(--fg3)'; },
      onClick: () => addTag(d),
    }, d)),
  );

  // ── Error / submit ────────────────────────────────────────────────────────
  const errorEl = h('div', { style: 'color:var(--danger);font-size:13px;min-height:18px;margin-top:4px;border-radius:7px;padding:0' });

  const submitBtn = h('button', {
    className: 'nav-btn active',
    style: 'padding:11px 32px;font-size:14px;font-weight:700;border-radius:999px;transition:opacity .18s',
    onClick: async () => {
      if (submitting) return;
      const title = titleInput.value.trim();
      const statement = statementArea.value.trim();
      error = '';
      errorEl.textContent = '';

      if (!title) { showError('Title is required.'); return; }
      if (!statement) { showError('Hypothesis statement is required.'); return; }
      if (statement.length > STATEMENT_MAX) { showError(`Statement is too long (${statement.length} / ${STATEMENT_MAX}).`); return; }
      if (statement.split(/\s+/).length < 8) { showError('Statement is too short — include population, intervention, comparison, and outcome.'); return; }

      submitting = true;
      submitBtn.setAttribute('disabled', '');
      submitBtn.textContent = 'Submitting…';

      try {
        const body: Record<string, unknown> = { title, statement, domainTags: tags };
        if (budgetId) body['budgetId'] = budgetId;
        const res = await api.post('/api/sv/hypotheses', body);
        if (!res.ok) {
          const body2 = await res.json() as { error?: string };
          showError(body2.error ?? `Server error (${res.status})`);
          return;
        }
        const created = await res.json() as { id: string; status: string };
        (state as any).svHypothesisId = created.id;
        (state as any).svHypothesis = { title, statement, domainTags: tags };
        (state as any).svView = 'live';
        render();
      } catch (err: unknown) {
        showError(err instanceof Error ? err.message : 'Network error');
      } finally {
        submitting = false;
        submitBtn.removeAttribute('disabled');
        submitBtn.textContent = 'Submit for Validation';
      }
    },
  }, 'Submit for Validation');

  function showError(msg: string) {
    error = msg;
    errorEl.textContent = msg;
    errorEl.style.padding = '8px 12px';
    errorEl.style.background = 'rgba(220,38,38,.08)';
  }

  // ── Recent hypotheses ─────────────────────────────────────────────────────
  const recentEl = h('div', { style: 'display:none;margin-bottom:22px' });

  const STATUS_STYLE: Record<string, { color: string; label: string }> = {
    running: { color: '#f59e0b', label: 'Running' },
    queued: { color: '#6366f1', label: 'Queued' },
    verdict: { color: '#059669', label: 'Complete' },
    abandoned: { color: '#6b7280', label: 'Abandoned' },
  };

  async function loadRecent() {
    try {
      const res = await api.get('/api/sv/hypotheses');
      if (!res.ok) return;
      const data = await res.json() as { hypotheses: Array<{ id: string; title: string; status: string; createdAt: string }> };
      if (!data.hypotheses?.length) return;
      recentEl.style.display = 'block';
      while (recentEl.firstChild) recentEl.removeChild(recentEl.firstChild);

      recentEl.appendChild(h('div', {
        style: 'background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;padding:16px 18px',
      },
        h('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:10px' }, 'Recent Validations'),
        h('div', { style: 'display:flex;flex-direction:column;gap:6px' },
          ...data.hypotheses.slice(0, 6).map(hyp => {
            const st = STATUS_STYLE[hyp.status] ?? { color: '#6b7280', label: hyp.status };
            const isActive = hyp.status === 'running' || hyp.status === 'queued';
            const isComplete = hyp.status === 'verdict';
            return h('div', {
              style: `display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;background:var(--bg);border:1px solid var(--bg4);${isActive || isComplete ? 'cursor:pointer' : ''};transition:background .15s`,
              onMouseEnter: (e: Event) => { if (isActive || isComplete) (e.currentTarget as HTMLElement).style.background = 'var(--bg3)'; },
              onMouseLeave: (e: Event) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg)'; },
              onClick: () => {
                if (!isActive && !isComplete) return;
                (state as any).svHypothesisId = hyp.id;
                (state as any).svView = isComplete ? 'verdict' : 'live';
                render();
              },
            },
              h('span', { style: `width:8px;height:8px;border-radius:50%;background:${st.color};flex-shrink:0;display:inline-block` }),
              h('span', { style: 'font-size:13px;color:var(--fg);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, hyp.title),
              h('span', { style: `font-size:10px;font-weight:700;color:${st.color};text-transform:uppercase;letter-spacing:.04em;flex-shrink:0` }, st.label),
            );
          }),
        ),
      ));
    } catch { /* ignore */ }
  }

  setTimeout(() => { void loadRecent(); }, 80);

  // ── Tips panel ────────────────────────────────────────────────────────────
  const tipsEl = h('div', {
    style: 'background:var(--bg2);border:1px solid var(--bg4);border-radius:12px;padding:16px 18px;margin-bottom:20px',
  },
    h('div', { style: 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:10px' }, 'What makes a strong hypothesis?'),
    h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
      ...([
        ['🎯 PICO', 'Specify Population, Intervention, Comparison, and Outcome with measurable metrics.'],
        ['⚗️ Falsifiable', 'State it so that specific evidence could definitively disprove it (Popper criterion).'],
        ['📐 Precise', 'Include direction and magnitude of effect — "reduces by ≥15%" not "improves".'],
        ['🔬 Scoped', 'One testable claim. Complex multi-part claims should be separate submissions.'],
      ] as [string, string][]).map(([title, desc]) =>
        h('div', { style: 'display:flex;gap:10px;align-items:flex-start' },
          h('span', { style: 'font-size:13px;flex-shrink:0' }, title),
          h('span', { style: 'font-size:12px;color:var(--fg3);line-height:1.45' }, desc),
        )
      ),
    ),
  );

  const field = (label: string, el: HTMLElement, hint?: string, after?: HTMLElement) =>
    h('div', { style: 'margin-bottom:20px' },
      h('label', { style: 'display:block;font-size:12px;color:var(--fg2);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.04em' }, label),
      el,
      after ?? null,
      hint ? h('div', { style: 'font-size:11px;color:var(--fg3);margin-top:4px' }, hint) : null,
    );

  return h('div', { className: 'dash-view' },
    h('div', { style: 'max-width:700px;margin:0 auto;padding-bottom:40px' },

      // Header
      h('div', { style: 'display:flex;align-items:center;gap:14px;margin-bottom:28px' },
        h('div', { style: 'width:44px;height:44px;border-radius:12px;background:var(--accent-dim);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0' }, '🔬'),
        h('div', null,
          h('h2', { style: 'font-size:22px;font-weight:800;color:var(--fg);margin:0 0 3px' }, 'Validate a Hypothesis'),
          h('p', { style: 'color:var(--fg3);font-size:13px;margin:0' }, 'Multi-agent evidence gathering, statistical analysis, simulation, and adversarial review.'),
        ),
      ),

      recentEl,
      tipsEl,

      // Form card
      h('div', { style: 'background:var(--bg2);border:1px solid var(--bg4);border-radius:14px;padding:26px 28px' },
        h('div', { style: 'font-size:15px;font-weight:700;color:var(--fg);margin-bottom:20px' }, 'New Hypothesis'),

        field('Title', titleInput, 'A short, memorable name for this validation run.'),
        field('Statement', statementArea, 'Full falsifiable claim. The more precise, the better the evidence quality.', charCountEl),

        // Domain tags
        h('div', { style: 'margin-bottom:20px' },
          h('label', { style: 'display:block;font-size:12px;color:var(--fg2);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.04em' }, 'Domain Tags'),
          h('div', {
            style: 'padding:8px 10px;border-radius:9px;border:1.5px solid var(--bg4);background:var(--bg);display:flex;flex-wrap:wrap;gap:5px;min-height:44px;cursor:text',
            onClick: () => tagTextInput.focus(),
          },
            chipsEl,
            tagTextInput,
          ),
          h('div', { style: 'font-size:11px;color:var(--fg3);margin-top:6px;margin-bottom:6px' }, 'Quick-add:'),
          suggestionsEl,
        ),

        errorEl,
        h('div', { style: 'margin-top:20px;display:flex;justify-content:flex-end' }, submitBtn),
      ),
    ),
  );
}
