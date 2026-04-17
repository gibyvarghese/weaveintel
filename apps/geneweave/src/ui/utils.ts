// Common utility functions for UI
import { state, toYMD } from './state.js';
import { api } from './api.js';

/* Theme Management */
export function normalizeTheme(val: any): 'light' | 'dark' {
  return val === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: 'light' | 'dark') {
  state.theme = theme;
  const html = document.documentElement;
  if (theme === 'dark') {
    html.setAttribute('data-theme', 'dark');
  } else {
    html.removeAttribute('data-theme');
  }
  persistTheme(theme);
}

export function loadStoredTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem('geneweave-theme');
  return normalizeTheme(stored);
}

export function persistTheme(theme: 'light' | 'dark') {
  localStorage.setItem('geneweave-theme', theme);
  api.post('/preferences', { theme }).catch(() => {});
}

export function setTheme(theme: 'light' | 'dark') {
  applyTheme(theme);
}

/* Avatar URLs */
export function avatarIndex(name: string): number {
  const AVATAR_COUNT = 26;
  if (!name) return 1;
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h) + name.charCodeAt(i);
    h = h & h; // Convert to 32bit integer
  }
  return (Math.abs(h) % AVATAR_COUNT) + 1;
}

export function avatarUrl(index: number): string {
  return `/avatar/avatar-${index}.webp`;
}

export function getUserAvatarUrl(): string {
  const seed = state.user?.id || state.user?.email || 'user';
  return avatarUrl(avatarIndex(seed));
}

export function getAgentAvatarUrl(agentName?: string): string {
  return avatarUrl(avatarIndex(agentName || 'geneweave-agent'));
}

/* Text Processing */
export function normalizeText(txt: string): string {
  return (txt || '').trim().replace(/\s+/g, ' ');
}

export function tokenSet(txt: string): Set<string> {
  return new Set(
    normalizeText(txt)
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0)
  );
}

export function trigramSet(txt: string): Set<string> {
  const text = normalizeText(txt).toLowerCase();
  const trigrams = new Set<string>();
  for (let i = 0; i <= text.length - 3; i++) {
    trigrams.add(text.substring(i, i + 3));
  }
  return trigrams;
}

export function semanticScore(query: string, text: string): number {
  const qTokens = tokenSet(query);
  const tTokens = tokenSet(text);
  const qTrigrams = trigramSet(query);
  const tTrigrams = trigramSet(text);

  const tokenIntersection = Array.from(qTokens).filter((t) => tTokens.has(t)).length;
  const trigramIntersection = Array.from(qTrigrams).filter((t) => tTrigrams.has(t)).length;

  const tokenScore = qTokens.size > 0 ? tokenIntersection / qTokens.size : 0;
  const trigramScore = qTrigrams.size > 0 ? trigramIntersection / qTrigrams.size : 0;

  return tokenScore * 0.6 + trigramScore * 0.4;
}

/* Chat search */
export function ensureChatSearchIndex(messages: any[]) {
  if (!state._chatSearchIndex) {
    state._chatSearchIndex = {};
    messages.forEach((msg: any, i: number) => {
      state._chatSearchIndex[i] = normalizeText(msg.content || '');
    });
  }
}

export function runSemanticChatSearch(query: string) {
  if (!query.trim()) {
    state.chatSearchResults = [];
    state.chatSearchLoading = false;
    return;
  }

  state.chatSearchLoading = true;
  ensureChatSearchIndex(state.messages);

  const results = state.chats
    .map((c: any) => ({
      id: c.id,
      title: c.title || 'Chat',
      updated_at: c.updated_at || c.created_at,
      score: semanticScore(query, (c.title || '') + ' ' + (c.description || '')),
    }))
    .filter((r: any) => r.score > 0.2)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, 5);

  state.chatSearchResults = results;
  state.chatSearchLoading = false;
}

/* Delegated workers */
export function getDelegatedWorkers(messages: any[]): string[] {
  const workers = new Set<string>();
  messages.forEach((m: any) => {
    if (m.steps) {
      m.steps.forEach((s: any) => {
        if (s.type === 'delegation' && (s.worker || s.name)) {
          workers.add(s.worker || s.name);
        }
        if (s.toolCall?.name === 'delegate_to_worker' && s.toolCall?.arguments?.worker) {
          workers.add(s.toolCall.arguments.worker);
        }
      });
    }
  });
  return Array.from(workers);
}

/* Message normalization */
export function normalizeLoadedMessage(msg: any): any {
  if (!msg.processUi && (msg.process || msg.timeline)) {
    msg.processUi = {};
  }
  return msg;
}

/* Data encoding */
export function toBase64(str: string): string {
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch (e) {
    return '';
  }
}

/* File handling */
export async function queueFiles(files: File[]) {
  for (const file of files) {
    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = (e.target?.result as string)?.split(',')[1];
        if (base64) {
          state.pendingAttachments.push({
            name: file.name,
            mimeType: file.type,
            size: file.size,
            dataBase64: base64,
          });
        }
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error('Failed to process file:', file.name, err);
    }
  }
}

export function removePendingAttachment(index: number) {
  state.pendingAttachments.splice(index, 1);
}

/* Audio recording */
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];

export async function toggleAudioRecording() {
  if (state.audioRecording) {
    stopAudioRecognition();
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];

      mediaRecorder.ondataavailable = (e: BlobEvent) => {
        audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const base64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = (reader.result as string).split(',')[1];
            // @ts-ignore - result is guaranteed to be a string
            resolve(result);
          };
          reader.readAsDataURL(audioBlob);
        });

        state.pendingAttachments.push({
          name: 'audio-' + Date.now() + '.webm',
          mimeType: 'audio/webm',
          size: audioBlob.size,
          dataBase64: base64,
        });

        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start();
      state.audioRecording = true;
    } catch (err) {
      console.error('Audio recording failed:', err);
    }
  }
}

export function stopAudioRecognition() {
  if (mediaRecorder) {
    mediaRecorder.stop();
    state.audioRecording = false;
  }
}

/* Clipboard & export */
export async function copyResponse(text: string, btn: HTMLElement) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    copyTextWithFeedback(btn);
  } catch (e) {
    console.error('Copy failed:', e);
  }
}

export function copyTextWithFeedback(btn: HTMLElement) {
  const origText = btn.innerText;
  btn.innerText = '✓ Copied!';
  setTimeout(() => {
    btn.innerText = origText;
  }, 2000);
}

export async function emailResponse(text: string, subject: string) {
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  window.location.href = mailto;
}

export async function openInWord(html: string, text: string) {
  try {
    const blob = new Blob([html], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'geneweave-response.doc';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error('Failed to export to Word:', e);
  }
}

/* Numeric utilities */
export function numericValue(v: any): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/* Text display */
export function shortText(txt: string, maxLen: number = 40): string {
  if (!txt) return '';
  return txt.length > maxLen ? txt.slice(0, maxLen) + '…' : txt;
}

export function detailText(txt: string, maxLen: number = 200): string {
  if (!txt) return '';
  return txt.length > maxLen ? txt.slice(0, maxLen) + '…' : txt;
}

export function summarizeForDisplay(obj: any): string {
  if (typeof obj === 'string') return obj;
  if (!obj) return '';
  if (typeof obj !== 'object') return String(obj);
  try {
    const str = JSON.stringify(obj);
    return str.length > 120 ? str.slice(0, 120) + '…' : str;
  } catch (e) {
    return String(obj);
  }
}

/* Markdown to HTML (basic conversion) */
export function mdToHtml(markdown: string): string {
  if (!markdown) return '';
  let html = markdown
    .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*?)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.*?)__/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  if (!html.includes('<p>')) {
    html = '<p>' + html + '</p>';
  }

  return html;
}

/* Scroll helper */
export function scrollMessages() {
  const container = document.querySelector('.messages');
  if (container) {
    setTimeout(() => {
      container.scrollTop = container.scrollHeight;
    }, 0);
  }
}

/* Render helper (for when render() is called globally) */
export function render() {
  // This will be replaced by the main ui.ts render function
}
