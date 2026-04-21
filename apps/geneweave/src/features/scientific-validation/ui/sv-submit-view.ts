/**
 * Scientific Validation — Submit Hypothesis View
 *
 * Renders a form to submit a new scientific hypothesis for multi-agent
 * validation. On success, transitions the state to the live deliberation view.
 */
import { h } from '../../../ui/dom.js';
import { api } from '../../../ui/api.js';
import { state } from '../../../ui/state.js';

export function renderSVSubmitView(options: { render: () => void }): HTMLElement {
  const { render } = options;

  let submitting = false;
  let error = '';

  const titleInput = h('input', {
    type: 'text',
    placeholder: 'e.g. "Aspirin reduces cardiovascular event risk in primary prevention"',
    style: 'width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);font-size:14px;box-sizing:border-box',
  }) as HTMLInputElement;

  const statementArea = h('textarea', {
    placeholder: 'State the hypothesis clearly and precisely. Include measurable claims, target population, and expected effect direction.',
    rows: '5',
    style: 'width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);font-size:13px;font-family:var(--font);resize:vertical;box-sizing:border-box',
  }) as HTMLTextAreaElement;

  const tagsInput = h('input', {
    type: 'text',
    placeholder: 'cardiology, pharmacology, rct (comma-separated)',
    style: 'width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--bg4);background:var(--bg2);color:var(--fg);font-size:14px;box-sizing:border-box',
  }) as HTMLInputElement;

  const errorEl = h('div', {
    style: 'color:var(--danger);font-size:13px;min-height:18px;margin-top:4px',
  });

  const submitBtn = h('button', {
    className: 'nav-btn active',
    style: 'padding:10px 28px;font-size:14px;font-weight:600',
    onClick: async () => {
      if (submitting) return;
      const title = titleInput.value.trim();
      const statement = statementArea.value.trim();
      const tags = tagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
      error = '';

      if (!title) { error = 'Title is required.'; errorEl.textContent = error; return; }
      if (!statement) { error = 'Hypothesis statement is required.'; errorEl.textContent = error; return; }

      submitting = true;
      submitBtn.setAttribute('disabled', '');
      submitBtn.textContent = 'Submitting…';

      try {
        const res = await api.post('/api/sv/hypotheses', { title, statement, domainTags: tags });
        if (!res.ok) {
          const body = await res.json() as { error?: string };
          error = body.error ?? `Error ${res.status}`;
          errorEl.textContent = error;
          submitBtn.removeAttribute('disabled');
          submitBtn.textContent = 'Submit Hypothesis';
          submitting = false;
          return;
        }
        const created = await res.json() as { id: string; status: string; traceId: string };
        // Transition to live deliberation view
        (state as any).svHypothesisId = created.id;
        (state as any).svView = 'live';
        render();
      } catch (err: unknown) {
        error = err instanceof Error ? err.message : 'Network error';
        errorEl.textContent = error;
        submitBtn.removeAttribute('disabled');
        submitBtn.textContent = 'Submit Hypothesis';
        submitting = false;
      }
    },
  }, 'Submit Hypothesis');

  const field = (label: string, input: HTMLElement, hint?: string) => h('div', {
    style: 'margin-bottom:20px',
  },
    h('label', {
      style: 'display:block;font-size:12px;color:var(--fg2);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.04em',
    }, label),
    input,
    hint ? h('div', { style: 'font-size:11px;color:var(--fg3);margin-top:4px' }, hint) : null,
  );

  return h('div', { className: 'dash-view' },
    h('div', { style: 'max-width:700px;margin:0 auto' },
      h('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:32px' },
        h('span', { style: 'font-size:28px' }, '🔬'),
        h('div', null,
          h('h2', { style: 'font-size:22px;font-weight:700;color:var(--fg);margin:0 0 4px' }, 'Scientific Validation'),
          h('p', { style: 'color:var(--fg3);font-size:13px;margin:0' },
            'Submit a hypothesis for multi-agent literature, statistical, and mechanistic analysis.'),
        )
      ),
      h('div', {
        style: 'background:var(--bg2);border:1px solid var(--bg4);border-radius:14px;padding:28px 30px',
      },
        h('div', { style: 'font-size:15px;font-weight:600;color:var(--fg);margin-bottom:20px' }, 'New Hypothesis'),
        field('Title', titleInput, 'Short descriptive title for the hypothesis.'),
        field('Statement', statementArea, 'Full falsifiable statement. Be precise about population, intervention, comparator, and outcome.'),
        field('Domain Tags', tagsInput, 'Optional. Helps route to domain-specific tools.'),
        errorEl,
        h('div', { style: 'margin-top:8px' }, submitBtn),
      )
    )
  );
}
