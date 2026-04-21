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
  loadChatSettings,
  saveChatSettings
} from './ui/api.js';

import { 
  doLogout,
  renderAuth
} from './ui/auth.js';
import {
  parseMessageMetadata,
  shortText,
  detailText,
  summarizeForDisplay,
  parseJsonMaybe,
  parseDelimitedTable,
  formatXml,
  detectCodeLanguage,
  normalizeCodeLanguage,
  friendlyLanguageName,
  looksLikeCode,
  tableFromJson,
  extractCodePayloadFromJson,
} from './ui/formatting.js';
import {
  normalizeAdminPath,
  slugifyPromptKey,
  ensureWizardFrameworkSections,
  buildFrameworkSectionsFromWizard,
} from './ui/prompt-wizard-utils.js';
import {
  promptWizardRows,
  extractTemplateTokens,
} from './ui/prompt-wizard-derivation.js';
import {
  ensurePromptWizardState,
  resetPromptWizard,
} from './ui/prompt-wizard-state.js';
import {
  hydrateWizardFromPromptRow,
} from './ui/prompt-wizard-hydration.js';
import {
  buildQueuedPromptWizardFragment,
  buildPromptContractCreatePayload,
  buildPromptFragmentCreatePayload,
  buildPromptFrameworkCreatePayload,
  buildPromptStrategyCreatePayload,
  buildPromptWizardPayload,
} from './ui/prompt-wizard-payloads.js';
import {
  insertFragmentMarkerIntoTemplate,
  moveWizardFrameworkSection,
  renderPromptTemplatePreview,
} from './ui/prompt-wizard-ui.js';
import {
  adminBackToList,
  clearAdminEditorState,
  renderAdminView,
  parseAdminHash,
  adminEditRow,
  getAdminSchema,
} from './ui/admin-ui.js';
import {
  openConnectorsView,
  renderConnectorsView,
} from './ui/connectors-ui.js';
import {
  renderActionsWidget,
  renderCalendarWidget,
  renderDashboardView,
  renderProfileDropdown,
  renderWorkspaceNav,
  renderWorkspaceTopCard,
} from './ui/workspace-shell.js';
import {
  hydrateWizardFromPrompt,
  renderPromptSetupWizard as renderPromptSetupWizardView,
} from './ui/prompt-wizard-view.js';
import { renderAssistantProcess } from './ui/process-ui.js';
import {
  renderChatView as renderChatViewShell,
  renderSettingsDropdown as renderSettingsDropdownView,
} from './ui/chat-view.js';
import type { Message, Chat } from './ui/types.js';
import {
  renderSVSubmitView,
  renderSVLiveView,
  renderSVVerdictView,
} from './features/scientific-validation/ui/index.js';


// ============================================================================
// RENDERING FUNCTIONS
// ============================================================================

const dashboardFlowFilters: { mode: string; agent: string; toolQuery: string } = {
  mode: 'all',
  agent: 'all',
  toolQuery: '',
};

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
            if (d.redaction) assistantMsg.redaction = d.redaction;
            if (d.guardrail) assistantMsg.guardrail = d.guardrail;
            assistantMsg.processState = 'completed';
            assistantMsg.processExpanded = false;
            touchChat(chatId, d.title || undefined);
          }
        } catch {
          // Ignore malformed stream chunks.
        }
      }

      render();
      scrollMessages();
    }
  } catch (error: any) {
    if (assistantMsg) {
      assistantMsg.processState = 'error';
      assistantMsg.content = assistantMsg.content || `Error: ${error?.message || 'Request failed'}`;
    } else {
      state.messages.push({
        role: 'assistant',
        content: `Error: ${error?.message || 'Request failed'}`,
        created_at: new Date().toISOString(),
      } as any);
    }
  } finally {
    if (assistantMsg && assistantMsg.processState === 'running') {
      assistantMsg.processState = assistantMsg.content ? 'completed' : 'error';
      assistantMsg.latency_ms = assistantMsg.latency_ms || (Date.now() - startedAtMs);
    }
    state.streaming = false;
    render();
    scrollMessages();
  }
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
      const processCard = renderAssistantProcess(m as any, isStreamingCurrent, {
        rerenderMessages: renderMessages,
        renderProcessDetailView,
      });
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
  return renderChatViewShell({
    render,
    renderMessages,
    sendMessage,
  });
}

function renderSettingsDropdown() {
  return renderSettingsDropdownView({
    render,
    saveChatSettings,
  });
}

function renderPromptSetupWizard() {
  return renderPromptSetupWizardView(render);
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
    renderCalendarWidget(render),
    renderActionsWidget(selectChat)
  );

  return h('div', {className:'workspace-home'},
    h('div', { className: 'workspace-body' }, center, rightRail)
  );
}

function renderApp() {
  const wrap = h('div', {className:'app'});
  wrap.appendChild(renderWorkspaceNav({
    render,
    openConnectorsView: () => { void openConnectorsView(render); },
    loadDashboard,
    loadAdmin,
    clearAdminEditorState,
    selectChat,
    deleteChat,
  }));
  
  const main = h('div', {className:'main'});
  main.appendChild(h('div', { className: 'main-header' },
    renderWorkspaceTopCard({
      render,
      createChat,
      selectChat,
      renderProfileDropdown: () => renderProfileDropdown({ render, doLogout, loadDashboard, loadAdmin }),
    })
  ));
  if (state.view === 'dashboard') {
    main.appendChild(renderDashboardView({
      render,
      loadAdmin,
      formatCompactNumber,
      formatCurrencyCompact,
      formatMaybeCompactValue,
    }));
  } else if (state.view === 'admin') {
    main.appendChild(renderAdminView({
      hydrateWizardFromPrompt,
      renderPromptSetupWizard,
      render,
      loadAdmin,
    }));
  } else if (state.view === 'connectors') {
    main.appendChild(renderConnectorsView(render));
  } else if (state.view === 'preferences') {
    main.appendChild(renderPreferencesView());
  } else if (state.view === 'scientific-validation') {
    const svView = (state as any).svView as string;
    if (svView === 'live') {
      main.appendChild(renderSVLiveView({ render }));
    } else if (svView === 'verdict') {
      main.appendChild(renderSVVerdictView({ render }));
    } else {
      main.appendChild(renderSVSubmitView({ render }));
    }
  } else {
    main.appendChild(renderHomeWorkspace());
  }
  wrap.appendChild(main);
  
  return wrap;
}

const UI_STATE_KEY = 'geneweave.uiState.v1';
let renderVersion = 0;

function restoreUiStateFromStorage() {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(UI_STATE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as any;
    const allowedViews = new Set(['chat', 'connectors', 'admin', 'dashboard', 'preferences', 'scientific-validation']);

    if (typeof saved?.view === 'string' && allowedViews.has(saved.view)) {
      state.view = saved.view;
    }
    if (typeof saved?.adminTab === 'string') {
      state.adminTab = saved.adminTab;
    }
    if (typeof saved?.currentChatId === 'string' || saved?.currentChatId === null) {
      state.currentChatId = saved.currentChatId;
    }
    if (typeof saved?.adminMenuExpanded === 'boolean') {
      state.adminMenuExpanded = saved.adminMenuExpanded;
    }
    if (typeof saved?.recentChatsExpanded === 'boolean') {
      state.recentChatsExpanded = saved.recentChatsExpanded;
    }
    if (typeof saved?.sidebarCollapsed === 'boolean') {
      state.sidebarCollapsed = saved.sidebarCollapsed;
    }
    if (saved?.adminGroupExpanded && typeof saved.adminGroupExpanded === 'object') {
      const next: Record<string, boolean> = {};
      Object.entries(saved.adminGroupExpanded).forEach(([k, v]) => {
        if (typeof v === 'boolean') next[k] = v;
      });
      state.adminGroupExpanded = next;
    }
  } catch {
    // Ignore malformed localStorage state.
  }
}

function persistUiStateToStorage() {
  if (typeof window === 'undefined') return;
  try {
    const payload = {
      view: state.view,
      adminTab: state.adminTab,
      currentChatId: state.currentChatId,
      adminMenuExpanded: !!state.adminMenuExpanded,
      adminGroupExpanded: state.adminGroupExpanded || {},
      recentChatsExpanded: typeof state.recentChatsExpanded === 'boolean' ? state.recentChatsExpanded : true,
      sidebarCollapsed: !!state.sidebarCollapsed,
    };
    window.localStorage.setItem(UI_STATE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage write failures.
  }
}

// Global render function
function render() {
  persistUiStateToStorage();
  document.querySelectorAll('body > .dropdown').forEach((el) => el.remove());
  const root = document.getElementById('root');
  if (!root) return;
  const navBeforeRender = root.querySelector('.workspace-nav-scroll') as HTMLElement | null;
  const previousSidebarScrollTop = navBeforeRender
    ? navBeforeRender.scrollTop
    : Math.max(0, state.sidebarScrollTop || 0);
  if (navBeforeRender) {
    state.sidebarScrollTop = navBeforeRender.scrollTop;
  }
  const thisRenderVersion = ++renderVersion;
  
  if (!state.user) {
    root.innerHTML = '';
    root.appendChild(renderAuth());
  } else {
    root.innerHTML = '';
    root.appendChild(renderApp());
    // Double-rAF: first frame inserts DOM, second frame has computed layout
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (thisRenderVersion !== renderVersion) return;
        const navScrollEl = root.querySelector('.workspace-nav-scroll') as HTMLElement | null;
        if (!navScrollEl) return;
        navScrollEl.scrollTop = previousSidebarScrollTop;
        const activeSubTab = navScrollEl.querySelector('.admin-subtab.active') as HTMLElement | null;
        if (activeSubTab) {
          // Keep the active tab visible while preserving current sidebar position as much as possible.
          const containerRect = navScrollEl.getBoundingClientRect();
          const elRect = activeSubTab.getBoundingClientRect();
          if (elRect.top < containerRect.top) {
            navScrollEl.scrollTop += elRect.top - containerRect.top - 12;
          } else if (elRect.bottom > containerRect.bottom) {
            navScrollEl.scrollTop += elRect.bottom - containerRect.bottom + 12;
          }
        }
        state.sidebarScrollTop = navScrollEl.scrollTop;
      });
    });
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
      restoreUiStateFromStorage();

      // Apply admin deep-link hash before rendering (e.g. #admin/prompts/42)
      const adminHashTarget = parseAdminHash();
      if (adminHashTarget) {
        state.view = 'admin';
        state.adminTab = adminHashTarget.tab;
        state.adminMenuExpanded = true;
      }

      const r = await api.get('/auth/check');
      if (r && typeof r === 'object' && 'ok' in r && (r as Response).ok) {
        const d = await (r as Response).json() as any;
        if (d.authenticated) {
        state.user = d.user;
        state.csrfToken = d.csrfToken;
        await loadChats();
        await Promise.all([loadModels(), loadTools(), loadUserPreferences()]);

        if (state.view === 'dashboard') {
          await loadDashboard();
        } else if (state.view === 'connectors') {
          await openConnectorsView(render);
        } else if (state.view === 'admin') {
          await loadAdmin();
          // If URL had a record deep-link, open that record after data is loaded
          if (adminHashTarget?.id) {
            const tabRows = (state.adminData?.[adminHashTarget.tab] || []) as any[];
            const targetRow = tabRows.find((r: any) =>
              String(r?.id ?? '') === String(adminHashTarget.id) ||
              String(r?.[getAdminSchema(adminHashTarget.tab)?.cols?.[0]] ?? '') === String(adminHashTarget.id)
            );
            if (targetRow) {
              adminEditRow(adminHashTarget.tab, targetRow, hydrateWizardFromPrompt, render);
            }
          }
        }
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
(globalThis as any).state = state;
