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

  const modes = [
    { id: 'direct', icon: '💬', title: 'Direct', desc: 'Simple model chat without orchestration' },
    { id: 'agent', icon: '🤖', title: 'Agent', desc: 'Autonomous tool-calling with reasoning loop' },
    { id: 'supervisor', icon: '🧠', title: 'Supervisor', desc: 'Multi-agent delegation to specialists' },
  ];

  const modeCards = modes.map((mode) =>
    h('div', {
      className: 'mode-card' + (settings.mode === mode.id ? ' selected' : ''),
      onClick: () => {
        settings.mode = mode.id;
        void options.saveChatSettings();
        options.render();
      },
    },
      h('div', { className: 'mc-icon' }, mode.icon),
      h('div', null,
        h('div', { className: 'mc-title' }, mode.title),
        h('div', { style: 'font-size:12px;color:var(--fg3);margin-top:2px;' }, mode.desc)
      )
    )
  );

  return h('div', { className: 'dropdown settings-dd', onClick: (e: Event) => e.stopPropagation() },
    h('h3', null, h('span', null, '⚙'), ' Agentic AI Settings'),
    h('div', { style: 'display:flex;flex-direction:column;gap:10px;' },
      h('div', { style: 'font-size:11px;color:var(--fg3);font-weight:700;text-transform:uppercase;letter-spacing:.4px;' }, 'AI Mode'),
      ...modeCards
    )
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
