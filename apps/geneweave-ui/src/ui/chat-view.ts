import { state } from './state.js';
import { h } from './dom.js';
import {
  scrollMessages,
  toggleAudioRecording,
  queueFiles,
  removePendingAttachment,
} from './utils.js';
import {
  initVoiceSession,
  endVoiceSession,
  togglePause,
  toggleVoiceSettings,
  loadVoiceConfig,
  saveVoiceConfig,
  VOICE_BAR_COUNT,
} from './voice-agent.js';

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

  // ── Voice pipeline settings ────────────────────────────────
  rows.push(sep());
  rows.push(sectionLabel('Voice Pipeline'));

  const vcfg = (state as any).voiceConfig as null | {
    pipelineMode: 'chained' | 'realtime';
    realtimeModel: string;
    ttsVoice: string;
    ttsSpeed: number;
    sttLanguage: string | null;
    ttsModel: string;
  };

  const voices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
  const pMode: 'chained' | 'realtime' = vcfg?.pipelineMode ?? 'chained';

  // Pipeline mode toggle
  rows.push(
    h('div', { style: 'display:flex;gap:4px' },
      ...(['chained', 'realtime'] as const).map((m) =>
        h('button', {
          className: 'vs-mode-btn' + (pMode === m ? ' active' : ''),
          title: m === 'chained'
            ? 'Whisper STT → LLM → tts-1 TTS — full guardrails & cost tracking'
            : 'OpenAI Realtime API — native speech-to-speech, lowest latency',
          onClick: (e: Event) => {
            e.stopPropagation();
            void saveVoiceConfig({ pipelineMode: m }).then(options.render);
          },
        }, m === 'chained' ? '🔗 Chained (Whisper + TTS)' : '⚡ Realtime (GPT-4o)')
      )
    )
  );

  if (vcfg) {
    // Voice selector
    rows.push(
      h('div', { className: 'setting-sub' },
        h('span', null, 'Voice'),
        h('select', {
          value: vcfg.ttsVoice,
          onClick: (e: Event) => e.stopPropagation(),
          onChange: (e: Event) => {
            void saveVoiceConfig({ ttsVoice: (e.target as HTMLSelectElement).value }).then(options.render);
          },
        },
          ...voices.map((v) => h('option', { value: v, selected: v === vcfg.ttsVoice ? 'true' : null }, v))
        )
      )
    );

    if (pMode === 'chained') {
      // TTS model
      rows.push(
        h('div', { className: 'setting-sub' },
          h('span', null, 'TTS model'),
          h('select', {
            value: vcfg.ttsModel,
            onClick: (e: Event) => e.stopPropagation(),
            onChange: (e: Event) => {
              void saveVoiceConfig({ ttsModel: (e.target as HTMLSelectElement).value }).then(options.render);
            },
          },
            h('option', { value: 'tts-1', selected: vcfg.ttsModel === 'tts-1' ? 'true' : null }, 'tts-1 (faster)'),
            h('option', { value: 'tts-1-hd', selected: vcfg.ttsModel === 'tts-1-hd' ? 'true' : null }, 'tts-1-hd (higher quality)'),
          )
        )
      );
    } else {
      // Realtime model
      rows.push(
        h('div', { className: 'setting-sub' },
          h('span', null, 'Realtime model'),
          h('select', {
            value: vcfg.realtimeModel,
            onClick: (e: Event) => e.stopPropagation(),
            onChange: (e: Event) => {
              void saveVoiceConfig({ realtimeModel: (e.target as HTMLSelectElement).value }).then(options.render);
            },
          },
            h('option', { value: 'gpt-realtime-2', selected: vcfg.realtimeModel === 'gpt-realtime-2' ? 'true' : null }, 'gpt-realtime-2'),
            h('option', { value: 'gpt-4o-mini-realtime-preview', selected: vcfg.realtimeModel === 'gpt-4o-mini-realtime-preview' ? 'true' : null }, 'gpt-4o-mini-realtime-preview'),
          )
        )
      );
    }
  } else {
    rows.push(h('div', { style: 'font-size:11px;color:var(--fg3);padding:4px 0' }, 'Loading voice config…'));
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

  // Voice agent bar (shown when voice agent is active)
  const STATUS_LABEL: Record<string, string> = {
    idle:       'Ready — click mic to start',
    listening:  'Listening...',
    recording:  'Hearing you...',
    processing: 'Thinking...',
    playing:    'Agent speaking...',
    paused:     'Paused',
  };

  // Voice bar: IDs on every mutable element so voice-agent.ts can patch them
  // directly without triggering a full re-render.
  const waveBars: HTMLElement[] = [];
  for (let i = 0; i < VOICE_BAR_COUNT; i++) {
    waveBars.push(h('div', { className: 'va-wave-bar' }));
  }

  const voiceBar = state.voiceAgentActive
    ? h('div', { className: 'voice-bar' },
        h('div', { className: 'voice-bar-top' },
          h('div', { id: 'va-dot', className: 'voice-status-indicator voice-status-' + state.voiceStatus }),
          h('span', { id: 'va-label', className: 'voice-status-label' }, STATUS_LABEL[state.voiceStatus] || 'Ready'),
          h('div', { style: 'flex:1' }),
          h('button', {
            id: 'va-pause-btn',
            className: 'voice-pause-btn',
            title: 'Pause conversation',
            innerHTML: '&#9646;&#9646; Pause',
            onClick: () => { togglePause(); },
          }),
          h('button', {
            id: 'va-settings-btn',
            className: 'voice-settings-btn' + (state.voiceSettingsOpen ? ' active' : ''),
            title: 'Voice settings',
            innerHTML: '&#9881;',
            onClick: () => {
              toggleVoiceSettings();
              if (state.voiceSettingsOpen && !state.voiceConfig) void loadVoiceConfig();
            },
          }),
          h('button', {
            className: 'voice-end-btn',
            title: 'End voice session',
            onClick: () => { void endVoiceSession(); },
          }, '✕'),
        ),
        h('div', { id: 'va-waveform', className: 'va-waveform' }, ...waveBars),
        // Exchange + error: always in DOM, shown/hidden directly by voice-agent.ts
        h('div', { id: 'va-exchange', className: 'voice-exchange', style: 'display:none' },
          h('div', { id: 'va-you', className: 'voice-you', style: 'display:none' },
            h('span', { className: 'voice-label' }, 'You '),
            h('span', { id: 'va-you-text' }),
          ),
          h('div', { id: 'va-agent', className: 'voice-agent-line', style: 'display:none' },
            h('span', { className: 'voice-label' }, 'Agent '),
            h('span', { id: 'va-agent-text' }),
          ),
        ),
        h('div', { id: 'va-error', className: 'voice-error', style: 'display:none' }),
        // Settings panel — always in DOM when voice bar is shown, shown/hidden by toggleVoiceSettings()
        h('div', {
          id: 'va-settings',
          className: 'va-settings-panel',
          style: state.voiceSettingsOpen ? '' : 'display:none',
        }),
      )
    : null;

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
      }),
      h('button', {
        className: 'tool-btn voice-agent-btn' + (state.voiceAgentActive ? ' active' : ''),
        title: state.voiceAgentActive ? 'End voice agent session' : 'Start voice agent (Whisper + Claude + TTS)',
        'aria-label': state.voiceAgentActive ? 'End voice agent' : 'Start voice agent',
        'aria-pressed': state.voiceAgentActive ? 'true' : 'false',
        innerHTML:
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"></path>' +
            '<path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>' +
            '<path d="M8 21h8"></path><path d="M12 17v4"></path>' +
            '<circle cx="18" cy="5" r="3" fill="var(--accent)" stroke="none"></circle>' +
          '</svg>',
        onClick: () => {
          if (state.voiceAgentActive) {
            void endVoiceSession();
          } else {
            void initVoiceSession();
          }
        },
      }),
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
      voiceBar,
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
