// Type definitions for the geneWeave UI

export interface User {
  id?: string;
  name?: string;
  email?: string;
}

export interface Chat {
  id: string;
  title: string;
  created_at?: string;
  updated_at?: string;
}

export interface Message {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  created_at?: string;
  tokens_used?: number;
  cost?: number;
  latency_ms?: number;
  metadata?: string;
  attachments?: Attachment[];
  steps?: Step[];
  mode?: string;
  evalResult?: any;
  cognitive?: any;
  redaction?: any;
  guardrail?: any;
  activeSkills?: Skill[];
  enabledTools?: string[];
  skillTools?: string[];
  skillPromptApplied?: boolean;
  processState?: string;
  processExpanded?: boolean;
  processUi?: any;
  usage?: any;
  screenshots?: Screenshot[];
}

export interface Attachment {
  name?: string;
  mimeType?: string;
  size?: number;
  dataBase64?: string;
  transcript?: string;
}

export interface Step {
  type?: string;
  kind?: string;
  text?: string;
  content?: string;
  name?: string;
  toolName?: string;
  worker?: string;
  input?: any;
  result?: any;
  toolCall?: any;
  delegation?: any;
  durationMs?: number;
}

export interface Skill {
  name?: string;
  id?: string;
  score?: number;
  category?: string;
  tools?: string[];
}

export interface Screenshot {
  base64: string;
  format?: string;
}

export interface ChartSpec {
  type: 'bar' | 'line';
  title: string;
  labels: string[];
  values: number[];
  unit?: string;
}

export interface TableData {
  headers: string[];
  rows: string[][];
}

export interface Model {
  id: string;
  provider: string;
  name?: string;
}

export interface ChatSettings {
  mode?: string;
  systemPrompt?: string;
  timezone?: string;
  enabledTools?: string[];
  redactionEnabled?: boolean;
  redactionPatterns?: string[];
  workers?: string[];
}
