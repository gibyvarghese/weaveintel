/** Semantic memory, entity memory, website credentials, and SSO linked account row types. */

export interface SemanticMemoryRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  tenant_id: string | null;
  content: string;
  memory_type: string;         // 'semantic' | 'user_fact' | 'preference' | 'summary'
  source: string;              // 'user' | 'assistant'
  embedding: string | null;    // JSON-serialised number[] for cosine similarity search
  created_at: string;
  updated_at: string;
}

export interface EntityMemoryRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  tenant_id: string | null;
  entity_name: string;
  entity_type: string;   // 'person' | 'location' | 'organization' | 'preference' | 'topic' | 'general'
  facts: string;         // JSON object of key→value facts
  confidence: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryExtractionEventRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  tenant_id: string | null;
  self_disclosure: number;
  regex_entities_count: number;
  llm_entities_count: number;
  merged_entities_count: number;
  events: string | null;
  created_at: string;
}

export interface WebsiteCredentialRow {
  id: string;
  user_id: string;
  site_name: string;
  site_url_pattern: string;
  auth_method: string;           // form_fill | cookie | header | oauth
  credentials_encrypted: string; // AES-256-GCM encrypted JSON blob
  encryption_iv: string;
  last_used_at: string | null;
  status: string;                // active | expired | needs_reauth
  created_at: string;
  updated_at: string;
}

export interface SSOLinkedAccountRow {
  id: string;
  user_id: string;
  identity_provider: string;     // google | github | microsoft | apple | facebook
  email: string | null;
  session_encrypted: string;     // AES-256-GCM encrypted SSOPassThroughAuth JSON
  encryption_iv: string;
  status: string;                // active | expired | needs_reauth
  linked_at: string;
  updated_at: string;
}
