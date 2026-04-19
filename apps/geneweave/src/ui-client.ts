// Main geneWeave UI module - orchestrates all UI components
// Imports from modularized ui/ subdirectory

import {
  state,
  getCalendarFocusDate,
  setCalendarFocusDate,
  shiftCalendarMonth,
  toYMD,
  getTodayLabel,
} from './ui/state.js';
import { h } from './ui/dom.js';
import { STYLES } from './ui/styles.js';
import { 
  getUserAvatarUrl, 
  getAgentAvatarUrl,
  scrollMessages,
  toggleAudioRecording,
  queueFiles,
  removePendingAttachment,
  mdToHtml,
  copyResponse,
  emailResponse,
  openInWord
} from './ui/utils.js';
import { 
  api, 
  loadChats, 
  selectChat, 
  createChat, 
  deleteChat,
  normalizeServerMessage,
  loadModels,
  loadTools,
  loadUserPreferences,
  loadAdmin,
  loadDashboard,
  loadConnectors,
  loadCredentials,
  loadSSOProviders,
  loadOAuthAccounts,
  loadPasswordProviders,
  loadChatSettings,
  saveChatSettings
} from './ui/api.js';

import { 
  doLogout,
  renderAuth
} from './ui/auth.js';
import type { Message, Chat } from './ui/types.js';


// ============================================================================
// RENDERING FUNCTIONS
// ============================================================================

const dashboardFlowFilters: { mode: string; agent: string; toolQuery: string } = {
  mode: 'all',
  agent: 'all',
  toolQuery: '',
};

function extractWorkerToolTrace(value: unknown): any[] {
  if (typeof value !== 'string') return [];
  const marker = '[WorkerToolTrace]';
  const traceIdx = value.indexOf(marker);
  if (traceIdx < 0) return [];
  const raw = value.slice(traceIdx + marker.length).trim();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonMaybeLoose(value: unknown): any {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function buildTimelineItem(item: any, idx: number, processUi: any, message: any): HTMLElement {
  const dur = item.durationMs != null ? item.durationMs + 'ms' : '';
  const keyBase = item.key || ('timeline-' + idx);
  const showRaw = !!processUi.detailExpanded[keyBase + '-raw'];
  const showInput = !!processUi.detailExpanded[keyBase + '-input'];
  const showOutput = !!processUi.detailExpanded[keyBase + '-output'];
  const badgeEls = Array.isArray(item.badges) && item.badges.length
    ? h('div', { className: 'timeline-badges' }, ...item.badges.map((badge: any) => h('span', { className: 'timeline-badge ' + (badge.tone || 'ok') }, badge.label)))
    : null;

  return h('div', { className: 'timeline-item ' + item.kind + (item.isWorker ? ' worker' : '') },
    h('div', { className: 't-h' },
      h('span', null, item.title || ('Event ' + (idx + 1))),
      h('span', null, dur)
    ),
    badgeEls,
    item.summary ? h('div', { className: 't-summary' }, item.summary) : null,
    (item.raw || item.inputRaw || item.outputRaw) ? h('div', { className: 't-actions' },
      item.raw ? h('button', {
        className: 'detail-toggle',
        type: 'button',
        'aria-expanded': String(showRaw),
        onClick: () => { toggleProcessDetail(message, keyBase + '-raw'); renderMessages(); },
      }, showRaw ? 'Hide raw ' + (item.detailLabel || 'details') : 'View raw ' + (item.detailLabel || 'details')) : null,
      item.inputRaw ? h('button', {
        className: 'detail-toggle',
        type: 'button',
        'aria-expanded': String(showInput),
        onClick: () => { toggleProcessDetail(message, keyBase + '-input'); renderMessages(); },
      }, showInput ? 'Hide input' : 'View input') : null,
      item.outputRaw ? h('button', {
        className: 'detail-toggle',
        type: 'button',
        'aria-expanded': String(showOutput),
        onClick: () => { toggleProcessDetail(message, keyBase + '-output'); renderMessages(); },
      }, showOutput ? 'Hide output' : 'View output') : null
    ) : null,
    item.raw && showRaw ? h('div', { className: 't-raw' },
      h('div', { className: 't-raw-label' }, 'Raw ' + (item.detailLabel || 'details')),
      renderProcessDetailView(item.raw)
    ) : null,
    item.inputRaw && showInput ? h('div', { className: 't-raw' },
      h('div', { className: 't-raw-label' }, 'Tool input'),
      renderProcessDetailView(item.inputRaw)
    ) : null,
    item.outputRaw && showOutput ? h('div', { className: 't-raw' },
      h('div', { className: 't-raw-label' }, 'Tool output'),
      renderProcessDetailView(item.outputRaw)
    ) : null
  );
}

function touchChat(chatId: string, titleOverride?: string) {
  const index = state.chats.findIndex((chat: Chat) => chat.id === chatId);
  if (index < 0) return;
  const chat = state.chats[index];
  const updated = {
    ...chat,
    title: titleOverride ?? chat.title,
    updated_at: new Date().toISOString(),
  };
  state.chats.splice(index, 1);
  state.chats.unshift(updated);
}

async function sendMessage(text: string) {
  const content = String(text || '').trim();
  const attachments = (state.pendingAttachments || []).slice();
  if ((!content && !attachments.length) || state.streaming) return;
  if (!state.currentChatId) {
    await createChat();
  }
  const chatId = state.currentChatId;
  if (!chatId) return;
  
  state.messages.push({
    role: 'user',
    content,
    attachments,
    created_at: new Date().toISOString(),
    metadata: attachments.length ? JSON.stringify({ attachments }) : null,
  });
  state.pendingAttachments = [];
  state.streaming = true;
  render();
  scrollMessages();

  const modelParts = String(state.selectedModel || '').split(':');
  const body = {
    content,
    stream: true,
    model: modelParts[1] || undefined,
    provider: modelParts[0] || undefined,
    attachments: attachments.length ? attachments : undefined,
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;

  const startedAtMs = Date.now();
  let assistantMsg: any = null;
  
  try {
    const resp = await fetch(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`Streaming request failed (${resp.status})`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    assistantMsg = {
      role: 'assistant',
      content: '',
      usage: null,
      cost: 0,
      latency_ms: 0,
      created_at: new Date().toISOString(),
      steps: [],
      evalResult: null,
      redaction: null,
      mode: state.chatSettings?.mode || 'direct',
      processState: 'running',
      processExpanded: true,
      processUi: { detailExpanded: Object.create(null) },
      activeSkills: [],
      enabledTools: [],
      skillTools: [],
      skillPromptApplied: false,
    };
    state.messages.push(assistantMsg);
    render();
    scrollMessages();

    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if (d.type === 'text') assistantMsg.content += d.text || '';
          else if (d.type === 'reasoning' && d.text) assistantMsg.steps.push({ type: 'thinking', text: d.text });
          else if (d.type === 'step') assistantMsg.steps.push(d.step || d);
          else if (d.type === 'tool_start') assistantMsg.steps.push({ kind: 'tool_start', name: d.name, input: d.input });
          else if (d.type === 'tool_end') {
            const last = assistantMsg.steps[assistantMsg.steps.length - 1];
            if (last && last.kind === 'tool_start') last.result = d.result;
          }
          else if (d.type === 'redaction') assistantMsg.redaction = d;
          else if (d.type === 'eval') assistantMsg.evalResult = d;
          else if (d.type === 'cognitive') assistantMsg.cognitive = d;
          else if (d.type === 'guardrail') assistantMsg.guardrail = d;
          else if (d.type === 'screenshot') {
            if (!assistantMsg.screenshots) assistantMsg.screenshots = [];
            assistantMsg.screenshots.push({ base64: d.base64, format: d.format || 'png' });
          }
          else if (d.type === 'handoff') {
            state.handoffRequest = d;
            render();
          }
          else if (d.type === 'done') {
            assistantMsg.usage = d.usage;
            assistantMsg.cost = d.cost;
            assistantMsg.latency_ms = d.latencyMs;
            if (d.steps) assistantMsg.steps = d.steps;
            if (d.eval) assistantMsg.evalResult = d.eval;
            if (d.cognitive) assistantMsg.cognitive = d.cognitive;
            assistantMsg.activeSkills = Array.isArray(d.activeSkills) ? d.activeSkills : [];
            assistantMsg.enabledTools = Array.isArray(d.enabledTools) ? d.enabledTools : [];
            assistantMsg.skillTools = Array.isArray(d.skillTools) ? d.skillTools : [];
            assistantMsg.skillPromptApplied = !!d.skillPromptApplied;
            assistantMsg.processState = 'completed';
            // Keep completed process expanded so delegation/tool chain-of-thought remains visible.
            assistantMsg.processExpanded = true;
          }
          else if (d.type === 'error') {
            assistantMsg.content += `\n[Error: ${d.error}]`;
            assistantMsg.processState = 'error';
            assistantMsg.processExpanded = true;
          }
          else if (d?.type) {
            assistantMsg.steps.push({ type: d.type, content: d.text || d.message || JSON.stringify(d) });
          }
        } catch {
          // Ignore malformed streaming events.
        }
      }

      renderMessages();
      scrollMessages();
    }
  } catch (e) {
    try {
      const nonStreamResp = await fetch(`/api/chats/${chatId}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, stream: false }),
        credentials: 'same-origin',
      });
      if (nonStreamResp.ok) {
        const payload = await nonStreamResp.json();
        const recoveredMsg = {
          role: 'assistant',
          content: String(payload.assistantContent || ''),
          usage: payload.usage || null,
          cost: payload.cost || 0,
          latency_ms: payload.latencyMs || 0,
          created_at: new Date().toISOString(),
          steps: Array.isArray(payload.steps) ? payload.steps : [],
          evalResult: payload.eval || null,
          redaction: payload.redaction || null,
          mode: state.chatSettings?.mode || 'direct',
          activeSkills: Array.isArray(payload.activeSkills) ? payload.activeSkills : [],
          enabledTools: Array.isArray(payload.enabledTools) ? payload.enabledTools : [],
          skillTools: Array.isArray(payload.skillTools) ? payload.skillTools : [],
          skillPromptApplied: !!payload.skillPromptApplied,
          processState: 'completed',
          processExpanded: true,
          processUi: { detailExpanded: Object.create(null) },
        };
        if (assistantMsg) {
          Object.assign(assistantMsg, recoveredMsg);
        } else {
          state.messages.push(recoveredMsg);
        }
        state.streaming = false;
        render();
        return;
      }
    } catch {
      // ignore fallback failures
    }

    let recovered = false;
    try {
      const hist = await api.get(`/chats/${chatId}/messages`);
      if (hist.ok) {
        const rows = (await hist.json()).messages ?? [];
        const candidates = rows.filter((m: any) => {
          if (!m || m.role !== 'assistant' || !m.content) return false;
          const ts = Date.parse(m.created_at || '');
          return Number.isFinite(ts) && ts >= (startedAtMs - 15000);
        });
        if (candidates.length) {
          const latest = normalizeServerMessage(candidates[candidates.length - 1]);
          if (assistantMsg) {
            assistantMsg.content = String(latest.content || '');
            assistantMsg.steps = Array.isArray(latest.steps) ? latest.steps : assistantMsg.steps;
            assistantMsg.evalResult = latest.evalResult || assistantMsg.evalResult;
            assistantMsg.cognitive = latest.cognitive || assistantMsg.cognitive;
            assistantMsg.guardrail = latest.guardrail || assistantMsg.guardrail;
            assistantMsg.activeSkills = Array.isArray(latest.activeSkills) ? latest.activeSkills : assistantMsg.activeSkills;
            assistantMsg.skillTools = Array.isArray(latest.skillTools) ? latest.skillTools : assistantMsg.skillTools;
            assistantMsg.enabledTools = Array.isArray(latest.enabledTools) ? latest.enabledTools : assistantMsg.enabledTools;
            assistantMsg.skillPromptApplied = !!latest.skillPromptApplied;
            assistantMsg.mode = latest.mode || assistantMsg.mode;
          } else {
            state.messages.push(latest);
          }
          recovered = true;
        }
      }
    } catch {
      // ignore recovery failures
    }

    if (!recovered) {
      state.messages.push({
        role: 'assistant',
        content: `[Connection error: ${String((e as any)?.message || e)}]`,
        created_at: new Date().toISOString(),
      } as any);
    }
  }
  
  state.streaming = false;
  const chat = state.chats.find((c: Chat) => c.id === chatId);
  if (chat && chat.title === 'New Chat' && content.length > 0) {
    const newTitle = content.slice(0, 40) + (content.length > 40 ? '…' : '');
    touchChat(chatId, newTitle);
    api.put(`/chats/${chatId}`, { title: newTitle }).catch(() => {});
  } else {
    touchChat(chatId);
  }
  render();
  scrollMessages();
}

function parseMessageMetadata(raw: any): any {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function shortText(value: any, maxLen?: number): string {
  if (value == null) return '';
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (raw.length <= (maxLen || 280)) return raw;
  return raw.slice(0, maxLen || 280) + '...';
}

function detailText(value: any): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function summarizeForDisplay(value: any, maxLen?: number): string {
  const raw = detailText(value);
  if (!raw) return '';
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (compact.length <= (maxLen || 180)) return compact;
  return compact.slice(0, maxLen || 180) + '...';
}

function parseJsonMaybe(text: string): any {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try { return JSON.parse(trimmed); } catch (_e) { return null; }
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function parseDelimitedTable(text: string): { headers: string[]; rows: string[][] } | null {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const delimiters = [',', '\t', '|'];
  for (const delimiter of delimiters) {
    const parsed = lines.slice(0, Math.min(lines.length, 40)).map((line) => parseDelimitedLine(line, delimiter));
    const width = parsed[0]?.length || 0;
    if (width < 2) continue;
    if (!parsed.every((row) => row.length === width)) continue;
    const headers = parsed[0]!.map((h, idx) => h || ('col_' + (idx + 1)));
    const rows = parsed.slice(1);
    if (rows.length < 1) continue;
    return { headers, rows };
  }
  return null;
}

function formatXml(xmlText: string): string | null {
  if (typeof xmlText !== 'string') return null;
  const trimmed = xmlText.trim();
  if (!/^<([A-Za-z_][\w:.-]*)(\s|>)/.test(trimmed)) return null;
  try {
    const parser = new DOMParser();
    const parsed = parser.parseFromString(trimmed, 'application/xml');
    if (parsed.getElementsByTagName('parsererror').length) return null;
    const raw = new XMLSerializer().serializeToString(parsed).replace(/>(\s*)</g, '><');
    const lines = raw.replace(/(>)(<)(\/?)/g, '$1\n$2$3').split('\n');
    let pad = 0;
    return lines.map((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine) return '';
      if (/^<\//.test(trimmedLine)) pad = Math.max(0, pad - 1);
      const out = '  '.repeat(pad) + trimmedLine;
      if (/^<[^!?/][^>]*[^/]?>$/.test(trimmedLine)) pad++;
      return out;
    }).filter(Boolean).join('\n');
  } catch (_e) {
    return null;
  }
}

function detectCodeLanguage(text: string): string {
  const t = String(text || '');
  if (/(^|\n)\s*(SELECT|INSERT|UPDATE|DELETE)\s+/i.test(t)) return 'sql';
  if (/(^|\n)\s*(function|const|let|class|import|export)\b/.test(t) || /=>/.test(t)) return 'javascript';
  if (/(^|\n)\s*(def |class |import |from |if __name__ ==)/.test(t)) return 'python';
  if (/(^|\n)\s*(<\/?[A-Za-z_][\w:.-]*|<\?xml)/.test(t)) return 'xml';
  return 'text';
}

function normalizeCodeLanguage(language: string): string {
  const lang = String(language || '').trim().toLowerCase();
  if (!lang) return '';
  if (lang === 'py') return 'python';
  if (lang === 'js') return 'javascript';
  if (lang === 'ts') return 'typescript';
  if (lang === 'yml') return 'yaml';
  return lang;
}

function friendlyLanguageName(language: string): string {
  const lang = normalizeCodeLanguage(language) || 'text';
  if (lang === 'python') return 'Python';
  if (lang === 'javascript') return 'JavaScript';
  if (lang === 'typescript') return 'TypeScript';
  if (lang === 'sql') return 'SQL';
  if (lang === 'json') return 'JSON';
  if (lang === 'xml') return 'XML';
  if (lang === 'yaml') return 'YAML';
  if (lang === 'bash' || lang === 'shell') return 'Shell';
  return lang.toUpperCase();
}

function looksLikeCode(text: string): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.split(/\r?\n/).length < 2) return false;
  let score = 0;
  if (/[{};]/.test(trimmed)) score++;
  if (/(^|\n)\s*(function|const|let|class|import|export|def|return|if|for|while)\b/.test(trimmed)) score++;
  if (/=>|<\/?[A-Za-z]/.test(trimmed)) score++;
  return score >= 2;
}

function tableFromJson(value: any): { headers: string[]; rows: string[][] } | null {
  if (!Array.isArray(value) || !value.length) return null;
  if (!value.every((row) => row && typeof row === 'object' && !Array.isArray(row))) return null;
  const headers: string[] = [];
  value.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (!headers.includes(key)) headers.push(key);
    });
  });
  if (headers.length < 2) return null;
  const rows = value.map((row) => headers.map((key) => {
    const v = row[key];
    if (v == null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  }));
  return { headers, rows };
}

function extractCodePayloadFromJson(value: any): { code: string; language: string } | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  const language = normalizeCodeLanguage(value.language || value.lang || value.syntax || value.format);
  const candidates = ['code', 'source', 'script', 'program', 'content', 'text', 'body', 'query'];
  for (const key of candidates) {
    const candidate = value[key];
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (language || looksLikeCode(trimmed) || detectCodeLanguage(trimmed) !== 'text') {
      return {
        code: candidate,
        language: language || detectCodeLanguage(trimmed),
      };
    }
  }
  return null;
}

function renderDetailTable(headers: string[], rows: string[][]): HTMLElement {
  return h('div', { className: 'detail-table-wrap' },
    h('table', { className: 'detail-table' },
      h('thead', null,
        h('tr', null,
          ...headers.map((col) => h('th', null, col))
        )
      ),
      h('tbody', null,
        ...rows.map((row) => h('tr', null,
          ...row.map((cell) => h('td', null, formatMaybeCompactValue(cell)))
        ))
      )
    )
  );
}

function renderDetailCode(text: string, language: string, kind: string): HTMLElement {
  const codeText = text || '';
  const lang = normalizeCodeLanguage(language) || detectCodeLanguage(codeText);
  const badge = friendlyLanguageName(lang);
  const copyBtn = h('button', {
    className: 'detail-copy-btn',
    type: 'button',
    title: 'Copy code',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(codeText);
      } catch {
        // no-op
      }
      copyBtn.classList.add('copied');
      copyBtn.textContent = 'Copied';
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.textContent = 'Copy';
      }, 1200);
    },
  }, 'Copy');
  return h('div', { className: 'detail-block' },
    h('div', { className: 'detail-block-hdr' },
      h('span', { className: 'detail-lang' }, badge),
      h('div', { className: 'detail-block-actions' },
        h('span', { className: 'detail-kind' }, kind || 'formatted'),
        copyBtn
      )
    ),
    h('pre', { className: 'detail-code' }, codeText)
  );
}

function processStageMeta(stage: string) {
  if (stage === 'error') return { label: 'Error', icon: '!', tone: 'deny' };
  if (stage === 'completed') return { label: 'Completed', icon: '✓', tone: 'ok' };
  if (stage === 'validating') return { label: 'Validating', icon: '◉', tone: 'warn' };
  if (stage === 'tools') return { label: 'Using Tools', icon: '⚙', tone: 'ok' };
  if (stage === 'finalizing') return { label: 'Finalizing', icon: '↗', tone: 'ok' };
  return { label: 'Thinking', icon: '…', tone: 'ok' };
}

function ensureProcessUiState(msg: any) {
  if (!msg.processUi || typeof msg.processUi !== 'object') {
    msg.processUi = { detailExpanded: Object.create(null) };
  }
  if (!msg.processUi.detailExpanded || typeof msg.processUi.detailExpanded !== 'object') {
    msg.processUi.detailExpanded = Object.create(null);
  }
  return msg.processUi;
}

function toggleProcessDetail(msg: any, key: string) {
  const ui = ensureProcessUiState(msg);
  ui.detailExpanded[key] = !ui.detailExpanded[key];
}

function processStatusTone(status: string) {
  if (status === 'deny' || status === 'fail' || status === 'error') return 'deny';
  if (status === 'warn' || status === 'redacted') return 'warn';
  return 'ok';
}

function extractThoughtText(step: any) {
  if (!step) return '';
  if (step.type === 'thinking') return String(step.text || step.content || '').trim();
  const toolName = step?.toolCall?.name || step?.name || step?.toolName || '';
  if (toolName !== 'think') return '';
  const args = step?.toolCall?.arguments ?? step?.input;
  const result = step?.toolCall?.result ?? step?.result;
  if (typeof result === 'string' && result.trim()) {
    return result.replace(/^\[(PLANNING|REASONING|SYNTHESIS|REFLECTION)\]\s*/, '').trim();
  }
  if (typeof args === 'string' && args.trim()) return args.trim();
  if (args && typeof args === 'object') {
    const candidate = args.reasoning || args.thought || args.content || args.summary || args.prompt || args.goal;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function extractDelegatedWorkerName(value: any): string {
  if (!value) return '';
  if (typeof value === 'object') {
    const worker = value.worker || value.workerName || value.agent || value.name;
    return typeof worker === 'string' ? worker : '';
  }
  if (typeof value === 'string') {
    const parsed = parseJsonMaybe(value);
    if (parsed && typeof parsed === 'object') {
      const worker = (parsed as any).worker || (parsed as any).workerName || (parsed as any).agent || (parsed as any).name;
      return typeof worker === 'string' ? worker : '';
    }
  }
  return '';
}

function renderProcessDetailView(value: any) {
  const text = detailText(value);
  if (!text) return h('div', { className: 't-b' }, 'No detail data');
  const trimmed = text.trim();

  const bt = String.fromCharCode(96);
  const triple = bt + bt + bt;
  if (trimmed.startsWith(triple)) {
    const fenceLines = trimmed.split(/\r?\n/);
    if (fenceLines.length >= 2 && fenceLines[fenceLines.length - 1] === triple) {
      const lang = fenceLines[0]!.slice(3).trim();
      const body = fenceLines.slice(1, -1).join('\n');
      return renderDetailCode(body, lang || detectCodeLanguage(body), 'code');
    }
  }

  const json = parseJsonMaybe(trimmed);
  if (json != null) {
    const codePayload = extractCodePayloadFromJson(json);
    if (codePayload) return renderDetailCode(codePayload.code, codePayload.language, 'code');
    const table = tableFromJson(json);
    if (table) return renderDetailTable(table.headers, table.rows);
    return renderDetailCode(JSON.stringify(json, null, 2), 'json', 'json');
  }

  const xml = formatXml(trimmed);
  if (xml) return renderDetailCode(xml, 'xml', 'xml');

  const delimited = parseDelimitedTable(trimmed);
  if (delimited) return renderDetailTable(delimited.headers, delimited.rows);

  if (looksLikeCode(trimmed)) return renderDetailCode(trimmed, detectCodeLanguage(trimmed), 'code');

  return h('div', { className: 't-b' }, text);
}

function numericValue(v: any): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,%\s,]/g, '');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isLikelyYear(value: number): boolean {
  return Number.isInteger(value) && value >= 1900 && value <= 2100;
}

function trimTrailingZeros(value: string): string {
  return value.replace(/\.0+$|(?<=\.\d*[1-9])0+$/g, '');
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (isLikelyYear(value)) return String(value);
  const abs = Math.abs(value);
  if (abs < 1000) {
    if (Number.isInteger(value)) return String(value);
    return trimTrailingZeros(value.toFixed(abs < 10 ? 2 : 1));
  }

  const units = ['k', 'M', 'B', 'T'];
  let scaled = abs;
  let unitIndex = -1;
  while (scaled >= 1000 && unitIndex < units.length - 1) {
    scaled /= 1000;
    unitIndex += 1;
  }
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  const formatted = trimTrailingZeros(scaled.toFixed(decimals));
  return `${value < 0 ? '-' : ''}${formatted}${units[Math.max(unitIndex, 0)]}`;
}

function formatMaybeCompactValue(value: any): string {
  if (value == null) return '';
  if (typeof value === 'number') return formatCompactNumber(value);
  if (typeof value !== 'string') return String(value);

  const trimmed = value.trim();
  const match = trimmed.match(/^([^\d+\-]*)([+\-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)([^\d]*)$/);
  if (!match) return value;

  const prefix = match[1] || '';
  const numericPart = match[2] || '';
  const suffix = match[3] || '';
  if (suffix.includes('%')) return value;

  const parsed = numericValue(numericPart);
  if (parsed == null) return value;
  if (Math.abs(parsed) < 1000 || isLikelyYear(parsed)) return prefix + numericPart + suffix;
  return prefix + formatCompactNumber(parsed) + suffix;
}

function formatCurrencyCompact(value: number, digits: number = 4): string {
  if (!Number.isFinite(value)) return '$0';
  if (Math.abs(value) >= 1000) return '$' + formatCompactNumber(value);
  return '$' + Number(value).toFixed(digits);
}

function normalizeTableData(headers: any[], rows: any[]): { headers: string[]; rows: string[][] } | null {
  if (!Array.isArray(headers) || !Array.isArray(rows) || !headers.length || !rows.length) return null;
  const normalizedHeaders = headers.map((hd, idx) => String(hd || ('col_' + (idx + 1))));
  const normalizedRows = rows.map((row) => {
    if (Array.isArray(row)) return row.map((cell) => (cell == null ? '' : String(cell)));
    if (row && typeof row === 'object') return normalizedHeaders.map((hd) => (row[hd] == null ? '' : String(row[hd])));
    return [String(row)];
  }).filter((row) => row.length);
  if (!normalizedRows.length) return null;
  return { headers: normalizedHeaders, rows: normalizedRows };
}

function extractResponseTableData(value: any): { headers: string[]; rows: string[][] } | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    if (value.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
      const headers: string[] = [];
      value.forEach((row) => {
        Object.keys(row).forEach((key) => {
          if (!headers.includes(key)) headers.push(key);
        });
      });
      const rows = value.map((row) => headers.map((hd) => {
        const cell = row[hd];
        return cell == null ? '' : (typeof cell === 'string' ? cell : JSON.stringify(cell));
      }));
      return normalizeTableData(headers, rows);
    }
    if (value.every((row) => Array.isArray(row))) {
      return normalizeTableData(value[0]?.map((_, idx) => 'col_' + (idx + 1)) || [], value);
    }
    return null;
  }
  if (typeof value === 'object') {
    if (value.table && typeof value.table === 'object') {
      const fromTable = extractResponseTableData(value.table);
      if (fromTable) return fromTable;
    }
    if (Array.isArray(value.data)) {
      const fromData = extractResponseTableData(value.data);
      if (fromData) return fromData;
    }
    const headers = value.headers || value.columns;
    const rows = value.rows;
    if (Array.isArray(headers) && Array.isArray(rows)) return normalizeTableData(headers, rows);
  }
  return null;
}

function chartSpecFromChartObject(chartObj: any): any {
  if (!chartObj || typeof chartObj !== 'object') return null;
  const type = String(chartObj.type || 'bar').toLowerCase();
  let labels = Array.isArray(chartObj.labels) ? chartObj.labels.map((x: any) => String(x)) : [];
  let values = Array.isArray(chartObj.values) ? chartObj.values.map(numericValue).filter((x: any) => x != null) : [];
  if ((!labels.length || !values.length) && Array.isArray(chartObj.datasets) && chartObj.datasets.length) {
    const ds = chartObj.datasets[0] || {};
    labels = labels.length
      ? labels
      : (Array.isArray(chartObj.labels)
          ? chartObj.labels.map((x: any) => String(x))
          : (Array.isArray(ds.data) ? ds.data.map((_: any, idx: number) => 'item_' + (idx + 1)) : []));
    values = Array.isArray(ds.data) ? ds.data.map(numericValue).filter((x: any) => x != null) : [];
  }
  if (!labels.length || !values.length) return null;
  const len = Math.min(labels.length, values.length, 20);
  return {
    type: type === 'line' ? 'line' : 'bar',
    title: chartObj.title || chartObj.name || 'Chart',
    labels: labels.slice(0, len),
    values: values.slice(0, len),
    unit: chartObj.unit || '',
  };
}

function deriveChartSpecFromTable(tableData: any, hintTitle: string, hintType: string): any {
  if (!tableData) return null;
  const headers = Array.isArray(tableData.headers) ? tableData.headers : [];
  const rows = Array.isArray(tableData.rows) ? tableData.rows : [];
  if (headers.length < 2 || rows.length < 2) return null;

  const title = String(hintTitle || '').trim();
  const lower = title.toLowerCase();
  const preferred: string[] = [];
  if (lower.includes('margin')) preferred.push('margin', '%');
  if (lower.includes('profit')) preferred.push('profit');
  if (lower.includes('revenue') || lower.includes('sales')) preferred.push('revenue', 'sales');
  if (lower.includes('cost') || lower.includes('expense')) preferred.push('cost', 'expense');

  let valueCol = -1;
  const isMostlyNumeric = (colIdx: number) => {
    const numericCount = rows.reduce((acc: number, row: any[]) => acc + (numericValue(row[colIdx]) != null ? 1 : 0), 0);
    return numericCount >= Math.max(2, Math.floor(rows.length * 0.6));
  };

  for (const key of preferred) {
    const idx = headers.findIndex((hd: string) => String(hd || '').toLowerCase().includes(key));
    if (idx > 0 && isMostlyNumeric(idx)) {
      valueCol = idx;
      break;
    }
  }
  if (valueCol < 0) {
    for (let c = 1; c < headers.length; c++) {
      if (isMostlyNumeric(c)) {
        valueCol = c;
        break;
      }
    }
  }
  if (valueCol < 0) return null;

  const points = rows.map((row: any[]) => ({
    label: String(row[0] || ''),
    value: numericValue(row[valueCol]),
  })).filter((point: any) => point.label && point.value != null).slice(0, 20);
  if (points.length < 2) return null;

  return {
    type: String(hintType || '').toLowerCase() === 'line' ? 'line' : 'bar',
    title: title || (headers[valueCol] + ' by ' + headers[0]),
    labels: points.map((p: any) => p.label),
    values: points.map((p: any) => p.value),
    unit: '',
  };
}

function extractResponseChartSpec(value: any, tableData: any): any {
  if (value && typeof value === 'object' && value.chart) {
    const explicit = chartSpecFromChartObject(value.chart);
    if (explicit) return explicit;
  }
  return deriveChartSpecFromTable(tableData, '', 'bar');
}

function extractResponseChartSpecs(value: any, tableData: any): any[] {
  const specs: any[] = [];
  if (value && typeof value === 'object' && value.chart) {
    const chartEntries = Array.isArray(value.chart) ? value.chart : [value.chart];
    chartEntries.forEach((entry: any) => {
      const explicit = chartSpecFromChartObject(entry);
      if (explicit) {
        specs.push(explicit);
        return;
      }
      const fallback = deriveChartSpecFromTable(tableData, entry?.title || entry?.name || '', entry?.type || 'bar');
      if (fallback) specs.push(fallback);
    });
  }
  if (!specs.length) {
    const single = extractResponseChartSpec(value, tableData);
    if (single) specs.push(single);
  }
  return specs;
}

function renderResponseTable(headers: string[], rows: string[][]): HTMLElement {
  return h('div', { className: 'response-table-wrap' },
    h('table', { className: 'response-table' },
      h('thead', null,
        h('tr', null,
          ...headers.map((col) => h('th', null, col))
        )
      ),
      h('tbody', null,
        ...rows.map((row) => h('tr', null,
          ...row.map((cell) => h('td', null, formatMaybeCompactValue(cell)))
        ))
      )
    )
  );
}

function renderResponseChart(spec: any): HTMLElement | null {
  const labels = Array.isArray(spec?.labels) ? spec.labels : [];
  const values = Array.isArray(spec?.values) ? spec.values : [];
  if (!labels.length || !values.length) return null;
  const max = Math.max(...values, 0.0001);
  const unit = spec.unit ? String(spec.unit) : '';
  const title = spec.title || 'Chart';
  if (spec.type === 'line') {
    const width = 560;
    const height = 180;
    const pad = 20;
    const xSpan = Math.max(1, labels.length - 1);
    const points = values.map((v: number, idx: number) => {
      const x = pad + ((width - pad * 2) * idx / xSpan);
      const y = pad + ((height - pad * 2) * (1 - (v / max)));
      return { x, y };
    });
    const path = points.map((p: { x: number; y: number }, idx: number) => (idx === 0 ? 'M' : 'L') + p.x + ' ' + p.y).join(' ');
    return h('div', { className: 'response-chart response-line' },
      h('div', { className: 'response-chart-title' }, title),
      h('svg', { viewBox: '0 0 ' + width + ' ' + height, preserveAspectRatio: 'none' },
        h('line', { className: 'response-line-axis', x1: String(pad), y1: String(height - pad), x2: String(width - pad), y2: String(height - pad) }),
        h('path', { className: 'response-line-path', d: path }),
        ...points.map((p: { x: number; y: number }) => h('circle', { className: 'response-line-dot', cx: String(p.x), cy: String(p.y), r: '2.5' }))
      ),
      h('div', { className: 'response-line-labels' },
        ...labels.map((label: string) => h('span', null, label))
      )
    );
  }
  return h('div', { className: 'response-chart' },
    h('div', { className: 'response-chart-title' }, title),
    h('div', { className: 'response-bars' },
      ...labels.map((label: string, idx: number) => {
        const value = values[idx];
        const widthPct = Math.max(2, Math.round((value / max) * 100));
        return h('div', { className: 'response-bar-row' },
          h('div', { className: 'response-bar-label', title: label }, label),
          h('div', { className: 'response-bar-track' },
            h('div', { className: 'response-bar-fill', style: 'width:' + widthPct + '%' })
          ),
          h('div', { className: 'response-bar-value' }, formatCompactNumber(value) + unit)
        );
      })
    )
  );
}

function renderAssistantStructuredContent(content: string): HTMLElement | null {
  const text = String(content || '');
  const trimmed = text.trim();
  if (!trimmed) return null;

  const json = parseJsonMaybe(trimmed);
  if (json != null) {
    const codePayload = extractCodePayloadFromJson(json);
    if (codePayload) {
      return h('div', { className: 'response-rich' },
        renderDetailCode(codePayload.code, codePayload.language, 'code')
      );
    }
    const table = extractResponseTableData(json);
    const charts = extractResponseChartSpecs(json, table);
    const note = typeof json.summary === 'string'
      ? json.summary
      : typeof json.message === 'string'
        ? json.message
        : typeof json.description === 'string'
          ? json.description
          : '';
    if (charts.length || table) {
      return h('div', { className: 'response-rich' },
        note ? h('p', { className: 'response-note' }, note) : null,
        ...charts.map((spec) => renderResponseChart(spec)).filter(Boolean) as HTMLElement[],
        table ? renderResponseTable(table.headers, table.rows) : null
      );
    }
  }

  const delimited = parseDelimitedTable(trimmed);
  if (delimited) {
    return h('div', { className: 'response-rich' },
      renderResponseTable(delimited.headers, delimited.rows)
    );
  }
  return null;
}

function extractJsonCodeBlocks(text: string): { blocks: any[]; stripped: string } {
  const bt = String.fromCharCode(96);
  const triple = bt + bt + bt;
  if (typeof text !== 'string' || !text.includes(triple)) return { blocks: [], stripped: text || '' };
  const fenceRe = new RegExp(triple + '([^\\n' + bt + ']*)\\n([\\s\\S]*?)' + triple, 'g');
  const blocks: any[] = [];
  let stripped = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text))) {
    const language = String(match[1] || '').trim().toLowerCase();
    const body = String(match[2] || '').trim();
    const parsed = parseJsonMaybe(body);
    if (parsed == null) continue;
    if (language && language !== 'json' && language !== 'application/json' && language !== 'chart' && language !== 'table') continue;
    blocks.push(parsed);
    stripped += text.slice(lastIndex, match.index);
    lastIndex = fenceRe.lastIndex;
  }
  if (!blocks.length) return { blocks: [], stripped: text };
  stripped += text.slice(lastIndex);
  return { blocks, stripped };
}

function renderAssistantEmbeddedStructuredContent(content: string): { markdown: string; node: HTMLElement } | null {
  const extracted = extractJsonCodeBlocks(content);
  if (!extracted.blocks.length) return null;
  const sections: HTMLElement[] = [];
  extracted.blocks.forEach((block) => {
    const table = extractResponseTableData(block);
    const chart = extractResponseChartSpec(block, table);
    const note = typeof block?.summary === 'string'
      ? block.summary
      : typeof block?.message === 'string'
        ? block.message
        : typeof block?.description === 'string'
          ? block.description
          : '';
    if (!chart && !table) return;
    const chartEl = chart ? renderResponseChart(chart) : null;
    sections.push(
      h('div', { className: 'response-rich' },
        note ? h('p', { className: 'response-note' }, note) : null,
        chartEl,
        table ? renderResponseTable(table.headers, table.rows) : null
      )
    );
  });
  if (!sections.length) return null;
  return {
    markdown: String(extracted.stripped || '').trim(),
    node: h('div', { className: 'response-rich response-rich-embedded' }, ...sections),
  };
}

function parseMarkdownListValues(text: string): string[] {
  if (typeof text !== 'string') return [];
  return text.split(',').map((part) => part.trim()).filter(Boolean);
}

function parseMarkdownChartSpecs(text: string): any[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const lines = text.split(/\r?\n/);
  const charts: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    const typeMatch = lines[i]?.trim().match(/^(?:[-*]\s*)?Type:\s*(bar|line)\b/i);
    if (!typeMatch) continue;
    const type = String(typeMatch[1] || 'bar').toLowerCase();
    let labels: string[] = [];
    let values: number[] = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
      const line = lines[j]?.trim() || '';
      const labelsMatch = line.match(/^(?:[-*]\s*)?Labels:\s*(.+)$/i);
      if (labelsMatch) labels = parseMarkdownListValues(labelsMatch[1] || '');
      const valuesMatch = line.match(/^(?:[-*]\s*)?Values:\s*(.+)$/i);
      if (valuesMatch) values = parseMarkdownListValues(valuesMatch[1] || '').map((v) => numericValue(v) as number).filter((v): v is number => v != null);
    }
    if (labels.length < 2 || values.length < 2) continue;
    const len = Math.min(labels.length, values.length, 20);

    let title = 'Chart';
    for (let p = i - 1; p >= Math.max(0, i - 4); p--) {
      const candidate = lines[p]?.trim() || '';
      if (!candidate) continue;
      if (/^(charts?|summary table)$/i.test(candidate.replace(/:$/, ''))) continue;
      if (/^(?:[-*]\s*)?(type|labels|values):/i.test(candidate)) continue;
      title = candidate
        .replace(/^\d+\.\s*/, '')
        .replace(/^[-*]\s*/, '')
        .replace(/^[#>]+\s*/, '')
        .trim();
      if (title) break;
    }

    charts.push({
      type: type === 'line' ? 'line' : 'bar',
      title: title || 'Chart',
      labels: labels.slice(0, len),
      values: values.slice(0, len),
      unit: '',
    });
  }
  return charts;
}

function renderAssistantMarkdownCharts(content: string): HTMLElement | null {
  const charts = parseMarkdownChartSpecs(content);
  if (!charts.length) return null;
  return h('div', { className: 'response-rich response-rich-embedded' },
    ...(charts.map((spec) => renderResponseChart(spec)).filter(Boolean) as HTMLElement[])
  );
}

function buildProcessViewModel(msg: any, isStreamingCurrent: boolean) {
  const steps = Array.isArray(msg.steps) ? msg.steps : [];
  const thoughtHistory: Array<{ text: string; idx: number }> = [];
  const timeline: any[] = [];
  const workerTimeline: any[] = [];
  const cseBadges: Array<{ label: string; tone: string }> = [];
  const seenCseBadges = new Set<string>();
  const cseSessionMap = new Map<string, { sessionId: string; provider: string; runs: number; successes: number; errors: number }>();
  const skills = Array.isArray(msg.activeSkills) ? msg.activeSkills : [];
  const skillEffects: string[] = [];
  const validations: any[] = [];

  steps.forEach((s: any, idx: number) => {
    const stepType = s?.type || s?.kind || 'step';
    const thoughtText = extractThoughtText(s);
    if (thoughtText) {
      thoughtHistory.push({ text: thoughtText, idx: idx + 1 });
      timeline.push({
        kind: 'thought',
        title: 'Thought update',
        summary: summarizeForDisplay(thoughtText),
        raw: detailText(thoughtText),
        detailLabel: 'thought',
        durationMs: s?.durationMs,
        key: 'thought-' + idx,
      });
      if (stepType === 'thinking' || (s?.toolCall?.name || s?.name || s?.toolName) === 'think') return;
    }

    if (stepType === 'thinking') return;

    if (s?.kind === 'tool_start' || stepType === 'tool_call') {
      const toolName = s?.name || s?.toolName || s?.toolCall?.name || 'tool';
      const input = s?.input ?? s?.toolCall?.arguments;
      const result = s?.result ?? s?.toolCall?.result;
      const delegatedWorker = toolName === 'delegate_to_worker' ? extractDelegatedWorkerName(input) : '';
      const toolBadges: Array<{ label: string; tone: string }> = [];
      if (toolName === 'cse_run_code') {
        toolBadges.push({ label: 'Code execution', tone: 'ok' });
      }
      if (delegatedWorker) {
        toolBadges.push({ label: 'Worker ' + delegatedWorker, tone: 'warn' });
      }
      timeline.push({
        kind: toolName === 'delegate_to_worker' ? 'delegation' : 'tool',
        title: toolName === 'delegate_to_worker'
          ? 'Delegated to: ' + (delegatedWorker || 'worker')
          : 'Tool: ' + toolName,
        summary: result != null
          ? 'Input: ' + summarizeForDisplay(input) + '\nOutput: ' + summarizeForDisplay(result)
          : 'Input: ' + summarizeForDisplay(input),
        inputRaw: detailText(input),
        outputRaw: detailText(result),
        durationMs: s?.durationMs,
        badges: toolBadges,
        key: 'tool-' + idx,
      });

      const workerTrace = extractWorkerToolTrace(result);
      workerTrace.forEach((entry: any, traceIdx: number) => {
        const parsedResult = parseJsonMaybeLoose(entry?.result);
        const resultRecord = parsedResult && typeof parsedResult === 'object' && !Array.isArray(parsedResult)
          ? parsedResult as Record<string, any>
          : null;
        const cseTone = resultRecord?.['status'] === 'error' ? 'deny' : resultRecord?.['status'] === 'success' ? 'ok' : 'warn';
        const badges: Array<{ label: string; tone: string }> = [];
        if (entry?.name === 'cse_run_code') {
          const provider = typeof resultRecord?.['provider'] === 'string' ? resultRecord['provider'] : 'local';
          const sessionId = typeof resultRecord?.['sessionId'] === 'string' ? resultRecord['sessionId'] : '';
          const shortSession = sessionId ? sessionId.slice(0, 8) : '';
          badges.push({ label: 'CSE ' + (resultRecord?.['status'] || 'run'), tone: cseTone });
          badges.push({ label: 'Provider ' + provider, tone: 'ok' });
          if (shortSession) badges.push({ label: 'Session ' + shortSession, tone: 'warn' });
          if (sessionId) {
            const current = cseSessionMap.get(sessionId) || { sessionId, provider, runs: 0, successes: 0, errors: 0 };
            current.runs += 1;
            if (resultRecord?.['status'] === 'success') current.successes += 1;
            if (resultRecord?.['status'] === 'error') current.errors += 1;
            cseSessionMap.set(sessionId, current);
          }
          badges.forEach((badge) => {
            const key = badge.label + ':' + badge.tone;
            if (!seenCseBadges.has(key)) {
              seenCseBadges.add(key);
              cseBadges.push(badge);
            }
          });
        }

        workerTimeline.push({
          kind: 'tool',
          title: 'Worker Tool: ' + String(entry?.name || 'tool'),
          summary: entry?.result != null
            ? 'Input: ' + summarizeForDisplay(entry?.arguments) + '\nOutput: ' + summarizeForDisplay(entry?.result)
            : 'Input: ' + summarizeForDisplay(entry?.arguments),
          inputRaw: detailText(entry?.arguments),
          outputRaw: detailText(entry?.result),
          durationMs: entry?.durationMs,
          badges,
          isWorker: true,
          key: 'tool-' + idx + '-worker-' + traceIdx,
        });
      });
      return;
    }

    if (stepType === 'delegation') {
      timeline.push({
        kind: 'delegation',
        title: 'Delegated to: ' + (s?.worker || s?.name || 'worker'),
        summary: summarizeForDisplay(s?.input || s?.message || s?.delegation || ''),
        raw: detailText(s?.input || s?.message || s?.delegation || ''),
        detailLabel: 'delegation',
        durationMs: s?.durationMs,
        key: 'delegation-' + idx,
      });
      return;
    }

    timeline.push({
      kind: stepType === 'response' ? 'response' : 'step',
      title: stepType,
      summary: summarizeForDisplay(s?.text || s?.content || s),
      raw: detailText(s?.text || s?.content || s),
      detailLabel: stepType === 'response' ? 'response' : 'event',
      durationMs: s?.durationMs,
      key: stepType + '-' + idx,
    });
  });

  const liveThought = thoughtHistory.length ? thoughtHistory[thoughtHistory.length - 1]!.text : '';
  if (msg?.skillPromptApplied) skillEffects.push('Prompt guidance injected');
  if (Array.isArray(msg?.skillTools) && msg.skillTools.length) {
    msg.skillTools.forEach((tool: string) => skillEffects.push('Enabled: ' + tool));
  }

  if (msg?.redaction) {
    const redactedCount = msg.redaction.count || msg.redaction.detections?.length || 0;
    validations.push({
      kind: 'redaction',
      label: 'Redaction',
      status: redactedCount > 0 ? 'warn' : 'ok',
      summary: redactedCount > 0 ? `Redacted ${redactedCount} item${redactedCount === 1 ? '' : 's'}` : 'No sensitive content flagged',
    });
  }

  if (msg?.evalResult) {
    const score = msg.evalResult.score != null ? Math.round(Number(msg.evalResult.score) * 100) : null;
    const passed = msg.evalResult.passed ?? msg.evalResult.score >= 1;
    validations.push({
      kind: 'eval',
      label: 'Evaluation',
      status: passed ? 'ok' : 'warn',
      summary: `Score ${score != null ? `${score}%` : 'n/a'} • Passed ${msg.evalResult.passed ?? 'n/a'} • Failed ${msg.evalResult.failed ?? 'n/a'}`,
    });
  }

  if (msg?.cognitive) {
    const confidence = Math.round((msg.cognitive.confidence || 0) * 100);
    const decision = msg.cognitive.decision || 'allow';
    const firstWarn = msg.cognitive.checks?.find((x: any) => x.decision !== 'allow');
    validations.push({
      kind: 'cognitive',
      label: 'Cognitive Check',
      status: decision,
      summary: `Confidence ${confidence}% • ${decision}${firstWarn?.explanation ? ` • ${firstWarn.explanation}` : ''}`,
    });
  }

  if (msg?.guardrail) {
    const guardrailDecision = msg.guardrail.decision || 'allow';
    validations.push({
      kind: 'guardrail',
      label: 'Guardrail',
      status: guardrailDecision,
      summary: `${guardrailDecision}${msg.guardrail.reason ? ` • ${msg.guardrail.reason}` : ''}`,
    });
  }

  let stage = 'thinking';
  if (msg?.processState === 'error') stage = 'error';
  else if (!isStreamingCurrent && (msg?.processState === 'completed' || !!msg?.content)) stage = 'completed';
  else if (isStreamingCurrent && msg?.content) stage = 'finalizing';
  else if (validations.length) stage = 'validating';
  else if (timeline.length) stage = 'tools';

  const toolCount = [...timeline, ...workerTimeline].filter((item: any) => item.kind === 'tool' || item.kind === 'delegation').length;
  const validationTone = validations.length
    ? validations.some((item: any) => processStatusTone(item.status) === 'deny')
      ? 'deny'
      : validations.some((item: any) => processStatusTone(item.status) === 'warn')
        ? 'warn'
        : 'ok'
    : null;

  const summaryChips: Array<{ label: string; tone: string | null }> = [];
  if (skills.length) summaryChips.push({ label: 'Skills: ' + skills.length, tone: 'ok' });
  if (toolCount) summaryChips.push({ label: 'Tools: ' + toolCount, tone: 'ok' });
  if (workerTimeline.length) summaryChips.push({ label: 'Worker Trace: ' + workerTimeline.length, tone: 'warn' });
  if (cseBadges.length) summaryChips.push({ label: 'CSE', tone: 'ok' });
  if (validations.length) summaryChips.push({ label: 'Checks: ' + validationTone, tone: validationTone });
  if (msg?.latency_ms) summaryChips.push({ label: 'Duration: ' + msg.latency_ms + 'ms', tone: 'ok' });

  const hasProcess = isStreamingCurrent || thoughtHistory.length > 0 || timeline.length > 0 || workerTimeline.length > 0 || skills.length > 0 || validations.length > 0;
  const cseSessions = Array.from(cseSessionMap.values()).map((session) => ({
    ...session,
    shortSession: session.sessionId.slice(0, 8),
    reused: session.runs > 1,
  }));

  return {
    hasProcess,
    stage,
    liveThought,
    thoughtCount: thoughtHistory.length,
    timeline,
    workerTimeline,
    cseBadges,
    cseSessions,
    skills,
    skillEffects,
    validations,
    summaryChips,
    expanded: typeof msg.processExpanded === 'boolean' ? msg.processExpanded : isStreamingCurrent,
  };
}

function renderAssistantProcess(m: any, isStreamingCurrent: boolean): HTMLElement | null {
  const processUi = ensureProcessUiState(m);
  const process = buildProcessViewModel(m, isStreamingCurrent);
  if (!process.hasProcess) return null;

  const stageMeta = processStageMeta(process.stage);
  const stageLabel = stageMeta.label || 'Running';
  const summary = (process.timeline.length + process.workerTimeline.length) + ' events' + (process.thoughtCount ? ' • ' + process.thoughtCount + ' thought updates' : '');
  const toggleText = process.expanded ? 'Hide details' : 'Show details';

  const skillCards = process.skills.map((skill: any) => {
    const scorePct = Math.max(0, Math.min(100, Math.round(Number(skill.score || 0) * 100)));
    const skillTools = Array.isArray(skill.tools) ? skill.tools : [];
    return h('div', { className: 'skill-item' },
      h('div', { className: 'skill-item-top' },
        h('span', { className: 'skill-name' }, skill.name || skill.id || 'Unnamed skill'),
        h('span', { className: 'skill-score' }, scorePct + '% match')
      ),
      h('div', { className: 'skill-category' }, String(skill.category || 'general').replace(/_/g, ' ')),
      skillTools.length ? h('div', { className: 'skill-tags' }, ...skillTools.map((t: string) => h('span', { className: 'skill-tag' }, t))) : null
    );
  });

  const validationRows = process.validations.map((item: any) => {
    const tone = processStatusTone(item.status);
    const statusIcon = tone === 'deny' ? '✕' : tone === 'warn' ? '!' : '✓';
    return h('div', { className: 'validation-item ' + tone },
      h('div', { className: 'validation-item-top' },
        h('span', { className: 'validation-name' }, item.label),
        h('span', { className: 'validation-status ' + tone }, statusIcon + ' ' + String(item.status || 'ok'))
      ),
      h('div', { className: 'validation-body' }, item.summary || '')
    );
  });

  const processBody = h('div', { className: 'process-body' },
    process.cseBadges.length ? h('div', { className: 'process-badge-row' },
      ...process.cseBadges.map((badge: any) => h('span', { className: 'summary-chip ' + (badge.tone || 'ok') }, badge.label))
    ) : null,
    process.cseSessions.length ? h('div', { className: 'process-section cse-lifecycle-section' },
      h('div', { className: 'process-section-title' }, 'CSE Lifecycle'),
      h('div', { className: 'cse-session-list' },
        ...process.cseSessions.map((session: any) => h('div', { className: 'cse-session-item' },
          h('div', { className: 'cse-session-top' },
            h('span', { className: 'cse-session-id' }, 'Session ' + session.shortSession),
            h('span', { className: 'timeline-badge ' + (session.reused ? 'warn' : 'ok') }, session.reused ? 'Reused' : 'Single run')
          ),
          h('div', { className: 'cse-session-meta' }, `${session.provider} • ${session.runs} run${session.runs === 1 ? '' : 's'} • ${session.successes} ok • ${session.errors} error${session.errors === 1 ? '' : 's'}`)
        ))
      )
    ) : null,
    h('div', { className: 'live-thought' },
      h('div', { className: 'lbl' }, 'Current thought'),
      h('div', { className: 'txt' }, process.liveThought || (isStreamingCurrent ? 'Thinking...' : 'No thought trace captured.'))
    ),
    process.skills.length ? h('div', { className: 'process-section' },
      h('div', { className: 'process-section-title' }, '✨ Skills Invoked'),
      h('div', { className: 'skill-list' }, ...skillCards),
      process.skillEffects.length ? h('div', { className: 'skill-summary' }, ...process.skillEffects.map((effect: string) => h('span', { className: 'skill-tag' }, effect))) : null
    ) : null,
    process.timeline.length ? h('div', { className: 'process-section' },
      h('div', { className: 'process-section-title' }, 'Timeline'),
      h('div', { className: 'timeline' }, ...process.timeline.map((item: any, idx: number) => buildTimelineItem(item, idx, processUi, m)))
    ) : null,
    process.workerTimeline.length ? h('div', { className: 'process-section worker-trace-section' },
      h('div', { className: 'process-section-title' }, 'Worker Trace'),
      h('div', { className: 'worker-trace-summary' }, 'Nested worker execution details, including container code runs.'),
      h('div', { className: 'timeline worker-trace' }, ...process.workerTimeline.map((item: any, idx: number) => buildTimelineItem(item, idx, processUi, m)))
    ) : null,
    process.validations.length ? h('div', { className: 'process-section' },
      h('div', { className: 'process-section-title' }, 'Validation'),
      h('div', { className: 'validation-list' }, ...validationRows)
    ) : null
  );

  return h('div', { className: 'process-card ' + (m.processState || process.stage) },
    h('div', { className: 'process-hdr' },
      h('div', { className: 'process-hdr-main' },
        h('div', { className: 'process-title' },
          h('span', null, '🧠 Process'),
          h('span', { className: 'process-stage ' + stageMeta.tone, role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
            h('span', { className: 'process-stage-icon', 'aria-hidden': 'true' }, stageMeta.icon),
            h('span', null, stageLabel)
          )
        ),
        !process.expanded && process.summaryChips.length ? h('div', { className: 'process-meta' },
          ...process.summaryChips.map((chip: any) => h('span', { className: 'summary-chip ' + (chip.tone || 'ok') }, chip.label))
        ) : null
      ),
      h('button', {
        className: 'process-toggle',
        type: 'button',
        'aria-expanded': String(process.expanded),
        onClick: () => { m.processExpanded = !process.expanded; renderMessages(); },
      }, toggleText)
    ),
    !process.expanded ? h('div', { className: 'process-summary' },
      h('div', null, summary || 'No process events'),
      process.summaryChips.length ? h('div', { className: 'process-meta' },
        ...process.summaryChips.map((chip: any) => h('span', { className: 'summary-chip ' + (chip.tone || 'ok') }, chip.label))
      ) : null
    ) : null,
    h('div', { className: 'process-body-wrap ' + (process.expanded ? 'expanded' : 'collapsed'), 'aria-hidden': String(!process.expanded) },
      h('div', { className: 'process-body-clip' }, processBody)
    )
  );
}

function renderAssistantBubble(content: string): { element: HTMLElement; exportHtml: string } {
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const structured = renderAssistantStructuredContent(content);
  if (structured) {
    bubble.appendChild(structured);
  } else {
    const embedded = renderAssistantEmbeddedStructuredContent(content || '');
    if (embedded) {
      const markdown = mdToHtml(embedded.markdown || '');
      if (markdown) bubble.innerHTML = markdown;
      bubble.appendChild(embedded.node);
    } else {
      bubble.innerHTML = mdToHtml(content || '');
      const markdownCharts = renderAssistantMarkdownCharts(content || '');
      if (markdownCharts) bubble.appendChild(markdownCharts);
    }
  }

  return {
    element: bubble,
    exportHtml: bubble.innerHTML,
  };
}

function renderMessages() {
  const container = document.querySelector('.messages');
  if (!container) return;
  
  container.innerHTML = '';
  
  if (!state.messages.length) {
    container.appendChild(h('div', {className:'empty-chat'},
      h('div',null,'Start a conversation with geneWeave'),
      h('div',null,'Choose a model above and type your message')
    ));
    return;
  }
  
  state.messages.forEach((m: Message, msgIndex: number) => {
    const isUser = m.role === 'user';
    const isStreamingCurrent = !isUser && state.streaming && msgIndex === state.messages.length - 1;
    const extras: HTMLElement[] = [];

    if (!isUser && (m as any).mode && (m as any).mode !== 'direct') {
      extras.push(h('span', { className: 'mode-badge' }, String((m as any).mode)));
    }

    if (!isUser) {
      const processCard = renderAssistantProcess(m as any, isStreamingCurrent);
      if (processCard) extras.push(processCard);
    }

    const meta = parseMessageMetadata((m as any)?.metadata);
    let corner: HTMLElement | null = null;
    if (!isUser) {
      const evalResult = (m as any)?.evalResult || meta?.eval;
      const cognitive = (m as any)?.cognitive || meta?.cognitive;
      const guardrail = (m as any)?.guardrail || meta?.guardrail;
      const indicators: HTMLElement[] = [];
      if (evalResult) {
        const passed = evalResult.passed ?? (evalResult.score >= 1);
        indicators.push(h('div', { className: 'resp-ind ' + (passed ? 'ok' : 'warn'), title: 'Evaluation result' }, passed ? '✓' : '!'));
      }
      if (cognitive) {
        const decision = cognitive.decision || 'allow';
        indicators.push(h('div', { className: 'resp-ind ' + (decision === 'deny' ? 'deny' : decision === 'warn' ? 'warn' : 'ok'), title: 'Cognitive check' }, '◉'));
      }
      if (guardrail) {
        const decision = guardrail.decision || 'allow';
        indicators.push(h('div', { className: 'resp-ind ' + (decision === 'deny' ? 'deny' : decision === 'warn' ? 'warn' : 'ok'), title: 'Guardrail status' }, decision === 'deny' ? '✕' : decision === 'warn' ? '⚠' : '✓'));
      }
      if (indicators.length) corner = h('div', { className: 'resp-corner' }, ...indicators);
    }

    let bubbleEl: HTMLElement;
    let responseExportHtml = '';
    if (!isUser && m.content) {
      const rendered = renderAssistantBubble(m.content);
      bubbleEl = rendered.element;
      responseExportHtml = rendered.exportHtml;
    } else {
      bubbleEl = h('div', { className: 'bubble' }, m.content || (isStreamingCurrent ? '' : '...'));
    }

    const attachments = Array.isArray((m as any).attachments) ? (m as any).attachments : [];
    let attachmentsEl: HTMLElement | null = null;
    if (attachments.length) {
      attachmentsEl = h('div', { className: 'msg-attachments' },
        ...attachments.map((a: any) =>
          h('div', { className: 'msg-attachment' },
            h('div', { className: 'title' }, a?.name || 'Attachment'),
            h('div', null, `${a?.mimeType || 'file'} • ${Math.max(1, Math.round((Number(a?.size || 0) / 1024)))} KB`)
          )
        )
      );
    }

    let screenshotsEl: HTMLElement | null = null;
    if (!isUser && Array.isArray((m as any).screenshots) && (m as any).screenshots.length) {
      const imgs = (m as any).screenshots.map((s: any) => {
        const img = document.createElement('img');
        img.src = `data:image/${s?.format || 'png'};base64,${s?.base64 || ''}`;
        img.style.cssText = 'max-width:100%;border-radius:8px;margin-top:8px;border:1px solid var(--bg4);cursor:pointer;';
        img.onclick = () => window.open(img.src, '_blank');
        return img;
      });
      screenshotsEl = h('div', { className: 'screenshots' }, ...imgs);
    }

    const toolbar = !isUser && m.content ? (() => {
      const bar = document.createElement('div');
      bar.className = 'response-toolbar';

      const copyBtn = document.createElement('button');
      copyBtn.className = 'tb-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.onclick = () => { void copyResponse(m.content, copyBtn); };

      const emailBtn = document.createElement('button');
      emailBtn.className = 'tb-btn';
      emailBtn.textContent = 'Email';
      emailBtn.onclick = () => { void emailResponse(m.content, 'geneWeave Response'); };

      const wordBtn = document.createElement('button');
      wordBtn.className = 'tb-btn';
      wordBtn.textContent = 'Word';
      wordBtn.onclick = () => { void openInWord(responseExportHtml || mdToHtml(m.content), m.content); };

      bar.appendChild(copyBtn);
      bar.appendChild(emailBtn);
      bar.appendChild(wordBtn);
      return bar;
    })() : null;

    const usage = (m as any).usage;
    const metaBar = !isUser && usage ? h('div', { className: 'meta' },
      h('span', null, `📊 ${formatCompactNumber(Number(usage.totalTokens || 0))} tok`),
      h('span', null, `💰 ${formatCurrencyCompact(Number((m as any).cost || 0), 6)}`),
      h('span', null, `⏱ ${formatMaybeCompactValue((m as any).latency_ms || 0)}ms`)
    ) : null;

    const thinkingIndicator = !isUser && isStreamingCurrent && !m.content
      ? h('div', { className: 'meta' }, 'Thinking...')
      : null;

    const body = h('div', { className: 'msg-body' },
      corner,
      ...extras,
      bubbleEl,
      attachmentsEl,
      screenshotsEl,
      toolbar,
      metaBar,
      thinkingIndicator
    );

    let avatarEl: HTMLElement;
    if (isUser) {
      const img = document.createElement('img');
      img.src = getUserAvatarUrl();
      img.alt = 'User';
      avatarEl = h('div', { className: 'avatar' }, img);
    } else {
      let agentName = '';
      const steps = Array.isArray((m as any).steps) ? (m as any).steps : [];
      for (const st of steps) {
        if (st?.type === 'delegation' && (st?.worker || st?.name)) {
          agentName = st.worker || st.name;
          break;
        }
        if (st?.type === 'tool_call' && st?.toolCall?.name === 'delegate_to_worker' && st?.toolCall?.arguments?.worker) {
          agentName = st.toolCall.arguments.worker;
          break;
        }
      }
      const aImg = document.createElement('img');
      aImg.src = getAgentAvatarUrl(agentName);
      aImg.alt = agentName || 'Agent';
      avatarEl = h('div', { className: 'avatar' }, aImg);
    }
    
    const msgEl = h('div', {className:'msg ' + (isUser ? 'user' : 'assistant')},
      avatarEl,
      body
    );
    
    container.appendChild(msgEl);
  });
}

function renderChatView() {
  const view = h('div', {className:'chat-view'});

  if (state.handoffRequest) {
    const ho = state.handoffRequest as any;
    const banner = h('div', { style: 'background:#FEF3C7;border:1px solid #FCD34D;border-radius:10px;margin:12px 16px 0;padding:14px 18px;display:flex;flex-direction:column;gap:10px;flex-shrink:0' });
    banner.appendChild(h('div', { style: 'display:flex;align-items:center;gap:8px' },
      h('span', { style: 'font-size:20px' }, '\u{1F6A8}'),
      h('div', { style: 'flex:1' },
        h('div', { style: 'font-weight:700;font-size:14px;color:#92400E' }, 'Browser Handoff Requested'),
        h('div', { style: 'font-size:12px;color:#78350F;margin-top:2px' }, ho.reason || 'The agent needs you to complete an action in the browser.')
      )
    ));

    if (ho.url) {
      banner.appendChild(h('div', { style: 'font-size:11px;color:#78350F;font-family:monospace;background:#FDE68A;padding:4px 8px;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, '\u{1F517} ' + ho.url));
    }

    if (ho.screenshot) {
      banner.appendChild(h('img', { src: 'data:image/png;base64,' + ho.screenshot, style: 'max-width:100%;max-height:200px;border-radius:6px;border:1px solid #FCD34D' }));
    }

    const actions = h('div', { style: 'display:flex;gap:8px' });
    actions.appendChild(h('button', {
      className: 'nav-btn active',
      style: 'font-size:12px;background:#059669;border-color:#059669;color:white',
      onClick: () => {
        const msg = 'Resume the browser session'
          + (ho.sessionId ? ' (session: ' + ho.sessionId + ')' : '')
          + (ho.taskId ? ' (task: ' + ho.taskId + ')' : '');
        state.handoffRequest = null;
        render();
        void sendMessage(msg);
      },
    }, "\u2705 I'm Done - Resume Agent"));
    actions.appendChild(h('button', {
      className: 'nav-btn',
      style: 'font-size:12px',
      onClick: () => {
        state.handoffRequest = null;
        render();
      },
    }, 'Dismiss'));
    banner.appendChild(actions);
    view.appendChild(banner);
  }
  
  const ta = h('textarea', {placeholder:'Type a message...', rows:'1'}) as HTMLTextAreaElement;
  ta.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(ta.value);
      ta.value = '';
      ta.style.height = 'auto';
    }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  });
  
  const msgContainer = h('div', {className:'messages'});
  view.appendChild(msgContainer);
  
  const fileInput = h('input', {type:'file', multiple:true, style:'display:none'}) as HTMLInputElement;
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    await queueFiles(files as File[]);
    fileInput.value = '';
  });
  
  view.appendChild(h('div', {className:'input-bar'},
    fileInput,
    h('div', {className:'input-tools'},
      h('button', {className:'tool-btn', title:'Attach files', onClick:()=>fileInput.click()},'📎'),
      h('button', {className:'tool-btn'+(state.audioRecording?' active':''), title:state.audioRecording?'Stop recording':'Record audio', onClick:()=>toggleAudioRecording()}, state.audioRecording?'⏹':'🎤')
    ),
    h('div', {className:'composer-wrap'},
      state.pendingAttachments?.length
        ? h('div', { className: 'attach-strip' },
            ...state.pendingAttachments.map((a: any, i: number) =>
              h('div', { className: 'attach-chip' },
                h('span', { className: 'name' }, a?.name || 'attachment'),
                h('button', {
                  className: 'remove',
                  title: 'Remove attachment',
                  onClick: () => removePendingAttachment(i),
                }, '×')
              )
            )
          )
        : null,
      ta
    ),
    h('button', {className:'send-btn', onClick:()=>{sendMessage(ta.value);ta.value='';ta.style.height='auto';}, disabled:state.streaming?'true':null},'Send')
  ));
  
  setTimeout(() => {
    renderMessages();
    scrollMessages();
  }, 0);
  
  return view;
}

function renderSettingsDropdown() {
  const s = state.chatSettings;
  if (!s) return h('div', null);

  const modes = [
    { id: 'direct', icon: '💬', title: 'Direct', desc: 'Simple model chat without orchestration' },
    { id: 'agent', icon: '🤖', title: 'Agent', desc: 'Autonomous tool-calling with reasoning loop' },
    { id: 'supervisor', icon: '🧠', title: 'Supervisor', desc: 'Multi-agent delegation to specialists' },
  ];

  const modeCards = modes.map((m) =>
    h('div', {
      className: 'mode-card' + (s.mode === m.id ? ' selected' : ''),
      onClick: () => {
        s.mode = m.id;
        void saveChatSettings();
        render();
      },
    },
      h('div', { className: 'mc-icon' }, m.icon),
      h('div', null,
        h('div', { className: 'mc-title' }, m.title),
        h('div', { style: 'font-size:12px;color:var(--fg3);margin-top:2px;' }, m.desc)
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

function renderWorkspaceNav() {
  const nav = h('aside', {className:'workspace-nav'});
  nav.appendChild(h('div', {className:'brand'}, '✦', h('span', {className:'word'}, 'geneWeave')));
  
  const menu = h('div', {className:'workspace-menu'});
  menu.appendChild(h('button', {className:state.view==='chat'?'active':'', onClick:()=>{state.view='chat'; render();}}, '⌂', h('span',null,'Home')));
  menu.appendChild(h('button', {className:state.view==='connectors'?'active':'', onClick:()=>{void openConnectorsView();}}, '⚡', h('span',null,'Connectors')));
  menu.appendChild(h('button', {className:state.view==='admin'?'active':'', onClick:()=>{state.view='admin'; void loadAdmin();}}, '⚙', h('span',null,'Admin')));
  menu.appendChild(h('button', {className:state.view==='dashboard'?'active':'', onClick:()=>{state.view='dashboard'; void loadDashboard();}}, '▦', h('span',null,'Dashboard')));
  nav.appendChild(menu);

  const history = h('div', { className: 'workspace-history' },
    h('div', { className: 'workspace-history-label' }, 'Recent Chats'),
    ...(state.chats.length
      ? state.chats.slice(0, 14).map((chat: Chat) =>
          h('div', {
              className: 'chat-item' + (state.currentChatId === chat.id ? ' active' : ''),
              onClick: () => {
                state.view = 'chat';
                if (state.currentChatId !== chat.id) void selectChat(chat.id);
              },
            },
            h('div', { className: 'chat-item-copy' },
              h('div', { className: 'chat-item-title' }, chat.title || 'New Chat'),
              h('div', { className: 'chat-item-meta' }, new Date(chat.updated_at || chat.created_at || Date.now()).toLocaleString())
            ),
            h('button', {
              className: 'del',
              title: 'Delete chat',
              onClick: (e: Event) => {
                e.stopPropagation();
                void deleteChat(chat.id);
              },
            }, '×')
          )
        )
      : [h('div', { className: 'workspace-history-empty' }, 'No saved chats yet')])
  );
  nav.appendChild(history);
  
  const spacer = h('div', {className:'workspace-spacer'});
  nav.appendChild(spacer);
  
  const footer = h('div', {className:'workspace-menu'});
  footer.appendChild(h('button', {onClick:async()=>{await doLogout(); render();}}, '⎋', h('span',null,'Log Out')));
  nav.appendChild(footer);
  
  return nav;
}

function renderWorkspaceTopCard() {
  const userName = (state.user?.name || 'User') as string;
  const userEmail = (state.user?.email || '') as string;
  const openProfile = (e: Event) => {
    e.stopPropagation();
    state.showNotifications = false;
    state.showProfile = !state.showProfile;
    render();
  };

  const profileAnchor = h('div', { className: 'dropdown-anchor' });
  const profileBtn = h(
    'button',
    { className: 'profile-avatar', title: 'Profile and preferences', onClick: openProfile },
    h('img', {
      src: getUserAvatarUrl(),
      alt: userName,
      style: 'width:100%;height:100%;border-radius:50%;object-fit:cover;',
    })
  );
  profileAnchor.appendChild(profileBtn);

  if (state.showProfile) {
    const dd = renderProfileDropdown();
    document.body.appendChild(dd);
    requestAnimationFrame(() => {
      const r = profileBtn.getBoundingClientRect();
      (dd as HTMLElement).style.top = `${r.bottom + 8}px`;
      (dd as HTMLElement).style.right = `${window.innerWidth - r.right}px`;
    });
  }

  return h(
    'div',
    { className: 'workspace-top-card' },
    h(
      'div',
      { className: 'user-chip' },
      h('img', { src: getUserAvatarUrl(), alt: userName }),
      h(
        'div',
        null,
        h('div', { className: 'name' }, userName),
        h('div', { className: 'role' }, userEmail || 'Signed in')
      )
    ),
    h('div', { className: 'today-badge' }, '◷ ', getTodayLabel()),
    h('div', { className: 'semantic-search' },
      h('input', {
        type: 'text',
        value: state.chatSearchQuery || '',
        placeholder: 'Search chats...',
        onInput: (e: Event) => {
          state.chatSearchQuery = (e.target as HTMLInputElement).value || '';
          render();
        },
      }),
      state.chatSearchQuery
        ? h(
            'div',
            { className: 'search-dd' },
            ...state.chats
              .filter((c: Chat) =>
                (c.title || '').toLowerCase().includes(String(state.chatSearchQuery).toLowerCase())
              )
              .slice(0, 8)
              .map((c: Chat) =>
                h(
                  'div',
                  {
                    className: 'search-item',
                    onClick: () => {
                      state.chatSearchQuery = '';
                      void selectChat(c.id);
                    },
                  },
                  h('div', { className: 'ttl' }, c.title || 'New Chat'),
                  h(
                    'div',
                    { className: 'sub' },
                    new Date(c.updated_at || c.created_at || Date.now()).toLocaleString()
                  )
                )
              )
          )
        : null
    ),
    h('div', { className: 'top-actions' },
      h('button', { className: 'nav-btn', onClick: () => createChat() }, '+ New Chat'),
      profileAnchor
    )
  );
}

function renderCalendarWidget() {
  const focus = getCalendarFocusDate();
  const year = focus.getFullYear();
  const month = focus.getMonth();
  const selectedYMD = toYMD(focus);

  const counts: Record<number, number> = {};
  state.chats.forEach((c: Chat) => {
    const d = new Date(c.updated_at || c.created_at || Date.now());
    if (d.getFullYear() === year && d.getMonth() === month) {
      counts[d.getDate()] = (counts[d.getDate()] || 0) + 1;
    }
  });

  const focusDays: Date[] = [];
  for (let i = -1; i <= 3; i++) {
    focusDays.push(new Date(year, month, focus.getDate() + i));
  }

  const monthFirst = new Date(year, month, 1);
  const monthLast = new Date(year, month + 1, 0);
  const monthCells: HTMLElement[] = [];
  for (let i = 0; i < monthFirst.getDay(); i++) monthCells.push(h('div', { className: 'md empty' }, ''));
  for (let day = 1; day <= monthLast.getDate(); day++) {
    const d = new Date(year, month, day);
    const dYMD = toYMD(d);
    monthCells.push(
      h(
        'div',
        {
          className: `md${counts[day] ? ' has' : ''}${dYMD === selectedYMD ? ' active' : ''}`,
          onClick: () => {
            setCalendarFocusDate(d);
            render();
          },
        },
        String(day)
      )
    );
  }

  const meetingsBody = [
    h('div', { className: 'meet-card peach' },
      h('div', { className: 'meet-title' }, 'Agent Review and Approval'),
      h(
        'div',
        { className: 'meet-time' },
        `${focus.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: '2-digit' })} • 08:00 - 08:45 (UTC)`
      )
    ),
    h('div', { className: 'meet-card blue' },
      h('div', { className: 'meet-title' }, 'Chat Follow-up Actions'),
      h(
        'div',
        { className: 'meet-time' },
        `${focus.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: '2-digit' })} • 09:00 - 09:45 (UTC)`
      )
    ),
  ];

  const eventsBody = state.chats.slice(0, 2).map((c: Chat) =>
    h('div', { className: 'meet-card blue' },
      h('div', { className: 'meet-title' }, c.title || 'Chat Event'),
      h('div', { className: 'meet-time' }, `${new Date(c.updated_at || c.created_at || Date.now()).toLocaleDateString()} • Model activity`)
    )
  );

  const holidayBody = [
    h('div', { className: 'meet-card peach' },
      h('div', { className: 'meet-title' }, 'No scheduled holidays'),
      h('div', { className: 'meet-time' }, 'Use this tab for OOO and downtime events')
    ),
  ];

  const tabContent = state.calendarTab === 'events'
    ? eventsBody
    : state.calendarTab === 'holiday'
      ? holidayBody
      : meetingsBody;

  return h('div', { className: 'side-card schedule-card' },
    h('div', { className: 'schedule-head' },
      h('div', { className: 'ttl' }, '◷ Schedule'),
      h('div', { className: 'month-nav' },
        h('button', { className: 'icon-btn-sm', title: 'Previous month', onClick: () => { shiftCalendarMonth(-1); render(); } }, '‹'),
        h('div', { className: 'month-pill' }, focus.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })),
        h('button', { className: 'icon-btn-sm', title: 'Next month', onClick: () => { shiftCalendarMonth(1); render(); } }, '›')
      ),
      h('button', { className: 'see-all', title: 'Toggle full month', onClick: () => { state.calendarShowAll = !state.calendarShowAll; render(); } }, state.calendarShowAll ? 'Hide' : 'See all')
    ),
    !state.calendarShowAll
      ? h(
          'div',
          { className: 'day-strip' },
          ...focusDays.map((d) =>
            h(
              'div',
              {
                className: `day-chip${toYMD(d) === selectedYMD ? ' active' : ''}`,
                title: `${counts[d.getDate()] || 0} actions`,
                onClick: () => {
                  setCalendarFocusDate(d);
                  render();
                },
              },
              h('div', { className: 'dw' }, d.toLocaleDateString(undefined, { weekday: 'short' })),
              h('div', { className: 'dn' }, String(d.getDate()).padStart(2, '0'))
            )
          )
        )
      : h(
          'div',
          { className: 'month-grid' },
          ...['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x) => h('div', { className: 'mh' }, x)),
          ...monthCells
        ),
    h('div', { className: 'schedule-search' },
      h('div', { className: 'search-row' }, '🔍', ' Search...', h('span', { style: 'margin-left:auto' }, '☰'))
    ),
    h('div', { className: 'schedule-tabs' },
      h('div', { className: `schedule-tab${state.calendarTab === 'meetings' ? ' active' : ''}`, onClick: () => { state.calendarTab = 'meetings'; render(); } }, 'Meetings'),
      h('div', { className: `schedule-tab${state.calendarTab === 'events' ? ' active' : ''}`, onClick: () => { state.calendarTab = 'events'; render(); } }, 'Events'),
      h('div', { className: `schedule-tab${state.calendarTab === 'holiday' ? ' active' : ''}`, onClick: () => { state.calendarTab = 'holiday'; render(); } }, 'Holiday')
    ),
    h('div', { className: 'schedule-meetings' }, ...tabContent)
  );
}

function renderActionsWidget() {
  const actions = state.chats.slice(0, 8).map((c: Chat) => ({
    id: c.id,
    title: c.title || 'New Chat',
    sub: `Updated ${new Date(c.updated_at || c.created_at || Date.now()).toLocaleString()}`,
  }));

  return h('div', { className: 'side-card actions-card' },
    h('h3', null, 'My Actions'),
    h('div', { className: 'action-list' },
      ...actions.map((a: { id: string; title: string; sub: string }) =>
        h('div', { className: `action-item selectable${state.currentChatId === a.id ? ' active' : ''}`, onClick:()=>{ void selectChat(a.id); } },
          h('div', { className: 'at' }, a.title),
          h('div', { className: 'as' }, a.sub)
        )
      ),
      !actions.length ? h('div', { className: 'action-item' }, h('div', { className: 'as' }, 'No actions yet')) : null
    )
  );
}

function renderProfileDropdown() {
  const u = state.user || {};
  const avatar = h('img', {
    src: getUserAvatarUrl(),
    alt: u.name || 'User',
    style: 'width:48px;height:48px;border-radius:50%;object-fit:cover;margin-bottom:10px;',
  });

  return h('div', { className: 'dropdown profile-dd', onClick: (e: Event) => e.stopPropagation() },
    avatar,
    h('div', { className: 'pf-name' }, u.name || 'User'),
    h('div', { className: 'pf-email' }, u.email || ''),
    h('div', { className: 'pf-divider' }),
    h('button', { className: 'pf-btn', onClick: () => { state.view = 'preferences'; state.showProfile = false; render(); } }, '⚙ Preferences'),
    h('button', { className: 'pf-btn', onClick: () => { state.view = 'dashboard'; state.showProfile = false; render(); void loadDashboard(); } }, '📊 Dashboard'),
    h('button', { className: 'pf-btn', onClick: () => { state.view = 'admin'; state.showProfile = false; render(); void loadAdmin(); } }, '⚙ Admin'),
    h('div', { className: 'pf-divider' }),
    h('button', { className: 'pf-btn danger', onClick: async () => { state.showProfile = false; await doLogout(); render(); } }, '🚪 Sign Out')
  );
}

function renderDashboardView() {
  const d = state.dashboard;
  const view = h('div', { className: 'dash-view' }, h('h2', null, 'Dashboard'));
  if (!d || !d.overview) {
    view.appendChild(h('div', { className: 'empty-chat' }, 'Loading dashboard...'));
    return view;
  }

  const safeParseTraceJson = (value: unknown) => {
    if (!value || typeof value !== 'string') return null;
    try {
      return JSON.parse(value) as Record<string, any>;
    } catch {
      return null;
    }
  };

  const capabilityRows = (d.traces || [])
    .map((trace: any) => {
      const attributes = safeParseTraceJson(trace?.attributes);
      const summary = attributes?.['capability.summary'];
      if (!summary || typeof summary !== 'object') return null;
      return {
        trace,
        summary,
        events: safeParseTraceJson(trace?.events),
      };
    })
    .filter(Boolean)
    .slice(0, 20) as Array<{ trace: any; summary: any; events: any }>;

  const s = d.overview.summary || {};
  view.appendChild(
    h('div', { className: 'cards' },
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Total Tokens'), h('div', { className: 'value tokens' }, formatCompactNumber(Number(s.total_tokens || 0)))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Total Cost'), h('div', { className: 'value cost' }, formatCurrencyCompact(Number(s.total_cost || 0), 4))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Avg Latency'), h('div', { className: 'value latency' }, formatMaybeCompactValue(s.avg_latency_ms || 0) + 'ms')),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Messages'), h('div', { className: 'value' }, formatCompactNumber(Number(s.total_messages || 0)))),
      h('div', { className: 'card' }, h('div', { className: 'label' }, 'Chats'), h('div', { className: 'value' }, formatCompactNumber(Number(s.total_chats || 0))))
    )
  );

  const evals = d.evals?.evals || [];
  if (evals.length) {
    view.appendChild(
      h('div', { className: 'table-wrap' },
        h('h3', null, 'Evaluation Results'),
        h('table', { className: 'eval-table' },
          h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Score'), h('th', null, 'Passed'), h('th', null, 'Date'))),
          h('tbody', null,
            ...evals.slice(0, 20).map((ev: any) =>
              h('tr', null,
                h('td', null, ev.eval_name || 'Eval'),
                h('td', null, ((Number(ev.score || 0) * 100).toFixed(1)) + '%'),
                h('td', null, `${ev.passed || 0}/${ev.total || 0}`),
                h('td', null, String(ev.created_at || '').slice(0, 16))
              )
            )
          )
        )
      )
    );
  }

  if (capabilityRows.length) {
    view.appendChild(
      h('div', { className: 'table-wrap', style: 'margin-top:16px;' },
        h('h3', null, 'Capability Telemetry'),
        h('div', { style: 'padding:0 20px 12px;color:var(--fg2);font-size:12px;' }, 'Prompt, skill, and agent runtime telemetry captured from shared observability hooks.'),
        h('table', { className: 'eval-table' },
          h('thead', null,
            h('tr', null,
              h('th', null, 'Type'),
              h('th', null, 'Capability'),
              h('th', null, 'Strategy / Source'),
              h('th', null, 'Eval / Contracts'),
              h('th', null, 'Rendered'),
              h('th', null, 'When')
            )
          ),
          h('tbody', null,
            ...capabilityRows.map(({ trace, summary }: any) => {
              const evalsLabel = summary.evaluations?.length
                ? `${summary.evaluations.filter((entry: any) => !entry.passed).length} failed / ${summary.evaluations.length}`
                : '-';
              const contractLabel = summary.contracts
                ? `${summary.contracts.failed || 0} failed / ${summary.contracts.total || 0}`
                : '-';
              const strategyLabel = summary.strategyKey
                ? `${summary.strategyName || summary.strategyKey}${summary.usedFallbackStrategy ? ' (fallback)' : ''}`
                : (summary.source || '-');
              const renderedLabel = summary.renderedCharacters
                ? `${summary.renderedCharacters} chars / ${summary.renderedLines || 0} lines`
                : '-';

              return h('tr', null,
                h('td', null, summary.kind || '-'),
                h('td', null,
                  h('div', { style: 'font-weight:600' }, summary.name || summary.key || '-'),
                  h('div', { style: 'font-size:12px;color:var(--fg3);max-width:320px;' }, summary.description || '-'),
                  summary.version ? h('div', { style: 'font-size:11px;color:var(--fg3);' }, `Version ${summary.version}`) : null
                ),
                h('td', null,
                  h('div', null, strategyLabel),
                  summary.selectedBy ? h('div', { style: 'font-size:11px;color:var(--fg3);' }, `Selected by ${summary.selectedBy}`) : null
                ),
                h('td', null,
                  h('div', null, `Evaluations: ${evalsLabel}`),
                  h('div', { style: 'font-size:11px;color:var(--fg3);' }, `Contracts: ${contractLabel}`)
                ),
                h('td', null, renderedLabel),
                h('td', null, trace?.created_at ? new Date(trace.created_at).toLocaleString() : '-')
              );
            })
          )
        )
      )
    );
  }

  const activityData = d.agentActivity || [];
  if (activityData.length) {
    const modeOptions = Array.from(new Set(activityData.map((a: any) => String(a?.mode || 'direct')))) as string[];
    const agentOptions = Array.from(new Set(activityData
      .map((a: any) => String(a?.agentName || '').trim())
      .filter(Boolean))) as string[];

    const activityRows = activityData
      .map((a: any) => {
        const steps = Array.isArray(a?.steps) ? a.steps : [];
        const toolNames = Array.from(new Set(steps
          .map((s: any) => s?.toolCall?.name)
          .filter(Boolean))) as string[];
        return { a, steps, toolNames };
      })
      .filter((row: any) => {
        const modeMatch = dashboardFlowFilters.mode === 'all' || String(row.a?.mode || 'direct') === dashboardFlowFilters.mode;
        const agentMatch = dashboardFlowFilters.agent === 'all' || String(row.a?.agentName || '') === dashboardFlowFilters.agent;
        const toolQuery = dashboardFlowFilters.toolQuery.trim().toLowerCase();
        const toolMatch = !toolQuery || row.toolNames.some((tool: string) => tool.toLowerCase().includes(toolQuery));
        return modeMatch && agentMatch && toolMatch;
      })
      .slice(0, 40);

    const preview = (value: any, maxLen: number = 220) => {
      if (value == null) return '';
      const text = typeof value === 'string' ? value : (() => {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })();
      return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
    };

    view.appendChild(
      h('div', { className: 'table-wrap', style: 'margin-top:16px;' },
        h('h3', null, 'Agent / Tool Flows'),
        h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0 12px' },
          h('select', {
            value: dashboardFlowFilters.mode,
            onChange: (e: Event) => {
              dashboardFlowFilters.mode = (e.target as HTMLSelectElement).value;
              render();
            },
          },
            h('option', { value: 'all' }, 'All modes'),
            ...modeOptions.map((mode) => h('option', { value: mode }, mode))
          ),
          h('select', {
            value: dashboardFlowFilters.agent,
            onChange: (e: Event) => {
              dashboardFlowFilters.agent = (e.target as HTMLSelectElement).value;
              render();
            },
          },
            h('option', { value: 'all' }, 'All agents'),
            ...agentOptions.map((agent) => h('option', { value: agent }, agent))
          ),
          h('input', {
            type: 'text',
            value: dashboardFlowFilters.toolQuery,
            placeholder: 'Tool contains...',
            style: 'min-width:220px',
            onInput: (e: Event) => {
              dashboardFlowFilters.toolQuery = (e.target as HTMLInputElement).value;
              render();
            },
          }),
          h('button', {
            className: 'btn',
            onClick: () => {
              dashboardFlowFilters.mode = 'all';
              dashboardFlowFilters.agent = 'all';
              dashboardFlowFilters.toolQuery = '';
              render();
            },
          }, 'Reset')
        ),
        h('table', { className: 'eval-table' },
          h('thead', null,
            h('tr', null,
              h('th', null, 'Chat'),
              h('th', null, 'Agent'),
              h('th', null, 'Mode'),
              h('th', null, 'Tools Called'),
              h('th', null, 'Steps'),
              h('th', null, 'When'),
              h('th', null, 'Flow')
            )
          ),
          h('tbody', null,
            ...activityRows.map((row: any) => {
              const a = row.a;
              const steps = row.steps;
              const toolNames = row.toolNames;
              const flowDetails = h(
                'details',
                { style: 'max-width:640px' },
                h('summary', { style: 'cursor:pointer;color:var(--brand);font-weight:600' }, 'View flow'),
                h('div', { style: 'margin-top:8px;display:flex;flex-direction:column;gap:8px' },
                  ...steps.length
                    ? steps.map((s: any, i: number) => {
                        const toolName = s?.toolCall?.name || s?.type || 'step';
                        return h('div', { style: 'padding:8px;border:1px solid var(--bg4);border-radius:10px;background:var(--bg2)' },
                          h('div', { style: 'font-weight:600;margin-bottom:4px' }, `Step ${i + 1}: ${toolName}`),
                          s?.content ? h('div', { style: 'color:var(--fg2);margin-bottom:4px' }, preview(s.content, 300)) : null,
                          s?.toolCall?.arguments != null ? h('div', { style: 'font-size:12px;color:var(--fg3)' }, `Input: ${preview(s.toolCall.arguments)}`) : null,
                          s?.toolCall?.result != null ? h('div', { style: 'font-size:12px;color:var(--fg3)' }, `Output: ${preview(s.toolCall.result)}`) : null,
                          s?.durationMs != null ? h('div', { style: 'font-size:12px;color:var(--fg3)' }, `Duration: ${s.durationMs}ms`) : null
                        );
                      })
                    : [h('div', { style: 'color:var(--fg3)' }, 'No step details recorded for this run')]
                )
              );

              return h('tr', null,
                h('td', null, a?.chatTitle || a?.chatId || '-'),
                h('td', null, a?.agentName || '-'),
                h('td', null, a?.mode || '-'),
                h('td', null, toolNames.length ? toolNames.join(', ') : '-'),
                h('td', null, String(steps.length || 0)),
                h('td', null, a?.createdAt ? new Date(a.createdAt).toLocaleString() : '-'),
                h('td', null, flowDetails)
              );
            }),
            ...(!activityRows.length
              ? [h('tr', null, h('td', { colSpan: '7', style: 'color:var(--fg3);text-align:center;' }, 'No rows match the selected filters'))]
              : [])
          )
        )
      )
    );
  }

  return view;
}

function normalizeAdminPath(path: string): string {
  let p = String(path || '').replace(/^\/+/, '');
  if (p.startsWith('api/')) p = p.slice(4);
  return '/' + p;
}

function slugifyPromptKey(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function parseWizardObject(input: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!input) return fallback;
  if (typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input !== 'string') return fallback;
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fallback;
  } catch {
    return fallback;
  }
}

function stripPossibleJsonQuotes(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function defaultWizardFrameworkSections() {
  return [
    { key: 'role', label: 'Role', required: true, header: null },
    { key: 'task', label: 'Task', required: true, header: '## Task\n' },
    { key: 'context', label: 'Context', required: false, header: '## Context\n' },
    { key: 'expectations', label: 'Expectations', required: false, header: '## Expectations\n' },
  ];
}

function ensureWizardFrameworkSections(wizard: any) {
  if (!Array.isArray(wizard.framework.sections) || !wizard.framework.sections.length) {
    wizard.framework.sections = defaultWizardFrameworkSections();
  }
}

function promptWizardRows(tab: string) {
  return ((state.adminData?.[tab] || []) as any[]).filter(Boolean);
}

function buildFrameworkSectionsFromWizard(wizard: any) {
  ensureWizardFrameworkSections(wizard);
  return wizard.framework.sections.map((section: any, index: number) => ({
    key: String(section.key || `section_${index + 1}`),
    label: String(section.label || section.key || `Section ${index + 1}`),
    renderOrder: (index + 1) * 10,
    required: !!section.required,
    header: section.header === null ? null : String(section.header || `## ${section.label || section.key || `Section ${index + 1}`}\n`),
  }));
}

function moveWizardFrameworkSection(wizard: any, index: number, dir: -1 | 1) {
  ensureWizardFrameworkSections(wizard);
  const next = index + dir;
  if (next < 0 || next >= wizard.framework.sections.length) return;
  const copy = [...wizard.framework.sections];
  const [item] = copy.splice(index, 1);
  copy.splice(next, 0, item);
  wizard.framework.sections = copy;
  render();
}

function insertFragmentMarkerIntoTemplate(fragmentKey: string) {
  if (!fragmentKey) return;
  const wizard = ensurePromptWizardState();
  const marker = `{{>${fragmentKey}}}`;
  const current = String(wizard.prompt.template || '');
  const start = Number.isFinite(wizard.prompt.cursorStart) ? wizard.prompt.cursorStart : current.length;
  const end = Number.isFinite(wizard.prompt.cursorEnd) ? wizard.prompt.cursorEnd : start;
  const from = Math.max(0, Math.min(start, current.length));
  const to = Math.max(from, Math.min(end, current.length));
  wizard.prompt.template = `${current.slice(0, from)}${marker}${current.slice(to)}`;
  wizard.prompt.cursorStart = from + marker.length;
  wizard.prompt.cursorEnd = from + marker.length;
  wizard.status = `Inserted fragment marker ${marker} into template.`;
  wizard.error = '';
  render();
}

function renderPromptTemplatePreview(wizard: any, fragmentRows: any[]) {
  const template = String(wizard.prompt.template || '');
  const fragmentKeys = new Set(fragmentRows.map((row: any) => String(row.key || '')));
  const preview = h('pre', { className: 'prompt-template-preview' });

  if (!template.trim()) {
    preview.appendChild(h('span', { className: 'prompt-template-empty' }, 'Template preview will appear here as you type.'));
    return preview;
  }

  const tokenRegex = /\{\{>\s*([a-zA-Z0-9._-]+)\s*\}\}|\{\{\s*([a-zA-Z0-9._-]+)\s*\}\}/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(template)) !== null) {
    const idx = match.index;
    if (idx > last) preview.appendChild(document.createTextNode(template.slice(last, idx)));
    const fragmentKey = match[1];
    const variableKey = match[2];
    if (fragmentKey) {
      const tone = fragmentKeys.has(fragmentKey) ? 'ok' : 'warn';
      preview.appendChild(h('span', { className: `prompt-token prompt-token-fragment ${tone}` }, `{{>${fragmentKey}}}`));
    } else if (variableKey) {
      preview.appendChild(h('span', { className: 'prompt-token prompt-token-variable' }, `{{${variableKey}}}`));
    }
    last = idx + match[0].length;
  }
  if (last < template.length) preview.appendChild(document.createTextNode(template.slice(last)));
  return preview;
}

function extractTemplateTokens(template: string) {
  const variableSet = new Set<string>();
  const fragmentSet = new Set<string>();
  const tokenRegex = /\{\{>\s*([a-zA-Z0-9._-]+)\s*\}\}|\{\{\s*([a-zA-Z0-9._-]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(template)) !== null) {
    if (match[1]) fragmentSet.add(match[1]);
    if (match[2]) variableSet.add(match[2]);
  }
  return {
    variables: [...variableSet],
    fragments: [...fragmentSet],
  };
}

function ensurePromptWizardState() {
  const existing = state.promptWizard;
  if (existing && typeof existing === 'object') return existing;

  const next = {
    prompt: {
      key: '',
      name: '',
      description: '',
      category: 'analysis',
      prompt_type: 'template',
      status: 'published',
      version: '1.0',
      variablesCsv: '',
      tagsCsv: '',
      template: '',
      cursorStart: 0,
      cursorEnd: 0,
    },
    framework: {
      selectedKey: '',
      createNew: false,
      key: '',
      name: '',
      description: '',
      sectionSeparator: '\\n\\n',
      sections: defaultWizardFrameworkSections(),
      newSectionKey: 'constraints',
    },
    strategy: {
      selectedKey: '',
      createNew: false,
      key: '',
      name: '',
      description: '',
      instructionPrefix: '',
      instructionSuffix: '',
      wrapTag: '',
    },
    contract: {
      selectedKey: '',
      createNew: false,
      key: '',
      name: '',
      description: '',
      contractType: 'json',
      schema: '{\\n  "type": "object"\\n}',
      config: '{\\n  "required": []\\n}',
    },
    fragments: {
      selectedKey: '',
      createNew: false,
      key: '',
      name: '',
      description: '',
      category: 'context',
      content: '',
      tagsCsv: '',
      queued: [] as any[],
    },
    saving: false,
    status: '',
    error: '',
    mode: 'create',
    editingPromptId: '',
    selectedPromptId: '',
  };

  state.promptWizard = next;
  return next;
}

function resetPromptWizard(mode: 'create' | 'edit' = 'create') {
  state.promptWizard = null;
  const wizard = ensurePromptWizardState();
  wizard.mode = mode;
  wizard.editingPromptId = '';
  wizard.selectedPromptId = '';
  wizard.status = '';
  wizard.error = '';
  return wizard;
}

function hydrateWizardFromPrompt(promptRow: any) {
  const wizard = resetPromptWizard('edit');
  const promptId = String(promptRow?.id || '');
  const promptName = String(promptRow?.name || '');
  const promptKey = String(promptRow?.key || promptName);
  const vars = Array.isArray(promptRow?.variables)
    ? promptRow.variables
    : parseJsonMaybeLoose(promptRow?.variables);
  const tags = Array.isArray(promptRow?.tags)
    ? promptRow.tags
    : parseJsonMaybeLoose(promptRow?.tags);

  wizard.mode = 'edit';
  wizard.editingPromptId = promptId;
  wizard.selectedPromptId = promptId;
  wizard.prompt.key = promptKey;
  wizard.prompt.name = promptName;
  wizard.prompt.description = String(promptRow?.description || '');
  wizard.prompt.category = String(promptRow?.category || 'analysis');
  wizard.prompt.prompt_type = String(promptRow?.prompt_type || 'template');
  wizard.prompt.status = String(promptRow?.status || 'published');
  wizard.prompt.version = String(promptRow?.version || '1.0');
  wizard.prompt.variablesCsv = Array.isArray(vars) ? vars.join(', ') : '';
  wizard.prompt.tagsCsv = Array.isArray(tags) ? tags.join(', ') : '';
  wizard.prompt.template = String(promptRow?.template || '');

  const frameworkRaw = parseJsonMaybeLoose(promptRow?.framework);
  const frameworkKey = typeof frameworkRaw === 'string'
    ? stripPossibleJsonQuotes(frameworkRaw)
    : typeof frameworkRaw?.key === 'string'
      ? String(frameworkRaw.key)
      : '';
  wizard.framework.selectedKey = frameworkKey;

  const execDefaults = parseWizardObject(promptRow?.execution_defaults, {});
  wizard.strategy.selectedKey = typeof execDefaults['strategy'] === 'string' ? String(execDefaults['strategy']) : '';
  wizard.contract.selectedKey = typeof execDefaults['outputContractId'] === 'string' ? String(execDefaults['outputContractId']) : '';

  const frameworkRows = promptWizardRows('prompt-frameworks');
  const selectedFramework = frameworkRows.find((row: any) => row.key === frameworkKey);
  const frameworkSections = Array.isArray(parseJsonMaybeLoose(selectedFramework?.sections))
    ? parseJsonMaybeLoose(selectedFramework?.sections)
    : [];
  wizard.framework.sections = frameworkSections.length
    ? frameworkSections.map((section: any) => ({
        key: String(section.key || ''),
        label: String(section.label || section.key || ''),
        required: !!section.required,
        header: section.header === null ? null : String(section.header || `## ${section.label || section.key || ''}\\n`),
      }))
    : defaultWizardFrameworkSections();

  wizard.status = `Loaded prompt package ${promptName || promptId} for editing.`;
  wizard.error = '';
}

function queuePromptWizardFragment() {
  const wizard = ensurePromptWizardState();
  const key = slugifyPromptKey(wizard.fragments.key || wizard.fragments.name);
  const name = String(wizard.fragments.name || '').trim();
  const content = String(wizard.fragments.content || '').trim();
  if (!key || !name || !content) {
    wizard.error = 'Fragment key, name, and content are required before adding to queue.';
    wizard.status = '';
    render();
    return;
  }

  wizard.fragments.queued = [
    ...(wizard.fragments.queued || []).filter((f: any) => f.key !== key),
    {
      key,
      name,
      description: String(wizard.fragments.description || '').trim(),
      category: String(wizard.fragments.category || 'context').trim() || 'context',
      content,
      tags: String(wizard.fragments.tagsCsv || '').split(',').map((v: string) => v.trim()).filter(Boolean),
    },
  ];

  wizard.fragments.key = '';
  wizard.fragments.name = '';
  wizard.fragments.description = '';
  wizard.fragments.content = '';
  wizard.fragments.tagsCsv = '';
  wizard.status = `Queued fragment ${key}.`;
  wizard.error = '';
  render();
}

async function savePromptWizardPackage() {
  const wizard = ensurePromptWizardState();
  if (wizard.saving) return;

  const promptName = String(wizard.prompt.name || '').trim();
  const promptKey = slugifyPromptKey(wizard.prompt.key || promptName);
  const promptDescription = String(wizard.prompt.description || '').trim();
  const promptTemplate = String(wizard.prompt.template || '').trim();
  if (!promptKey || !promptName || !promptDescription || !promptTemplate) {
    wizard.error = 'Prompt key, name, detailed description, and template are required.';
    wizard.status = '';
    render();
    return;
  }

  wizard.saving = true;
  wizard.error = '';
  wizard.status = 'Saving prompt package...';
  render();

  try {
    const frameworkRows = promptWizardRows('prompt-frameworks');
    const strategyRows = promptWizardRows('prompt-strategies');
    const contractRows = promptWizardRows('prompt-contracts');
    const fragmentRows = promptWizardRows('prompt-fragments');

    let selectedFrameworkKey = String(wizard.framework.selectedKey || '').trim();
    if (wizard.framework.createNew) {
      const key = slugifyPromptKey(wizard.framework.key || wizard.framework.name);
      if (!key) throw new Error('Framework key or name is required to create a new framework.');
      const existing = frameworkRows.find((row: any) => row.key === key);
      if (!existing) {
        await api.post('/admin/prompt-frameworks', {
          key,
          name: String(wizard.framework.name || key).trim(),
          description: String(wizard.framework.description || 'Framework created by prompt setup wizard.').trim(),
          sections: buildFrameworkSectionsFromWizard(wizard),
          section_separator: String(wizard.framework.sectionSeparator || '\\n\\n'),
          enabled: true,
        });
      }
      selectedFrameworkKey = key;
    }

    let selectedStrategyKey = String(wizard.strategy.selectedKey || '').trim();
    if (wizard.strategy.createNew) {
      const key = slugifyPromptKey(wizard.strategy.key || wizard.strategy.name);
      if (!key) throw new Error('Strategy key or name is required to create a new strategy.');
      const existing = strategyRows.find((row: any) => row.key === key);
      if (!existing) {
        await api.post('/admin/prompt-strategies', {
          key,
          name: String(wizard.strategy.name || key).trim(),
          description: String(wizard.strategy.description || 'Prompt execution strategy created by prompt setup wizard.').trim(),
          instruction_prefix: String(wizard.strategy.instructionPrefix || '').trim() || null,
          instruction_suffix: String(wizard.strategy.instructionSuffix || '').trim() || null,
          config: wizard.strategy.wrapTag
            ? JSON.stringify({ wrapTag: String(wizard.strategy.wrapTag).trim() })
            : JSON.stringify({}),
          enabled: true,
        });
      }
      selectedStrategyKey = key;
    }

    let selectedContractKey = String(wizard.contract.selectedKey || '').trim();
    if (wizard.contract.createNew) {
      const key = slugifyPromptKey(wizard.contract.key || wizard.contract.name);
      if (!key) throw new Error('Output contract key or name is required to create a contract.');
      const existing = contractRows.find((row: any) => row.key === key);
      if (!existing) {
        await api.post('/admin/prompt-contracts', {
          key,
          name: String(wizard.contract.name || key).trim(),
          description: String(wizard.contract.description || 'Output contract created by prompt setup wizard.').trim(),
          contract_type: String(wizard.contract.contractType || 'json'),
          schema: String(wizard.contract.schema || '').trim() || '{}',
          config: String(wizard.contract.config || '').trim() || '{}',
          enabled: true,
        });
      }
      selectedContractKey = key;
    }

    const queuedFragments = (wizard.fragments.queued || []) as any[];
    for (const fragment of queuedFragments) {
      const existing = fragmentRows.find((row: any) => row.key === fragment.key);
      if (existing) continue;
      await api.post('/admin/prompt-fragments', {
        key: fragment.key,
        name: fragment.name,
        description: fragment.description || 'Prompt fragment created by prompt setup wizard.',
        category: fragment.category || 'context',
        content: fragment.content,
        variables: [],
        tags: fragment.tags || [],
        version: '1.0',
        enabled: true,
      });
    }

    const executionDefaults: Record<string, unknown> = {};
    if (selectedStrategyKey) executionDefaults['strategy'] = selectedStrategyKey;
    if (selectedContractKey) executionDefaults['outputContractId'] = selectedContractKey;

    const payload = {
      key: promptKey,
      name: promptName,
      description: promptDescription,
      category: String(wizard.prompt.category || 'analysis'),
      prompt_type: String(wizard.prompt.prompt_type || 'template'),
      owner: 'admin',
      status: String(wizard.prompt.status || 'published'),
      tags: String(wizard.prompt.tagsCsv || '').split(',').map((v: string) => v.trim()).filter(Boolean),
      template: promptTemplate,
      variables: String(wizard.prompt.variablesCsv || '').split(',').map((v: string) => v.trim()).filter(Boolean),
      model_compatibility: {},
      execution_defaults: executionDefaults,
      framework: selectedFrameworkKey ? JSON.stringify(selectedFrameworkKey) : null,
      metadata: {
        createdFrom: 'prompt-setup-wizard',
        fragmentKeys: queuedFragments.map((f: any) => f.key),
      },
      version: String(wizard.prompt.version || '1.0'),
      is_default: false,
      enabled: true,
    };

    if (wizard.mode === 'edit' && wizard.editingPromptId) {
      await api.put(`/admin/prompts/${wizard.editingPromptId}`, payload);
      wizard.status = `Prompt package ${promptKey} updated successfully.`;
    } else {
      await api.post('/admin/prompts', payload);
      wizard.status = `Prompt package ${promptKey} created successfully.`;
    }

    wizard.error = '';
    wizard.fragments.queued = [];
    await loadAdmin();
  } catch (e: any) {
    wizard.error = e?.message || 'Failed to create prompt package.';
    wizard.status = '';
  } finally {
    wizard.saving = false;
    render();
  }
}

function renderPromptSetupWizard() {
  const wizard = ensurePromptWizardState();
  ensureWizardFrameworkSections(wizard);
  const promptsRows = promptWizardRows('prompts');
  const frameworkRows = promptWizardRows('prompt-frameworks');
  const strategyRows = promptWizardRows('prompt-strategies');
  const contractRows = promptWizardRows('prompt-contracts');
  const fragmentRows = promptWizardRows('prompt-fragments');
  const tokenSummary = extractTemplateTokens(String(wizard.prompt.template || ''));

  const box = h('div', { className: 'chart-box prompt-wizard' },
    h('div', { className: 'prompt-wizard-head' },
      h('h3', null, 'Prompt Setup Wizard'),
      h('div', { className: 'prompt-wizard-sub' }, 'Create or edit a full prompt package in one guided flow instead of editing separate tables.'),
      h('div', { className: 'prompt-wizard-inline prompt-wizard-top-actions' },
        h('select', {
          value: wizard.selectedPromptId || '',
          onChange: (e: Event) => { wizard.selectedPromptId = (e.target as HTMLSelectElement).value; },
        },
          h('option', { value: '' }, 'Load an existing prompt package...'),
          ...promptsRows.map((row: any) => h('option', { value: row.id }, `${row.name || row.id}`))
        ),
        h('button', {
          className: 'row-btn row-btn-edit',
          onClick: () => {
            const row = promptsRows.find((item: any) => item.id === wizard.selectedPromptId);
            if (!row) {
              wizard.error = 'Select a prompt package to load.';
              wizard.status = '';
              render();
              return;
            }
            hydrateWizardFromPrompt(row);
            render();
          },
        }, 'Load for Edit'),
        h('button', {
          className: 'row-btn',
          onClick: () => { resetPromptWizard('create'); render(); },
        }, 'Start New')
      ),
      wizard.mode === 'edit'
        ? h('div', { className: 'prompt-wizard-mode' }, `Editing prompt package: ${wizard.prompt.name || wizard.editingPromptId}`)
        : h('div', { className: 'prompt-wizard-mode' }, 'Create mode')
    )
  );

  const sectionBasics = h('div', { className: 'prompt-wizard-section' },
    h('h4', null, '1) Prompt Basics'),
    h('div', { className: 'prompt-wizard-grid' },
      h('div', null,
        h('label', null, 'Prompt Name'),
        h('input', {
          type: 'text',
          value: wizard.prompt.name,
          placeholder: 'NZ Regional Economy Insights',
          onInput: (e: Event) => {
            const value = (e.target as HTMLInputElement).value;
            wizard.prompt.name = value;
            if (!wizard.prompt.key) wizard.prompt.key = slugifyPromptKey(value);
          },
        })
      ),
      h('div', null,
        h('label', null, 'Prompt Key'),
        h('div', { className: 'prompt-wizard-inline' },
          h('input', {
            type: 'text',
            value: wizard.prompt.key,
            placeholder: 'insights.nz.regional.economy',
            onInput: (e: Event) => { wizard.prompt.key = (e.target as HTMLInputElement).value; },
          }),
          h('button', { className: 'row-btn', onClick: () => { wizard.prompt.key = slugifyPromptKey(wizard.prompt.name); render(); } }, 'Generate')
        )
      ),
      h('div', null,
        h('label', null, 'Category'),
        h('input', {
          type: 'text',
          value: wizard.prompt.category,
          placeholder: 'analysis',
          onInput: (e: Event) => { wizard.prompt.category = (e.target as HTMLInputElement).value; },
        })
      ),
      h('div', null,
        h('label', null, 'Version'),
        h('input', {
          type: 'text',
          value: wizard.prompt.version,
          placeholder: '1.0',
          onInput: (e: Event) => { wizard.prompt.version = (e.target as HTMLInputElement).value; },
        })
      )
    ),
    h('div', null,
      h('label', null, 'Detailed Description'),
      h('textarea', {
        rows: '3',
        value: wizard.prompt.description,
        placeholder: 'Describe what the model should do, for whom, and what quality looks like.',
        onInput: (e: Event) => { wizard.prompt.description = (e.target as HTMLTextAreaElement).value; },
      })
    ),
    h('div', { className: 'prompt-wizard-grid' },
      h('div', null,
        h('label', null, 'Variables (comma-separated)'),
        h('input', {
          type: 'text',
          value: wizard.prompt.variablesCsv,
          placeholder: 'region, year, metric',
          onInput: (e: Event) => { wizard.prompt.variablesCsv = (e.target as HTMLInputElement).value; },
        })
      ),
      h('div', null,
        h('label', null, 'Tags (comma-separated)'),
        h('input', {
          type: 'text',
          value: wizard.prompt.tagsCsv,
          placeholder: 'economy, nz, regional',
          onInput: (e: Event) => { wizard.prompt.tagsCsv = (e.target as HTMLInputElement).value; },
        })
      )
    )
  );

  const sectionTemplate = h('div', { className: 'prompt-wizard-section' },
    h('h4', null, '2) Prompt Template + Fragment Insertion'),
    h('div', { className: 'prompt-wizard-inline' },
      h('select', {
        value: wizard.fragments.selectedKey,
        onChange: (e: Event) => { wizard.fragments.selectedKey = (e.target as HTMLSelectElement).value; },
      },
        h('option', { value: '' }, 'Select an existing fragment...'),
        ...fragmentRows.map((row: any) => h('option', { value: row.key }, `${row.key} - ${row.name || ''}`))
      ),
      h('button', {
        className: 'row-btn row-btn-edit',
        onClick: () => insertFragmentMarkerIntoTemplate(String(wizard.fragments.selectedKey || '')),
      }, 'Insert Marker')
    ),
    h('textarea', {
      rows: '12',
      value: wizard.prompt.template,
      placeholder: 'Write your prompt template here. Use {{variable}} and insert fragments like {{>fragment_key}}.',
      onInput: (e: Event) => {
        const target = e.target as HTMLTextAreaElement;
        wizard.prompt.template = target.value;
        wizard.prompt.cursorStart = target.selectionStart;
        wizard.prompt.cursorEnd = target.selectionEnd;
      },
      onClick: (e: Event) => {
        const target = e.target as HTMLTextAreaElement;
        wizard.prompt.cursorStart = target.selectionStart;
        wizard.prompt.cursorEnd = target.selectionEnd;
      },
      onKeyUp: (e: Event) => {
        const target = e.target as HTMLTextAreaElement;
        wizard.prompt.cursorStart = target.selectionStart;
        wizard.prompt.cursorEnd = target.selectionEnd;
      },
    }),
    h('div', { className: 'prompt-wizard-hint' }, 'Tip: choose a fragment above and click Insert Marker. Marker inserts at your cursor position.'),
    h('div', { className: 'prompt-token-row' },
      h('strong', null, 'Detected variables:'),
      ...(tokenSummary.variables.length
        ? tokenSummary.variables.map((name) => h('span', { className: 'prompt-token prompt-token-variable' }, `{{${name}}}`))
        : [h('span', { className: 'prompt-token prompt-token-empty' }, 'none')])
    ),
    h('div', { className: 'prompt-token-row' },
      h('strong', null, 'Detected fragments:'),
      ...(tokenSummary.fragments.length
        ? tokenSummary.fragments.map((name) => h('span', { className: `prompt-token prompt-token-fragment ${fragmentRows.some((row: any) => row.key === name) ? 'ok' : 'warn'}` }, `{{>${name}}}`))
        : [h('span', { className: 'prompt-token prompt-token-empty' }, 'none')])
    ),
    renderPromptTemplatePreview(wizard, fragmentRows)
  );

  const sectionFramework = h('div', { className: 'prompt-wizard-section' },
    h('h4', null, '3) Framework (optional)'),
    h('div', { className: 'prompt-wizard-grid' },
      h('div', null,
        h('label', null, 'Use Existing Framework'),
        h('select', {
          value: wizard.framework.selectedKey,
          onChange: (e: Event) => { wizard.framework.selectedKey = (e.target as HTMLSelectElement).value; },
        },
          h('option', { value: '' }, 'None'),
          ...frameworkRows.map((row: any) => h('option', { value: row.key }, `${row.key} - ${row.name || ''}`))
        )
      ),
      h('div', null,
        h('label', null, 'Create New Framework'),
        h('input', {
          type: 'checkbox',
          checked: !!wizard.framework.createNew,
          onChange: (e: Event) => { wizard.framework.createNew = (e.target as HTMLInputElement).checked; render(); },
        })
      )
    )
  );

  if (wizard.framework.createNew) {
    sectionFramework.appendChild(
      h('div', { className: 'prompt-wizard-grid' },
        h('div', null,
          h('label', null, 'Framework Name'),
          h('input', { type: 'text', value: wizard.framework.name, onInput: (e: Event) => { wizard.framework.name = (e.target as HTMLInputElement).value; } })
        ),
        h('div', null,
          h('label', null, 'Framework Key'),
          h('input', { type: 'text', value: wizard.framework.key, onInput: (e: Event) => { wizard.framework.key = (e.target as HTMLInputElement).value; } })
        )
      )
    );
    sectionFramework.appendChild(
      h('div', null,
        h('label', null, 'Framework Description'),
        h('textarea', { rows: '2', value: wizard.framework.description, onInput: (e: Event) => { wizard.framework.description = (e.target as HTMLTextAreaElement).value; } })
      )
    );
    sectionFramework.appendChild(
      h('div', { className: 'prompt-wizard-inline', style: 'margin-top:8px;' },
        h('select', {
          value: wizard.framework.newSectionKey,
          onChange: (e: Event) => { wizard.framework.newSectionKey = (e.target as HTMLSelectElement).value; },
        },
          ...['role', 'task', 'context', 'expectations', 'constraints', 'examples', 'output_contract', 'review_instructions', 'custom']
            .map((key) => h('option', { value: key }, key))
        ),
        h('button', {
          className: 'row-btn',
          onClick: () => {
            const key = String(wizard.framework.newSectionKey || 'custom');
            wizard.framework.sections = [
              ...(wizard.framework.sections || []),
              {
                key,
                label: key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
                required: false,
                header: `## ${key.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}\\n`,
              },
            ];
            render();
          },
        }, 'Add Section')
      )
    );
    sectionFramework.appendChild(
      h('div', { className: 'prompt-wizard-list' },
        ...(wizard.framework.sections || []).map((section: any, index: number) =>
          h('div', { className: 'prompt-wizard-list-item prompt-section-item' },
            h('div', { className: 'prompt-section-main' },
              h('div', { className: 'prompt-wizard-grid' },
                h('div', null,
                  h('label', null, 'Section Key'),
                  h('input', {
                    type: 'text',
                    value: String(section.key || ''),
                    onInput: (e: Event) => { section.key = (e.target as HTMLInputElement).value; },
                  })
                ),
                h('div', null,
                  h('label', null, 'Label'),
                  h('input', {
                    type: 'text',
                    value: String(section.label || ''),
                    onInput: (e: Event) => { section.label = (e.target as HTMLInputElement).value; },
                  })
                )
              ),
              h('div', null,
                h('label', null, 'Header (leave blank for auto-header; use null to suppress)'),
                h('input', {
                  type: 'text',
                  value: section.header === null ? 'null' : String(section.header || ''),
                  onInput: (e: Event) => {
                    const value = (e.target as HTMLInputElement).value;
                    section.header = value.trim().toLowerCase() === 'null' ? null : value;
                  },
                })
              ),
              h('label', { className: 'prompt-wizard-toggle' },
                h('input', {
                  type: 'checkbox',
                  checked: !!section.required,
                  onChange: (e: Event) => { section.required = (e.target as HTMLInputElement).checked; },
                }),
                h('span', null, 'Required')
              )
            ),
            h('div', { className: 'prompt-section-actions' },
              h('button', { className: 'row-btn', onClick: () => moveWizardFrameworkSection(wizard, index, -1) }, 'Up'),
              h('button', { className: 'row-btn', onClick: () => moveWizardFrameworkSection(wizard, index, 1) }, 'Down'),
              h('button', {
                className: 'row-btn row-btn-del',
                onClick: () => {
                  wizard.framework.sections = wizard.framework.sections.filter((_: any, i: number) => i !== index);
                  render();
                },
              }, 'Remove')
            )
          )
        )
      )
    );
  }

  const sectionStrategyContract = h('div', { className: 'prompt-wizard-section' },
    h('h4', null, '4) Strategy + Output Contract (optional)'),
    h('div', { className: 'prompt-wizard-grid' },
      h('div', null,
        h('label', null, 'Use Existing Strategy'),
        h('select', {
          value: wizard.strategy.selectedKey,
          onChange: (e: Event) => { wizard.strategy.selectedKey = (e.target as HTMLSelectElement).value; },
        },
          h('option', { value: '' }, 'None'),
          ...strategyRows.map((row: any) => h('option', { value: row.key }, `${row.key} - ${row.name || ''}`))
        ),
        h('label', { className: 'prompt-wizard-toggle' },
          h('input', {
            type: 'checkbox',
            checked: !!wizard.strategy.createNew,
            onChange: (e: Event) => { wizard.strategy.createNew = (e.target as HTMLInputElement).checked; render(); },
          }),
          h('span', null, 'Create new strategy in this flow')
        )
      ),
      h('div', null,
        h('label', null, 'Use Existing Output Contract'),
        h('select', {
          value: wizard.contract.selectedKey,
          onChange: (e: Event) => { wizard.contract.selectedKey = (e.target as HTMLSelectElement).value; },
        },
          h('option', { value: '' }, 'None'),
          ...contractRows.map((row: any) => h('option', { value: row.key }, `${row.key} - ${row.name || ''}`))
        ),
        h('label', { className: 'prompt-wizard-toggle' },
          h('input', {
            type: 'checkbox',
            checked: !!wizard.contract.createNew,
            onChange: (e: Event) => { wizard.contract.createNew = (e.target as HTMLInputElement).checked; render(); },
          }),
          h('span', null, 'Create new output contract in this flow')
        )
      )
    )
  );

  if (wizard.strategy.createNew) {
    sectionStrategyContract.appendChild(
      h('div', { className: 'prompt-wizard-grid' },
        h('div', null,
          h('label', null, 'Strategy Name'),
          h('input', { type: 'text', value: wizard.strategy.name, onInput: (e: Event) => { wizard.strategy.name = (e.target as HTMLInputElement).value; } })
        ),
        h('div', null,
          h('label', null, 'Strategy Key'),
          h('input', { type: 'text', value: wizard.strategy.key, onInput: (e: Event) => { wizard.strategy.key = (e.target as HTMLInputElement).value; } })
        )
      )
    );
    sectionStrategyContract.appendChild(
      h('div', null,
        h('label', null, 'Instruction Prefix'),
        h('textarea', { rows: '2', value: wizard.strategy.instructionPrefix, onInput: (e: Event) => { wizard.strategy.instructionPrefix = (e.target as HTMLTextAreaElement).value; } })
      )
    );
    sectionStrategyContract.appendChild(
      h('div', null,
        h('label', null, 'Instruction Suffix'),
        h('textarea', { rows: '2', value: wizard.strategy.instructionSuffix, onInput: (e: Event) => { wizard.strategy.instructionSuffix = (e.target as HTMLTextAreaElement).value; } })
      )
    );
  }

  if (wizard.contract.createNew) {
    sectionStrategyContract.appendChild(
      h('div', { className: 'prompt-wizard-grid' },
        h('div', null,
          h('label', null, 'Contract Name'),
          h('input', { type: 'text', value: wizard.contract.name, onInput: (e: Event) => { wizard.contract.name = (e.target as HTMLInputElement).value; } })
        ),
        h('div', null,
          h('label', null, 'Contract Key'),
          h('input', { type: 'text', value: wizard.contract.key, onInput: (e: Event) => { wizard.contract.key = (e.target as HTMLInputElement).value; } })
        )
      )
    );
    sectionStrategyContract.appendChild(
      h('div', null,
        h('label', null, 'Contract Type'),
        h('select', {
          value: wizard.contract.contractType,
          onChange: (e: Event) => { wizard.contract.contractType = (e.target as HTMLSelectElement).value; },
        },
          ...['json', 'markdown', 'code', 'max_length', 'forbidden_content', 'structured'].map((type) => h('option', { value: type }, type))
        )
      )
    );
  }

  const sectionFragments = h('div', { className: 'prompt-wizard-section' },
    h('h4', null, '5) Optional: Create New Fragments in this Flow'),
    h('label', { className: 'prompt-wizard-toggle' },
      h('input', {
        type: 'checkbox',
        checked: !!wizard.fragments.createNew,
        onChange: (e: Event) => { wizard.fragments.createNew = (e.target as HTMLInputElement).checked; render(); },
      }),
      h('span', null, 'Create new fragments now')
    )
  );

  if (wizard.fragments.createNew) {
    sectionFragments.appendChild(
      h('div', { className: 'prompt-wizard-grid' },
        h('div', null,
          h('label', null, 'Fragment Name'),
          h('input', { type: 'text', value: wizard.fragments.name, onInput: (e: Event) => { wizard.fragments.name = (e.target as HTMLInputElement).value; } })
        ),
        h('div', null,
          h('label', null, 'Fragment Key'),
          h('input', { type: 'text', value: wizard.fragments.key, onInput: (e: Event) => { wizard.fragments.key = (e.target as HTMLInputElement).value; } })
        )
      )
    );
    sectionFragments.appendChild(
      h('div', null,
        h('label', null, 'Fragment Content'),
        h('textarea', { rows: '3', value: wizard.fragments.content, onInput: (e: Event) => { wizard.fragments.content = (e.target as HTMLTextAreaElement).value; } })
      )
    );
    sectionFragments.appendChild(
      h('div', { className: 'prompt-wizard-inline' },
        h('button', { className: 'row-btn row-btn-edit', onClick: () => queuePromptWizardFragment() }, 'Add Fragment to Queue'),
        h('button', {
          className: 'row-btn',
          onClick: () => {
            const key = slugifyPromptKey(wizard.fragments.key || wizard.fragments.name);
            if (key) insertFragmentMarkerIntoTemplate(key);
          },
        }, 'Insert Marker in Template')
      )
    );
    if ((wizard.fragments.queued || []).length) {
      sectionFragments.appendChild(
        h('div', { className: 'prompt-wizard-list' },
          ...wizard.fragments.queued.map((fragment: any, index: number) =>
            h('div', { className: 'prompt-wizard-list-item' },
              h('span', null, `${fragment.key} - ${fragment.name}`),
              h('button', {
                className: 'row-btn row-btn-del',
                onClick: () => {
                  wizard.fragments.queued = wizard.fragments.queued.filter((_: any, i: number) => i !== index);
                  render();
                },
              }, 'Remove')
            )
          )
        )
      );
    }
  }

  box.appendChild(sectionBasics);
  box.appendChild(sectionTemplate);
  box.appendChild(sectionFramework);
  box.appendChild(sectionStrategyContract);
  box.appendChild(sectionFragments);

  if (wizard.error) box.appendChild(h('div', { className: 'prompt-wizard-error' }, wizard.error));
  if (wizard.status) box.appendChild(h('div', { className: 'prompt-wizard-status' }, wizard.status));

  box.appendChild(
    h('div', { className: 'prompt-wizard-actions' },
      h('button', {
        className: 'nav-btn active',
        disabled: !!wizard.saving,
        onClick: () => { void savePromptWizardPackage(); },
      }, wizard.saving ? 'Saving...' : wizard.mode === 'edit' ? 'Update Prompt Package' : 'Create Prompt Package'),
      h('button', {
        className: 'nav-btn',
        onClick: () => {
          resetPromptWizard('create');
          render();
        },
      }, 'Reset Wizard')
    )
  );

  return box;
}

async function adminDeleteRow(tab: string, row: any) {
  const schema = (((typeof window !== "undefined" && (window as any).ADMIN_SCHEMA) || {}) as any)[tab];
  if (!schema) return;
  const rowId = row?.id ?? row?.[schema.cols?.[0]];
  if (!rowId) return;
  if (!confirm('Delete this item?')) return;
  try {
    const base = normalizeAdminPath(schema.apiPath);
    await api.del(`${base}/${rowId}`);
    await loadAdmin();
    render();
  } catch (e) {
    console.error('Failed to delete row:', e);
  }
}

function adminEditRow(tab: string, row: any) {
  const schema = (((typeof window !== "undefined" && (window as any).ADMIN_SCHEMA) || {}) as any)[tab];
  if (!schema) return;

  state.adminEditing = row?.id ?? row?.[schema.cols?.[0]] ?? null;
  const f = { ...row } as Record<string, unknown>;
  (schema.fields || []).forEach((fd: any) => {
    if (fd.save === 'csvArr' && f[fd.key]) {
      try {
        f[fd.key] = JSON.parse(String(f[fd.key])).join(', ');
      } catch {}
    } else if ((fd.textarea || fd.save === 'json' || fd.save === 'jsonStr') && f[fd.key] != null && typeof f[fd.key] !== 'string') {
      try {
        f[fd.key] = JSON.stringify(f[fd.key], null, 2);
      } catch {}
    }
  });
  state.adminForm = f;
  render();
}

function adminNewRow(tab: string) {
  const schema = (((typeof window !== "undefined" && (window as any).ADMIN_SCHEMA) || {}) as any)[tab];
  if (!schema) return;
  const f: Record<string, unknown> = {};
  (schema.fields || []).forEach((fd: any) => {
    if (fd.default != null) f[fd.key] = fd.default;
  });
  state.adminEditing = null;
  state.adminForm = f;
  render();
}

function adminCancelEdit() {
  state.adminEditing = null;
  state.adminForm = {};
  render();
}

async function adminSaveRow(tab: string) {
  const schema = (((typeof window !== "undefined" && (window as any).ADMIN_SCHEMA) || {}) as any)[tab];
  if (!schema) return;
  const payload: Record<string, unknown> = {};
  const f = (state.adminForm || {}) as Record<string, unknown>;

  (schema.fields || []).forEach((fd: any) => {
    let val = f[fd.key];
    if (fd.save === 'json') {
      try { val = val ? JSON.parse(String(val)) : null; } catch { val = null; }
    } else if (fd.save === 'jsonStr') {
      try { val = val ? JSON.stringify(JSON.parse(String(val))) : null; } catch { val = null; }
    } else if (fd.save === 'int') {
      val = val ? parseInt(String(val), 10) : (fd.default ?? null);
    } else if (fd.save === 'float') {
      val = val ? parseFloat(String(val)) : (fd.default ?? null);
    } else if (fd.save === 'csvArr') {
      val = val ? String(val).split(',').map((s) => s.trim()).filter(Boolean) : [];
    } else if (fd.save === 'bool') {
      val = (val === undefined || val === null) ? (fd.default ?? false) : (val !== false && val !== 'false');
    } else if (fd.save === 'intBool') {
      val = val ? 1 : 0;
    } else {
      val = (val != null && val !== '') ? val : (fd.default ?? null);
    }
    payload[fd.key] = val;
  });

  try {
    const base = normalizeAdminPath(schema.apiPath);
    if (state.adminEditing) {
      await api.put(`${base}/${state.adminEditing}`, payload);
    } else {
      await api.post(base, payload);
    }
    state.adminEditing = null;
    state.adminForm = {};
    await loadAdmin();
    render();
  } catch (e) {
    console.error('Failed to save admin row:', e);
    alert('Save failed. Please check the values and try again.');
  }
}

function renderAdminForm(tab: string) {
  const schema = (((typeof window !== "undefined" && (window as any).ADMIN_SCHEMA) || {}) as any)[tab];
  if (!schema) return h('div', null);
  const isEdit = !!state.adminEditing;
  const form = h('div', { className: 'chart-box', style: 'margin-bottom:16px;' },
    h('h3', null, `${isEdit ? 'Edit' : 'New'} ${schema.singular}`)
  );

  (schema.fields || []).forEach((fd: any) => {
    const currentVal = (state.adminForm?.[fd.key] ?? '') as any;
    const row = h('div', { style: 'margin-bottom:10px;' },
      h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, fd.label)
    );

    if (fd.type === 'checkbox') {
      const cb = h('input', {
        type: 'checkbox',
        checked: !!currentVal,
        onChange: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [fd.key]: (e.target as HTMLInputElement).checked };
        },
      }) as HTMLInputElement;
      row.appendChild(cb);
    } else if (fd.options && Array.isArray(fd.options)) {
      const sel = h('select', {
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        onChange: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [fd.key]: (e.target as HTMLSelectElement).value };
        },
      }) as HTMLSelectElement;
      fd.options.forEach((opt: string) => {
        const o = h('option', { value: opt }, opt) as HTMLOptionElement;
        if (String(currentVal) === String(opt)) o.selected = true;
        sel.appendChild(o);
      });
      row.appendChild(sel);
    } else if (fd.textarea) {
      row.appendChild(h('textarea', {
        rows: String(fd.rows || 3),
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);font-family:var(--mono);',
        value: String(currentVal ?? ''),
        onInput: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [fd.key]: (e.target as HTMLTextAreaElement).value };
        },
      }));
    } else {
      row.appendChild(h('input', {
        type: fd.type === 'number' ? 'number' : 'text',
        value: String(currentVal ?? ''),
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        onInput: (e: Event) => {
          state.adminForm = { ...(state.adminForm || {}), [fd.key]: (e.target as HTMLInputElement).value };
        },
      }));
    }

    form.appendChild(row);
  });

  form.appendChild(h('div', { style: 'display:flex;gap:8px;margin-top:12px;' },
    h('button', { className: 'nav-btn active', onClick: () => { void adminSaveRow(tab); } }, isEdit ? 'Update' : 'Create'),
    h('button', { className: 'nav-btn', onClick: () => adminCancelEdit() }, 'Cancel')
  ));

  return form;
}

function renderAdminView() {
  const tabs = Object.keys(((typeof window !== "undefined" && (window as any).ADMIN_SCHEMA) || {}));
  const currentTab = tabs.includes(state.adminTab) ? state.adminTab : tabs[0];
  const schema = (((typeof window !== "undefined" && (window as any).ADMIN_SCHEMA) || {}) as any)[currentTab];
  const rows = (state.adminData?.[currentTab] || []) as any[];

  const page = h('div', { className: 'dash-view' }, h('h2', null, 'Administration'));
  const layout = h('div', { style: 'display:grid;grid-template-columns:260px minmax(0,1fr);gap:16px;align-items:start;' });

  const left = h('div', { className: 'chart-box', style: 'max-height:74vh;overflow:auto;' });
  (((typeof window !== "undefined" && (window as any).ADMIN_GROUPS) || []) as any).forEach((group: any) => {
    left.appendChild(h('div', { style: 'font-size:11px;color:var(--fg3);text-transform:uppercase;letter-spacing:.4px;margin:8px 0 6px;font-weight:700;' }, `${group.icon} ${group.label}`));
    group.tabs.forEach((tab: any) => {
      if (!tabs.includes(tab.key)) return;
      left.appendChild(h('button', {
        className: state.adminTab === tab.key ? 'nav-btn active' : 'nav-btn',
        style: 'display:block;width:100%;text-align:left;margin-bottom:6px;',
        onClick: () => { state.adminTab = tab.key; render(); },
      }, tab.label));
    });
  });

  const right = h('div', { className: 'table-wrap' });
  if (currentTab === 'prompts') {
    right.appendChild(renderPromptSetupWizard());
  }
  right.appendChild(h('h3', null, schema ? `${schema.singular}s` : 'Records'));
  right.appendChild(h('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:12px 20px 8px;color:var(--fg2);font-size:12px;' },
    h('span', null, `${rows.length} item${rows.length !== 1 ? 's' : ''}`),
    schema?.readOnly ? h('span', null, 'Read only') : h('button', { className: 'nav-btn active', onClick: () => adminNewRow(currentTab) }, '+ New')
  ));
  if (!schema?.readOnly && (state.adminEditing !== null || Object.keys(state.adminForm || {}).length > 0)) {
    right.appendChild(renderAdminForm(currentTab));
  }
  if (!schema) {
    right.appendChild(h('div', { style: 'padding:16px;color:var(--fg3);' }, 'No schema for selected tab.'));
  } else if (!rows.length) {
    right.appendChild(h('div', { style: 'padding:16px;color:var(--fg3);' }, 'No records found.'));
  } else {
    right.appendChild(
      h('table', { className: 'eval-table' },
        h('thead', null,
          h('tr', null,
            ...schema.cols.slice(0, 6).map((c: string) => h('th', null, c.replace(/_/g, ' '))),
            h('th', null, 'Actions')
          )
        ),
        h('tbody', null,
          ...rows.slice(0, 80).map((row: any) =>
            h('tr', null,
              ...schema.cols.slice(0, 6).map((c: string) => h('td', null, String(row?.[c] ?? '-'))),
              h('td', null,
                h('div', { className: 'row-actions' },
                  h('button', { className: 'row-btn row-btn-edit', onClick: () => adminEditRow(currentTab, row) }, 'Edit'),
                  h('button', { className: 'row-btn row-btn-del', onClick: () => { void adminDeleteRow(currentTab, row); } }, 'Delete')
                )
              )
            )
          )
        )
      )
    );
  }

  layout.appendChild(left);
  layout.appendChild(right);
  page.appendChild(layout);
  return page;
}

async function openConnectorsView() {
  await loadConnectors();
  await Promise.all([loadCredentials(), loadSSOProviders(), loadOAuthAccounts(), loadPasswordProviders()]);
  render();
}

const CONNECTOR_DEFS = [
  { id: 'jira', label: 'Jira', category: 'enterprise', desc: 'Project tracking and issue management', color: '#0052CC' },
  { id: 'servicenow', label: 'ServiceNow', category: 'enterprise', desc: 'IT service management and workflows', color: '#62D84E', needsDomain: true },
  { id: 'canva', label: 'Canva', category: 'enterprise', desc: 'Design assets and creative workflows', color: '#00C4CC' },
  { id: 'facebook', label: 'Facebook', category: 'social', desc: 'Pages, posts, and audience engagement', color: '#1877F2' },
  { id: 'instagram', label: 'Instagram', category: 'social', desc: 'Business content and media publishing', color: '#E4405F' },
];

function getConnectorStatus(def: any) {
  const list = def.category === 'social' ? (state.connectors?.social || []) : (state.connectors?.enterprise || []);
  const key = def.category === 'social' ? 'platform' : 'connector_type';
  return list.find((c: any) => c?.[key] === def.id || String(c?.name || '').toLowerCase() === def.id);
}

async function startOAuthFlow(def: any, connectorId: string) {
  const qs = new URLSearchParams({ connector_id: connectorId || '' });
  if (def.needsDomain) {
    const domain = window.prompt('Enter ServiceNow domain (without .service-now.com):', '');
    if (!domain) return;
    qs.set('domain', domain);
  }

  const r = await api.get(`/connectors/${def.id}/authorize?${qs.toString()}`);
  const data = await r.json();
  if (!r.ok || !data.url) {
    alert(data?.error || 'Could not get authorization URL');
    return;
  }

  const popup = window.open(data.url, `oauth-${def.id}`, 'width=600,height=700,scrollbars=yes');
  if (!popup) {
    alert('Popup blocked. Please allow popups for this site.');
    return;
  }

  function onMsg(e: MessageEvent) {
    if (e.origin !== window.location.origin) return;
    if (!e.data || (e.data.type !== 'oauth-success' && e.data.type !== 'oauth-error')) return;
    window.removeEventListener('message', onMsg);
    if (e.data.type === 'oauth-error') {
      alert(`OAuth error: ${e.data.error || 'Unknown error'}`);
    }
    void openConnectorsView();
  }

  window.addEventListener('message', onMsg);
}

async function connectorConnect(def: any) {
  let existing = getConnectorStatus(def);
  let connectorId = existing?.id as string | undefined;
  if (!connectorId) {
    const table = def.category === 'social' ? 'social-accounts' : 'enterprise-connectors';
    const body = def.category === 'social'
      ? { name: def.label, platform: def.id, description: def.desc }
      : { name: def.label, connector_type: def.id, description: def.desc, auth_type: 'oauth2' };
    const r = await api.post(`/admin/${table}`, body);
    const data = await r.json();
    connectorId = data?.['social-account']?.id || data?.['enterprise-connector']?.id;
    existing = getConnectorStatus(def);
  }
  if (!connectorId && existing?.id) connectorId = existing.id;
  if (connectorId) {
    await startOAuthFlow(def, connectorId);
  }
}

async function connectorDisconnect(def: any) {
  const existing = getConnectorStatus(def);
  if (!existing?.id) return;
  await api.post(`/connectors/${existing.id}/disconnect`, { table: def.category === 'social' ? 'social' : 'enterprise' });
  await openConnectorsView();
}

async function connectorTest(def: any) {
  const existing = getConnectorStatus(def);
  if (!existing?.id) return;
  const r = await api.post(`/connectors/${existing.id}/test`, { table: def.category === 'social' ? 'social' : 'enterprise' });
  const data = await r.json();
  alert(data?.ok ? `Connection verified: ${data.message || 'OK'}` : `Connection test failed: ${data?.message || data?.error || 'Unknown error'}`);
}

function startAddCredential() {
  state.credentialEditing = null;
  state.credentialForm = { siteName: '', siteUrlPattern: '', authMethod: 'form_fill', username: '', password: '' };
  render();
}

function startEditCredential(cred: any) {
  state.credentialEditing = cred.id;
  state.credentialForm = {
    siteName: cred.siteName,
    siteUrlPattern: cred.siteUrlPattern,
    authMethod: cred.authMethod,
    username: '',
    password: '',
    headerValue: '',
    cookiesJson: '[]',
  };
  render();
}

async function saveCredential() {
  const f = state.credentialForm || {};
  if (!f.siteName || !f.siteUrlPattern || !f.authMethod) {
    alert('Site Name, URL Pattern, and Auth Method are required.');
    return;
  }

  const config: Record<string, unknown> = { method: f.authMethod };
  if (f.authMethod === 'form_fill') {
    config['username'] = f.username || '';
    config['password'] = f.password || '';
  } else if (f.authMethod === 'header') {
    config['headerValue'] = f.headerValue || '';
  } else if (f.authMethod === 'cookie') {
    try {
      config['cookies'] = JSON.parse(f.cookiesJson || '[]');
    } catch {
      alert('Invalid cookies JSON.');
      return;
    }
  }

  if (state.credentialEditing) {
    await api.put(`/credentials/${state.credentialEditing}`, {
      siteName: f.siteName,
      siteUrlPattern: f.siteUrlPattern,
      authMethod: f.authMethod,
      config,
    });
  } else {
    await api.post('/credentials', {
      siteName: f.siteName,
      siteUrlPattern: f.siteUrlPattern,
      authMethod: f.authMethod,
      config,
    });
  }

  state.credentialEditing = null;
  state.credentialForm = null;
  await loadCredentials();
  render();
}

async function deleteCredential(id: string) {
  if (!confirm('Delete this credential?')) return;
  await api.del(`/credentials/${id}`);
  await loadCredentials();
  render();
}

function renderImportField(label: string, key: string, placeholder: string, isSecret = false) {
  return h('div', null,
    h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, label),
    h('input', {
      type: isSecret ? 'password' : 'text',
      value: state.importConfig?.[key] || '',
      placeholder,
      style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
      onInput: (e: Event) => {
        state.importConfig = { ...(state.importConfig || {}), [key]: (e.target as HTMLInputElement).value };
      },
    })
  );
}

async function runPasswordImport() {
  if (!state.importProvider) return;
  state.importLoading = true;
  state.importResult = null;
  render();
  try {
    const body = {
      provider: state.importProvider,
      config: state.importConfig || {},
      search: state.importConfig?.search || undefined,
    };
    const r = await api.post('/password-providers/import', body);
    const data = await r.json();
    if (!r.ok) {
      state.importResult = { error: data?.error || 'Import failed' };
    } else {
      state.importResult = data;
      await loadCredentials();
    }
  } catch (e) {
    state.importResult = { error: (e as Error)?.message || 'Import failed' };
  } finally {
    state.importLoading = false;
    render();
  }
}

function renderImportPanel() {
  const labels: Record<string, string> = {
    '1password': '1Password',
    bitwarden: 'Bitwarden',
    apple_keychain: 'Apple Keychain',
    chrome: 'Chrome Passwords',
    csv: 'CSV Import',
  };
  const icons: Record<string, string> = {
    '1password': '🔑',
    bitwarden: '🛡',
    apple_keychain: '🍎',
    chrome: '🌐',
    csv: '📄',
  };

  const panel = h('div', { className: 'chart-box', style: 'margin-bottom:16px;border-color:#bfdbfe;background:linear-gradient(180deg,#f0f9ff,#ecfeff);' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;' },
      h('h3', { style: 'margin:0;' }, '📥 Import From Password Manager'),
      h('button', {
        className: 'row-btn',
        onClick: () => {
          state.importShow = false;
          state.importProvider = null;
          state.importConfig = {};
          state.importResult = null;
          render();
        },
      }, 'Close')
    )
  );

  if (!state.importProvider) {
    const providers = state.importProviders || [];
    panel.appendChild(h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;' },
      ...providers.map((p: any) => {
        const available = !!p?.available;
        return h('button', {
          style: `text-align:left;padding:10px;border-radius:10px;border:1px solid ${available ? '#bfdbfe' : '#e5e7eb'};background:${available ? '#ffffff' : '#f8fafc'};opacity:${available ? '1' : '.7'};cursor:${available ? 'pointer' : 'not-allowed'};`,
          title: p?.reason || '',
          onClick: available
            ? () => {
                state.importProvider = p.provider;
                state.importConfig = {};
                state.importResult = null;
                render();
              }
            : undefined,
        },
          h('div', { style: 'font-size:22px;margin-bottom:4px;' }, icons[p.provider] || '🔐'),
          h('div', { style: 'font-size:12px;font-weight:700;color:#0f172a;' }, labels[p.provider] || p.provider),
          h('div', { style: `font-size:11px;color:${available ? '#15803d' : '#b91c1c'};` }, available ? (p.version || 'Available') : 'Unavailable')
        );
      })
    ));
    return panel;
  }

  const selected = state.importProvider as string;
  panel.appendChild(h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:10px;' },
    h('button', {
      className: 'row-btn',
      onClick: () => {
        state.importProvider = null;
        state.importConfig = {};
        state.importResult = null;
        render();
      },
    }, 'Back'),
    h('div', { style: 'font-size:13px;font-weight:700;color:#0f172a;' }, labels[selected] || selected)
  ));

  const configWrap = h('div', { style: 'display:grid;gap:10px;margin-bottom:12px;' });
  if (selected === '1password') {
    configWrap.appendChild(renderImportField('Service Account Token', 'serviceAccountToken', 'OP_SERVICE_ACCOUNT_TOKEN', true));
  } else if (selected === 'bitwarden') {
    configWrap.appendChild(renderImportField('Master Password', 'password', 'Bitwarden master password', true));
    configWrap.appendChild(renderImportField('Client ID (optional)', 'clientId', 'BW_CLIENTID'));
    configWrap.appendChild(renderImportField('Client Secret (optional)', 'clientSecret', 'BW_CLIENTSECRET', true));
  } else if (selected === 'csv') {
    configWrap.appendChild(h('div', null,
      h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, 'CSV Content'),
      h('textarea', {
        rows: '6',
        placeholder: 'Paste CSV export content here...',
        value: state.importConfig?.csvContent || '',
        style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);font-family:var(--mono);',
        onInput: (e: Event) => {
          state.importConfig = { ...(state.importConfig || {}), csvContent: (e.target as HTMLTextAreaElement).value };
        },
      })
    ));
  }
  configWrap.appendChild(renderImportField('Search Filter (optional)', 'search', 'Import only matching entries'));
  panel.appendChild(configWrap);

  panel.appendChild(h('div', { style: 'display:flex;align-items:center;gap:10px;' },
    h('button', {
      className: 'nav-btn active',
      onClick: () => { void runPasswordImport(); },
      disabled: state.importLoading ? 'true' : undefined,
    }, state.importLoading ? 'Importing...' : 'Import Credentials'),
    state.importResult?.error
      ? h('span', { style: 'font-size:12px;color:#b91c1c;' }, `Error: ${state.importResult.error}`)
      : state.importResult
        ? h('span', { style: 'font-size:12px;color:#15803d;' }, `Imported ${state.importResult.imported || 0} of ${state.importResult.total || 0}`)
        : null
  ));

  return panel;
}

function renderCredentialForm() {
  const f = state.credentialForm || {};
  const isEdit = !!state.credentialEditing;
  return h('div', { className: 'chart-box', style: 'margin-bottom:16px;' },
    h('h3', null, isEdit ? 'Edit Browser Credential' : 'New Browser Credential'),
    h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px;' },
      h('div', null,
        h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, 'Site Name'),
        h('input', {
          value: f.siteName || '',
          onInput: (e: Event) => {
            state.credentialForm = { ...f, siteName: (e.target as HTMLInputElement).value };
          },
          style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        })
      ),
      h('div', null,
        h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, 'URL Pattern'),
        h('input', {
          value: f.siteUrlPattern || '',
          onInput: (e: Event) => {
            state.credentialForm = { ...f, siteUrlPattern: (e.target as HTMLInputElement).value };
          },
          style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        })
      ),
      h('div', { style: 'grid-column:1/-1;' },
        h('label', { style: 'display:block;font-size:12px;font-weight:600;color:var(--fg2);margin-bottom:4px;' }, 'Auth Method'),
        h('select', {
          value: f.authMethod || 'form_fill',
          onChange: (e: Event) => {
            state.credentialForm = { ...f, authMethod: (e.target as HTMLSelectElement).value };
            render();
          },
          style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
        },
          h('option', { value: 'form_fill' }, 'Form Fill (username/password)'),
          h('option', { value: 'header' }, 'Header Auth'),
          h('option', { value: 'cookie' }, 'Cookie Injection')
        )
      ),
      (f.authMethod || 'form_fill') === 'form_fill'
        ? h('div', { style: 'grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:10px;' },
            h('input', {
              type: 'text',
              placeholder: 'Username',
              value: f.username || '',
              onInput: (e: Event) => {
                state.credentialForm = { ...f, username: (e.target as HTMLInputElement).value };
              },
              style: 'padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
            }),
            h('input', {
              type: 'password',
              placeholder: 'Password',
              value: f.password || '',
              onInput: (e: Event) => {
                state.credentialForm = { ...f, password: (e.target as HTMLInputElement).value };
              },
              style: 'padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
            })
          )
        : null,
      (f.authMethod || 'form_fill') === 'header'
        ? h('div', { style: 'grid-column:1/-1;' },
            h('input', {
              type: 'password',
              placeholder: 'Authorization header value',
              value: f.headerValue || '',
              onInput: (e: Event) => {
                state.credentialForm = { ...f, headerValue: (e.target as HTMLInputElement).value };
              },
              style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);',
            })
          )
        : null,
      (f.authMethod || 'form_fill') === 'cookie'
        ? h('div', { style: 'grid-column:1/-1;' },
            h('textarea', {
              rows: '4',
              placeholder: '[{"name":"session","value":"...","domain":".example.com"}]',
              value: f.cookiesJson || '[]',
              onInput: (e: Event) => {
                state.credentialForm = { ...f, cookiesJson: (e.target as HTMLTextAreaElement).value };
              },
              style: 'width:100%;padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg2);color:var(--fg);font-family:var(--mono);',
            })
          )
        : null
    ),
    h('div', { style: 'display:flex;gap:8px;margin-top:12px;' },
      h('button', { className: 'nav-btn active', onClick: () => { void saveCredential(); } }, isEdit ? 'Update' : 'Save'),
      h('button', {
        className: 'nav-btn',
        onClick: () => {
          state.credentialForm = null;
          state.credentialEditing = null;
          render();
        },
      }, 'Cancel')
    )
  );
}

function renderCredentialsSection() {
  const wrap = h('div', { style: 'margin-top:28px;' },
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;' },
      h('div', null,
        h('h3', { style: 'margin:0 0 2px;font-size:15px;color:var(--fg);' }, '🔒 Browser Passwords'),
        h('p', { style: 'margin:0;font-size:12px;color:var(--fg2);' }, 'Credentials used by browser tools for auto-login')
      ),
      h('div', { style: 'display:flex;gap:8px;' },
        h('button', {
          className: 'nav-btn',
          onClick: () => {
            state.importShow = !state.importShow;
            state.importProvider = null;
            state.importConfig = {};
            state.importResult = null;
            if (state.importShow) {
              void loadPasswordProviders();
            }
            render();
          },
        }, 'Import'),
        h('button', { className: 'nav-btn active', onClick: () => startAddCredential() }, '+ Add Credential')
      )
    )
  );

  if (state.importShow) {
    wrap.appendChild(renderImportPanel());
  }

  if (state.credentialForm) {
    wrap.appendChild(renderCredentialForm());
  }

  const creds = state.credentials || [];
  if (!creds.length && !state.credentialForm) {
    wrap.appendChild(h('div', { className: 'chart-box' }, h('div', { style: 'font-size:13px;color:var(--fg2);' }, 'No browser credentials saved yet.')));
    return wrap;
  }

  const grid = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;' });
  creds.forEach((cred: any) => {
    grid.appendChild(h('div', { className: 'card', style: 'padding:16px;' },
      h('div', { style: 'font-weight:700;color:var(--fg);font-size:14px;margin-bottom:4px;' }, cred.siteName || 'Site'),
      h('div', { style: 'font-family:var(--mono);font-size:11px;color:var(--fg3);margin-bottom:8px;word-break:break-all;' }, cred.siteUrlPattern || ''),
      h('div', { style: 'font-size:12px;color:var(--fg2);margin-bottom:10px;' }, `Method: ${cred.authMethod || 'unknown'}`),
      h('div', { className: 'row-actions' },
        h('button', { className: 'row-btn row-btn-edit', onClick: () => startEditCredential(cred) }, 'Edit'),
        h('button', { className: 'row-btn row-btn-del', onClick: () => { void deleteCredential(cred.id); } }, 'Delete')
      )
    ));
  });
  wrap.appendChild(grid);
  return wrap;
}

function renderLinkedAccountsSection() {
  const panel = h('div', { style: 'margin-top:20px;display:grid;grid-template-columns:1fr 1fr;gap:14px;' });

  const sso = state.ssoProviders || [];
  panel.appendChild(h('div', { className: 'chart-box' },
    h('h3', null, '🔐 Linked SSO Providers'),
    sso.length
      ? h('div', { style: 'display:flex;flex-direction:column;gap:8px;' },
          ...sso.map((p: any) =>
            h('div', { style: 'padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg3);font-size:12px;color:var(--fg2);' },
              `${p.providerName || p.name || 'Provider'} • ${p.status || 'active'}`
            )
          )
        )
      : h('div', { style: 'font-size:12px;color:var(--fg3);' }, 'No linked SSO providers')
  ));

  const oauth = state.oauthAccounts || [];
  panel.appendChild(h('div', { className: 'chart-box' },
    h('h3', null, '🔗 Linked OAuth Accounts'),
    oauth.length
      ? h('div', { style: 'display:flex;flex-direction:column;gap:8px;' },
          ...oauth.map((a: any) =>
            h('div', { style: 'padding:8px 10px;border:1px solid var(--bg4);border-radius:8px;background:var(--bg3);font-size:12px;color:var(--fg2);' },
              `${a.provider || 'Provider'} • ${a.account_email || a.account_id || 'Connected'}`
            )
          )
        )
      : h('div', { style: 'font-size:12px;color:var(--fg3);' }, 'No linked OAuth accounts')
  ));

  return panel;
}

function renderConnectorsView() {
  const view = h('div', { className: 'dash-view' });
  view.appendChild(h('h2', null, '⚡ Connectors'));

  if (state.connectorsLoading) {
    view.appendChild(h('div', { className: 'empty-chat' }, 'Loading connectors...'));
    return view;
  }

  view.appendChild(h('div', { style: 'margin-bottom:24px' },
    h('h3', { style: 'font-size:16px;font-weight:700;margin-bottom:12px;color:var(--fg);' }, '🏢 Enterprise'),
    h('p', { style: 'font-size:13px;color:var(--fg2);margin-bottom:16px;' }, 'Connect business tools and integrations'),
    h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;' },
      ...CONNECTOR_DEFS.filter((d) => d.category === 'enterprise').map((def: any) => {
        const existing = getConnectorStatus(def);
        const connected = existing && existing.status === 'connected';
        return h('div', { className: 'card', style: 'padding:20px;' },
          h('div', { className: 'label' }, def.label),
          h('div', { style: 'font-size:14px;color:var(--fg);margin-bottom:8px;font-weight:600;' }, connected ? 'Connected' : 'Not connected'),
          h('div', { style: 'font-size:12px;color:var(--fg2);margin-bottom:16px;line-height:1.5;' }, def.desc),
          connected
            ? h('div', { style: 'display:flex;gap:8px;' },
                h('button', { className: 'row-btn row-btn-edit', style: 'flex:1;', onClick: () => { void connectorTest(def); } }, 'Test'),
                h('button', { className: 'row-btn row-btn-del', style: 'flex:1;', onClick: () => { void connectorDisconnect(def); } }, 'Disconnect')
              )
            : h('button', { className: 'nav-btn active', style: `width:100%;background:${def.color};border-color:${def.color};`, onClick: () => { void connectorConnect(def); } }, 'Connect')
        );
      })
    )
  ));

  view.appendChild(h('div', { style: 'margin-bottom:24px' },
    h('h3', { style: 'font-size:16px;font-weight:700;margin-bottom:12px;color:var(--fg);' }, '📱 Social Media'),
    h('p', { style: 'font-size:13px;color:var(--fg2);margin-bottom:16px;' }, 'Connect social platforms and messaging services'),
    h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;' },
      ...CONNECTOR_DEFS.filter((d) => d.category === 'social').map((def: any) => {
        const existing = getConnectorStatus(def);
        const connected = existing && existing.status === 'connected';
        return h('div', { className: 'card', style: 'padding:20px;' },
          h('div', { className: 'label' }, def.label),
          h('div', { style: 'font-size:14px;color:var(--fg);margin-bottom:8px;font-weight:600;' }, connected ? 'Connected' : 'Not connected'),
          h('div', { style: 'font-size:12px;color:var(--fg2);margin-bottom:16px;line-height:1.5;' }, def.desc),
          connected
            ? h('div', { style: 'display:flex;gap:8px;' },
                h('button', { className: 'row-btn row-btn-edit', style: 'flex:1;', onClick: () => { void connectorTest(def); } }, 'Test'),
                h('button', { className: 'row-btn row-btn-del', style: 'flex:1;', onClick: () => { void connectorDisconnect(def); } }, 'Disconnect')
              )
            : h('button', { className: 'nav-btn active', style: `width:100%;background:${def.color};border-color:${def.color};`, onClick: () => { void connectorConnect(def); } }, 'Connect')
        );
      })
    )
  ));

  view.appendChild(renderCredentialsSection());
  view.appendChild(renderLinkedAccountsSection());

  return view;
}

function renderPreferencesView() {
  const view = h('div', { className: 'dash-view' },
    h('h2', null, '⚙ Preferences')
  );

  // Theme selection
  view.appendChild(h('div', { className: 'chart-box', style: 'max-width:760px;' },
    h('h3', null, 'Appearance'),
    h('p', { style: 'font-size:13px;line-height:1.6;color:var(--fg2);margin-bottom:16px;' }, 'Choose how geneWeave looks for your account'),
    h('div', { style: 'display:flex;gap:12px;margin-bottom:16px;' },
      h('button', {
        className: 'nav-btn' + (state.theme === 'light' ? ' active' : ''),
        style: 'flex:1;',
        onClick: () => {
          state.theme = 'light';
          document.documentElement.setAttribute('data-theme', 'light');
          render();
        }
      }, '☀ Light'),
      h('button', {
        className: 'nav-btn' + (state.theme === 'dark' ? ' active' : ''),
        style: 'flex:1;',
        onClick: () => {
          state.theme = 'dark';
          document.documentElement.setAttribute('data-theme', 'dark');
          render();
        }
      }, '🌙 Dark')
    ),
    h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;' },
      h('div', { className: 'card', style: 'padding:18px;' },
        h('div', { className: 'label' }, 'Current Theme'),
        h('div', { style: 'font-size:20px;font-weight:700;color:var(--fg);margin-bottom:8px;' }, state.theme === 'dark' ? '🌙 Dark' : '☀ Light'),
        h('div', { style: 'font-size:12px;color:var(--fg2);line-height:1.6;' }, state.theme === 'dark' ? 'Dark mode for reduced glare' : 'Light mode for better visibility')
      ),
      h('div', { className: 'card', style: 'padding:18px;' },
        h('div', { className: 'label' }, 'Account'),
        h('div', { style: 'font-size:15px;font-weight:700;color:var(--fg);margin-bottom:4px;' }, state.user?.name || 'User'),
        h('div', { style: 'font-size:12px;color:var(--fg2);line-height:1.6;' }, state.user?.email || 'No email')
      )
    )
  ));

  return view;
}

function renderHomeWorkspace() {
  const settingsAnchor = h('div', { className: 'dropdown-anchor' });
  const settingsBtn = h('button', {
    className: 'nav-btn' + (state.showSettings ? ' active' : ''),
    title: 'AI Settings',
    style: 'font-size:12px;padding:7px 10px;line-height:1;',
    onClick: async (e: Event) => {
      e.stopPropagation();
      if (!state.chatSettings && state.currentChatId) {
        await loadChatSettings(state.currentChatId);
      }
      if (!state.chatSettings) {
        state.chatSettings = {
          mode: state.defaultMode || 'direct',
          systemPrompt: '',
          timezone: '',
          enabledTools: [],
          redactionEnabled: false,
          redactionPatterns: ['email', 'phone', 'ssn', 'credit_card'],
          workers: [],
        };
      }
      state.showSettings = !state.showSettings;
      render();
    },
  }, '⚙');
  settingsAnchor.appendChild(settingsBtn);

  if (state.showSettings && state.chatSettings) {
    const dd = renderSettingsDropdown();
    document.body.appendChild(dd);
    requestAnimationFrame(() => {
      const r = settingsBtn.getBoundingClientRect();
      dd.style.top = (r.bottom + 8) + 'px';
      dd.style.right = (window.innerWidth - r.right) + 'px';
    });
  }

  const modelSel = h('select', {
    className: 'model-sel',
    onChange: function(this: HTMLSelectElement) {
      state.selectedModel = this.value;
    },
  }) as HTMLSelectElement;
  (state.models || []).forEach((m: any) => {
    const val = `${m.provider}:${m.id}`;
    const opt = h('option', { value: val }, `${m.provider}/${m.id}`) as HTMLOptionElement;
    if (val === state.selectedModel) opt.selected = true;
    modelSel.appendChild(opt);
  });

  const center = h('section', {className:'center-card'},
    h('div', {className:'center-card-hdr'},
      h('div', {className:'agent-strip'},
        h('div', {className:'lead'}, h('img', {src:getAgentAvatarUrl('geneweave-supervisor')}), h('span',null,'geneWeave Agent'))
      ),
      h('div', {style:'display:flex;align-items:center;gap:8px'},
        h('div', {className:'title'}, (state.chats.find((c: Chat) => c.id === state.currentChatId)?.title) || 'Conversation'),
        modelSel,
        settingsAnchor
      )
    ),
    renderChatView()
  );

  const rightRail = h('aside', { className: 'right-rail' },
    renderCalendarWidget(),
    renderActionsWidget()
  );

  return h('div', {className:'workspace-home'},
    renderWorkspaceTopCard(),
    h('div', { className: 'workspace-body' }, center, rightRail)
  );
}

function renderApp() {
  const wrap = h('div', {className:'app'});
  wrap.appendChild(renderWorkspaceNav());
  
  const main = h('div', {className:'main'});
  if (state.view === 'dashboard') {
    main.appendChild(renderDashboardView());
  } else if (state.view === 'admin') {
    main.appendChild(renderAdminView());
  } else if (state.view === 'connectors') {
    main.appendChild(renderConnectorsView());
  } else if (state.view === 'preferences') {
    main.appendChild(renderPreferencesView());
  } else {
    main.appendChild(renderHomeWorkspace());
  }
  wrap.appendChild(main);
  
  return wrap;
}

// Global render function
function render() {
  document.querySelectorAll('body > .dropdown').forEach((el) => el.remove());
  const root = document.getElementById('root');
  if (!root) return;
  
  if (!state.user) {
    root.innerHTML = '';
    root.appendChild(renderAuth());
  } else {
    root.innerHTML = '';
    root.appendChild(renderApp());
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

export function initialize() {
  document.addEventListener('click', () => {
    if (state.showSettings || state.showProfile || state.showNotifications) {
      state.showSettings = false;
      state.showProfile = false;
      state.showNotifications = false;
      render();
    }
  });

  // Check authentication and load data
  (async () => {
    try {
      const r = await api.get('/auth/check');
      if (r && typeof r === 'object' && 'ok' in r && (r as Response).ok) {
        const d = await (r as Response).json() as any;
        if (d.authenticated) {
        state.user = d.user;
        state.csrfToken = d.csrfToken;
        await loadChats();
        await Promise.all([loadModels(), loadTools(), loadUserPreferences()]);
        }
      }
      render();
    } catch (e) {
      console.error('Initialization failed:', e);
      render();
    }
  })();
}

// Make functions globally available
(globalThis as any).render = render;
(globalThis as any).sendMessage = sendMessage;
(globalThis as any).createChat = createChat;
(globalThis as any).selectChat = selectChat;
(globalThis as any).doLogout = doLogout;
(globalThis as any).initialize = initialize;
