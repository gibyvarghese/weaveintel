import { state } from './state.js';
import { h } from './dom.js';
import {
  scrollMessages,
  toggleAudioRecording,
  queueFiles,
  removePendingAttachment,
} from './utils.js';

export function renderSettingsDropdown(options: { render: () => void; saveChatSettings: () => Promise<void> }): HTMLElement {
  const settings = state.chatSettings;
  if (!settings) return h('div', null);

  const save = () => { void options.saveChatSettings(); options.render(); };
  const saveOnly = () => { void options.saveChatSettings(); };

  const modes = [
    { id: 'direct',     icon: '💬', title: 'Direct',     desc: 'Simple chat, no orchestration' },
    { id: 'agent',      icon: '🤖', title: 'Agent',      desc: 'Tool-calling reasoning loop' },
    { id: 'supervisor', icon: '🧠', title: 'Supervisor', desc: 'Delegates to specialist workers' },
    { id: 'ensemble',   icon: '🎭', title: 'Ensemble',   desc: 'Multiple models vote on answer' },
  ];

  const modeCards = modes.map((mode) =>
    h('div', {
      className: 'mode-card' + (settings.mode === mode.id ? ' selected' : ''),
      onClick: () => { settings.mode = mode.id; save(); },
    },
      h('div', { className: 'mc-icon' }, mode.icon),
      h('div', null,
        h('div', { className: 'mc-title' }, mode.title),
        h('div', { className: 'mc-desc' }, mode.desc),
      )
    )
  );

  const settingRow = (icon: string, label: string, desc: string, enabled: boolean, onToggle: () => void) =>
    h('div', { className: 'setting-row', onClick: () => { onToggle(); save(); } },
      h('div', { style: 'flex:1' },
        h('div', { className: 'setting-row-label' }, icon + ' ' + label),
        h('div', { className: 'setting-row-desc' }, desc),
      ),
      h('div', { className: 'toggle-switch' + (enabled ? ' on' : '') })
    );

  const numInput = (label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void) =>
    h('div', { className: 'setting-sub' },
      h('span', null, label),
      h('input', {
        type: 'number',
        value: String(value),
        min: String(min),
        max: String(max),
        step: String(step),
        onClick: (e: Event) => e.stopPropagation(),
        onChange: (e: Event) => {
          const v = parseFloat((e.target as HTMLInputElement).value);
          if (!isNaN(v) && v >= min && v <= max) { onChange(v); saveOnly(); }
        },
      })
    );

  const sectionLabel = (text: string) => h('div', { className: 'setting-section-label' }, text);
  const sep = () => h('div', { className: 'setting-sep' });

  const isAdvanced = settings.mode && settings.mode !== 'direct';
  const rows: HTMLElement[] = [];

  rows.push(sectionLabel('AI Mode'));
  rows.push(h('div', { className: 'mode-grid' }, ...modeCards));

  if (isAdvanced) {
    rows.push(sep());
    rows.push(sectionLabel('Enhancements'));

    rows.push(settingRow(
      '🔁', 'Reflection',
      'Self-critique and revise before responding',
      !!settings.reflectEnabled,
      () => { settings.reflectEnabled = !settings.reflectEnabled; }
    ));
    if (settings.reflectEnabled) {
      rows.push(numInput('Max revisions', settings.reflectMaxRevisions ?? 2, 1, 5, 1, (v) => { settings.reflectMaxRevisions = v; }));
    }

    rows.push(settingRow(
      '✅', 'Evaluator',
      'Score output and retry until quality threshold met',
      !!settings.verifyEnabled,
      () => { settings.verifyEnabled = !settings.verifyEnabled; }
    ));
    if (settings.verifyEnabled) {
      rows.push(numInput('Min quality score (0–1)', settings.verifyMinScore ?? 0.7, 0.1, 1.0, 0.1, (v) => { settings.verifyMinScore = v; }));
    }
  }

  if (settings.mode === 'supervisor') {
    rows.push(sep());
    rows.push(sectionLabel('Supervisor Options'));
    rows.push(settingRow(
      '🔄', 'Re-plan on failure',
      'Revise the plan and retry when a worker fails',
      !!settings.supervisorReplanOnFailure,
      () => { settings.supervisorReplanOnFailure = !settings.supervisorReplanOnFailure; }
    ));
    rows.push(settingRow(
      '⚡', 'Parallel delegation',
      'Run independent worker tasks concurrently',
      !!settings.supervisorParallelDelegation,
      () => { settings.supervisorParallelDelegation = !settings.supervisorParallelDelegation; }
    ));
  }

  if (settings.mode === 'ensemble') {
    rows.push(sep());
    rows.push(sectionLabel('Ensemble Options'));
    const resolvers = [
      { value: 'majority_vote', label: 'Majority vote' },
      { value: 'arbiter_llm',   label: 'Arbiter LLM'  },
      { value: 'best_of',       label: 'Best of N'    },
    ];
    const current = settings.ensembleResolver ?? 'majority_vote';
    rows.push(
      h('div', { style: 'padding:10px 12px;border-radius:var(--radius);border:1px solid var(--bg4);background:var(--bg2)' },
        h('div', { style: 'font-size:11px;color:var(--fg3);margin-bottom:8px;font-weight:600' }, 'Resolver strategy'),
        ...resolvers.map((r) =>
          h('div', {
            className: 'resolver-option',
            onClick: (e: Event) => { e.stopPropagation(); settings.ensembleResolver = r.value; save(); },
          },
            h('div', { className: 'resolver-dot' + (current === r.value ? ' active' : '') }),
            h('span', null, r.label),
          )
        )
      )
    );
  }

  return h('div', { className: 'dropdown settings-dd', onClick: (e: Event) => e.stopPropagation() },
    h('h3', null, h('span', null, '⚙'), ' Agentic AI Settings'),
    h('div', { style: 'display:flex;flex-direction:column;gap:8px;' }, ...rows)
  );
}

export function renderChatView(options: {
  render: () => void;
  renderMessages: () => void;
  sendMessage: (text: string) => Promise<void>;
}): HTMLElement {
  const view = h('div', { className: 'chat-view' });

  if (state.handoffRequest) {
    const handoff = state.handoffRequest as any;
    const banner = h('div', { style: 'background:#FEF3C7;border:1px solid #FCD34D;border-radius:10px;margin:12px 16px 0;padding:14px 18px;display:flex;flex-direction:column;gap:10px;flex-shrink:0' });
    banner.appendChild(h('div', { style: 'display:flex;align-items:center;gap:8px' },
      h('span', { style: 'font-size:20px' }, '🚨'),
      h('div', { style: 'flex:1' },
        h('div', { style: 'font-weight:700;font-size:14px;color:#92400E' }, 'Browser Handoff Requested'),
        h('div', { style: 'font-size:12px;color:#78350F;margin-top:2px' }, handoff.reason || 'The agent needs you to complete an action in the browser.')
      )
    ));

    if (handoff.url) {
      banner.appendChild(h('div', { style: 'font-size:11px;color:#78350F;font-family:monospace;background:#FDE68A;padding:4px 8px;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, '🔗 ' + handoff.url));
    }

    if (handoff.screenshot) {
      banner.appendChild(h('img', { src: 'data:image/png;base64,' + handoff.screenshot, style: 'max-width:100%;max-height:200px;border-radius:6px;border:1px solid #FCD34D' }));
    }

    const actions = h('div', { style: 'display:flex;gap:8px' });
    actions.appendChild(h('button', {
      className: 'nav-btn active',
      style: 'font-size:12px;background:#059669;border-color:#059669;color:white',
      onClick: () => {
        const message = 'Resume the browser session'
          + (handoff.sessionId ? ' (session: ' + handoff.sessionId + ')' : '')
          + (handoff.taskId ? ' (task: ' + handoff.taskId + ')' : '');
        state.handoffRequest = null;
        options.render();
        void options.sendMessage(message);
      },
    }, "✅ I'm Done - Resume Agent"));
    actions.appendChild(h('button', {
      className: 'nav-btn',
      style: 'font-size:12px',
      onClick: () => {
        state.handoffRequest = null;
        options.render();
      },
    }, 'Dismiss'));
    banner.appendChild(actions);
    view.appendChild(banner);
  }

  const textarea = h('textarea', { placeholder: 'Type a message...', rows: '1' }) as HTMLTextAreaElement;
  textarea.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void options.sendMessage(textarea.value);
      textarea.value = '';
      textarea.style.height = 'auto';
    }
  });
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
  });

  const messageContainer = h('div', { className: 'messages' });
  view.appendChild(messageContainer);

  const fileInput = h('input', { type: 'file', multiple: true, style: 'display:none' }) as HTMLInputElement;
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    await queueFiles(files as File[]);
    fileInput.value = '';
  });

  view.appendChild(h('div', { className: 'input-bar' },
    fileInput,
    h('div', { className: 'input-tools' },
      h('button', { className: 'tool-btn', title: 'Attach files', onClick: () => fileInput.click() }, '📎'),
      h('button', {
        className: 'tool-btn mic-btn' + (state.audioRecording ? ' active' : ''),
        title: state.audioRecording ? 'Stop voice input' : 'Voice input (transcribed to text)',
        'aria-label': state.audioRecording ? 'Stop voice input' : 'Start voice input',
        'aria-pressed': state.audioRecording ? 'true' : 'false',
        innerHTML:
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<rect x="9" y="3" width="6" height="12" rx="3"></rect>' +
            '<path d="M5 11a7 7 0 0 0 14 0"></path>' +
            '<line x1="12" y1="18" x2="12" y2="22"></line>' +
            '<line x1="8" y1="22" x2="16" y2="22"></line>' +
          '</svg>',
        onClick: () => toggleAudioRecording(),
      })
    ),
    h('div', { className: 'composer-wrap' },
      state.pendingAttachments?.length
        ? h('div', { className: 'attach-strip' },
            ...state.pendingAttachments.map((attachment: any, index: number) =>
              h('div', { className: 'attach-chip' },
                h('span', { className: 'name' }, attachment?.name || 'attachment'),
                h('button', {
                  className: 'remove',
                  title: 'Remove attachment',
                  onClick: () => removePendingAttachment(index),
                }, '×')
              )
            )
          )
        : null,
      textarea
    ),
    h('button', {
      className: 'send-btn',
      onClick: () => {
        void options.sendMessage(textarea.value);
        textarea.value = '';
        textarea.style.height = 'auto';
      },
      disabled: state.streaming ? 'true' : null,
    }, 'Send')
  ));

  setTimeout(() => {
    options.renderMessages();
    scrollMessages();
  }, 0);

  return view;
}
