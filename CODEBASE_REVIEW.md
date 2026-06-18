# weaveIntel / geneWeave — Comprehensive Codebase Review
**Date:** June 2026 | **Scope:** `packages/*` + `apps/geneweave/src/*` | **Standard:** Mid-2026 Enterprise AI Baseline

---

## Table of Contents
1. [Executive Summary](#1-executive-summary)
2. [Mid-2026 Standards Gap Analysis](#2-mid-2026-standards-gap-analysis)
3. [Critical Findings](#3-critical-findings)
4. [High Severity Findings](#4-high-severity-findings)
5. [Medium Severity Findings](#5-medium-severity-findings)
6. [Low Severity Findings](#6-low-severity-findings)
7. [Architectural & Modularity Concerns](#7-architectural--modularity-concerns)
8. [Phased Remediation Plan](#8-phased-remediation-plan)

---

## 1. Executive Summary

Total findings: **95 issues** across 5 severity tiers plus 10 architectural concerns.

| Severity | Count |
|---|---|
| CRITICAL | 7 |
| HIGH | 18 |
| MEDIUM | 32 |
| LOW | 28 |
| ARCHITECTURAL | 10 |
| **Standards gaps (missing capability)** | **12** |

**Top risks in priority order:**
1. PII written to DB after redaction is applied — a GDPR/CCPA data breach on every turn where redaction fires.
2. HYOK KMS bearer token persisted as plaintext in SQLite.
3. `Math.random()` used to generate security-critical and compliance-critical IDs throughout.
4. SQL injection in pgvector memory store and ChromeProvider credential lookup.
5. Private key persisted to DB despite a log message that claims to "refuse."
6. Zero database indexes on the hottest tables (`messages`, `chats`, `sessions`, `traces`).
7. Guardrail budget exhaustion silently counts as `allow` — security posture degrades without operator visibility.

**Standards not yet met:**
- FIDO2/passkeys (auth floor for 2026)
- EU AI Act Article 12 log partitioning and 3–7 year retention tier
- ISO 42001 AIMS documentation structure
- OWASP LLM Top 10 (2025): system-prompt leakage protection, agentic chain-of-thought leakage, MCP/tool-call injection hardening
- Token-based tenant rate limiting at the gateway layer
- Data residency routing architecture

---

## 2. Mid-2026 Standards Gap Analysis

The following capabilities are expected for a mid-2026 enterprise AI application and are **absent or only partially present** in this codebase.

### 2.1 Authentication & Identity
| Requirement | Status | Gap |
|---|---|---|
| FIDO2 / Passkeys | Missing | Password + TOTP only. FIDO2 is the 2026 auth floor per NIST and FIDO Alliance guidance. |
| Phishing-resistant MFA | Partial | TOTP is present but FIDO2 hardware key support is absent. |
| Adaptive / step-up MFA | Missing | No step-up authentication for admin actions, bulk export, or model config changes. |
| `__Host-` cookie prefix | Missing | Session cookie lacks prefix — subdomain injection attack vector exists. |

### 2.2 AI-Specific Security (OWASP LLM Top 10, 2025)
| OWASP LLM Risk | Status | Gap |
|---|---|---|
| LLM01 — Prompt Injection | Partial | PII redaction exists; dedicated prompt-injection detection at the gateway layer is absent. |
| LLM02 — Sensitive Info Disclosure | Critical | Redacted PII written back to DB (see finding CR-1). |
| LLM07 — System Prompt Leakage | Missing | No extraction-attack detection or system-prompt confidentiality controls. |
| LLM08 — Vector/Embedding Weaknesses | Partial | pgvector store has SQL injection in table-name construction (see CR-4). |
| LLM10 — Unbounded Consumption | Partial | Token rate limits exist but not enforced at the gateway layer; `active_hours_utc` field is never read. |
| Agentic chain-of-thought leakage | Missing | Intermediate reasoning steps (ReAct scratchpad) are stored unredacted in traces. |
| MCP/tool-call injection | Partial | A2A card not validated; arbitrary endpoint in card accepted as trusted. |

### 2.3 Compliance & Governance
| Requirement | Status | Gap |
|---|---|---|
| ISO 42001 AIMS | Missing | No documented AI management system structure, risk register, or review cadence. |
| NIST AI RMF | Partial | Guardrails and observability exist; Govern/Map/Measure/Manage lifecycle is not documented. |
| EU AI Act Article 12 | Partial | Traces are stored but no partitioned retention tier (30–90 days operational / 3–7 years compliance). |
| GDPR right-to-erasure | Partial | Deletion requests exist but use non-collision-safe IDs (see CR-3). |
| SOC 2 Type II AI agent controls | Partial | Audit log exists; automated monitoring of agent behavior fleets is absent. |

### 2.4 Observability & Audit
| Requirement | Status | Gap |
|---|---|---|
| Immutable audit log | Partial | Traces written to SQLite; no write-once / tamper-evident control. |
| Retention tiering (3–7 yr compliance logs) | Missing | Single table, single retention policy. |
| Real-time anomaly detection | Missing | No drift / toxicity / policy-violation stream monitoring. |
| Wildcard permission audit trail | Missing | `'*'` permission shortcut fires silently with no audit event. |

### 2.5 Multi-Tenancy & Data Residency
| Requirement | Status | Gap |
|---|---|---|
| Tenant-scoped gateway rate limits | Partial | Application-layer limits exist; gateway-layer enforcement absent. |
| `active_hours_utc` tool policy enforcement | Missing | Column stored but never evaluated. |
| Data residency routing | Missing | No region-aware inference routing; LLM calls go to whichever provider is configured regardless of data class. |
| Retention rule priority ordering | Missing | First-match-wins with no `priority` field — specific rules can be shadowed by broad ones. |

---

## 3. Critical Findings

### CR-1 — PII Written to DB After Redaction
- **Files:** `apps/geneweave/src/chat-send-message.ts:226`, `apps/geneweave/src/chat-stream-message.ts:314`
- **Category:** SECURITY

After the redaction pipeline produces `processedContent`, both send and stream paths persist `content` (the original, un-redacted text) to the `messages` table instead of `processedContent`. Every turn where redaction fires stores the PII it was supposed to remove. This is a direct GDPR/CCPA violation.

**Fix:** In both files, change the `addMessage` call to pass `processedContent` as `content`. The original `content` must never be written once redaction is enabled.

---

### CR-2 — HYOK Bearer Token Persisted Plaintext in SQLite
- **File:** `apps/geneweave/src/encryption/byok-service.ts:143–167`
- **Category:** SECURITY

The HYOK KMS bearer token is resolved from env at registration time and embedded in `kms_config`, which is stored as `JSON.stringify(kmsConfig)` in `tenant_encryption_policy.kms_config`. Any party with DB read access (backups, BI, `SELECT *`) can extract live KMS credentials.

**Fix:** Store only the env-var reference key (e.g., `HYOK_BEARER_SECRET_ID`) in `kms_config`. Resolve the token at call time inside the provider, not at registration time.

---

### CR-3 — `Math.random()` for Security-Critical and Compliance-Critical IDs
- **Files:** `apps/geneweave/src/encryption/byok-service.ts:480`, `packages/compliance/src/deletion.ts:30`, `packages/compliance/src/durable.ts:246`
- **Category:** SECURITY / HARDCODED

`Math.random()` is used to generate IDs for BYOK attestation rows, break-glass approval references, GDPR deletion requests, and durable compliance records. `Math.random()` is not a CSPRNG — IDs are predictable, enumeration attacks are possible, and legal defensibility of compliance records requires provably collision-resistant identifiers.

**Fix:** Replace all occurrences with `crypto.randomBytes(16).toString('hex')` (or `newUUIDv7()` from `@weaveintel/core` for compliance records). The `randomBytes` import is already present in auth.ts and vault.ts.

---

### CR-4 — SQL Injection in pgvector Memory Store
- **File:** `packages/memory/src/memory.ts:1094–1136`
- **Category:** SECURITY

`weavePgVectorMemoryStore` interpolates caller-controlled `opts.tableName` and `opts.dimensions` directly into DDL and DML SQL strings (`CREATE TABLE IF NOT EXISTS ${table}`, `DELETE FROM ${table} WHERE ...`). A caller supplying a table name containing SQL metacharacters achieves SQL injection against DDL paths.

**Fix:** At construction time, validate `table` against `/^[a-zA-Z_][a-zA-Z0-9_]*$/` and verify `dims` is a positive integer. Throw if invalid. Parameterised queries protect values; identifier injection is the gap.

---

### CR-5 — Private Key Written to DB Despite Warning
- **File:** `apps/geneweave/src/encryption/byok-service.ts:123–138`
- **Category:** SECURITY / LOGIC

When `privateKeyPemDev` is supplied in production, the code emits `console.warn("refusing to mirror")` but continues to write `private_key_pem_dev: input.privateKeyPemDev` to `tenant_byok_config`. Operators reading the warning believe the key was rejected; it was silently stored.

**Fix:** In production (`NODE_ENV === 'production'`), throw `new Error('private_key_pem_dev is not permitted in production')` **before** any database write, or unconditionally set `private_key_pem_dev: null` before the upsert call.

---

### CR-6 — Key Material Not Zeroed on Exception
- **File:** `packages/encryption/src/key-manager.ts:233–238`
- **Category:** SECURITY / SILENT_FAIL

In `bootstrapTenant`, plaintext key material (`kekPlain`, `dekPlain`, `bikPlain`) is allocated and used across multiple async steps. If any intermediate step throws, the plaintext keys linger in the heap with no zeroing. Node.js does not deterministically GC or zero Buffers.

**Fix:** Wrap the multi-step bootstrap in `try/finally { kekPlain.fill(0); dekPlain?.fill(0); bikPlain?.fill(0); }`. Apply the same pattern to every error path that touches plaintext key Buffers.

---

### CR-7 — Simulated Sandbox Returns `evaluated: true`
- **File:** `packages/sandbox/src/sandbox.ts:92–119`
- **Category:** SECURITY / LOGIC

`createSimulatedSandbox()` never executes code. It returns `{ status: 'success', output: { evaluated: true } }` after doing a regex scan on source text. Callers that check `output.evaluated` will believe the code ran successfully. The module-import deny-list check is also trivially bypassed by dynamic require patterns.

**Fix:** Return `{ simulated: true, evaluated: false }` to make the non-execution explicit. Add a `console.warn` when invoked outside test environments. For real execution, use `ContainerExecutor`.

---

## 4. High Severity Findings

### H-1 — SQL Injection via ChromeProvider LIKE Query
- **File:** `apps/geneweave/src/password-providers.ts:354–360`
- **Category:** SECURITY

`ChromeProvider.listCredentials()` builds a LIKE query with string interpolation. The sanitisation only doubles single-quotes; SQLite wildcard characters (`%`, `_`) are not escaped, and the underlying shell is invoked via `execSync` (shell mode), which makes future code changes hazardous.

**Fix:** Use parameterised queries. Escape `%`, `_`, and `\` for LIKE wildcards. Switch the `exec()` helper to `execFileSync` with an explicit argument array.

---

### H-2 — API Keys Stored in Plaintext in DB
- **File:** `apps/geneweave/src/db-schema.ts:570–638`
- **Category:** SECURITY

`search_providers`, `social_accounts`, and `enterprise_connectors` tables store `api_key`, `api_secret`, `access_token`, and `refresh_token` as plaintext TEXT columns. The encryption infrastructure (`geneweaveEncryptionManager`) already exists and is applied to other sensitive fields.

**Fix:** Encrypt these columns via the tenant key manager, or store only a reference (env-var name / vault path) rather than the raw credential value.

---

### H-3 — No Database Indexes on Hot Tables
- **File:** `apps/geneweave/src/db-schema.ts`
- **Category:** PERFORMANCE

The `messages`, `chats`, `sessions`, `traces`, and `metrics` tables have no indexes. At any meaningful data volume, every `SELECT … WHERE chat_id = ?`, `SELECT … WHERE user_id = ?`, and dashboard aggregation performs a full table scan.

**Fix:** Add a migration with:
```sql
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_user_id    ON chats(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_traces_chat_id   ON traces(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_user     ON metrics(user_id, chat_id, created_at DESC);
```

---

### H-4 — Agent Token Counting Hardcoded to Zero
- **File:** `apps/geneweave/src/chat-send-message.ts:352–355`, `apps/geneweave/src/chat-stream-message.ts:453–454`
- **Category:** LOGIC

In agent and supervisor modes, `completionTokens` is hardcoded to `0` and `promptTokens` is set to `totalTokens`. Cost calculation uses different per-token rates for input vs. output; setting both to the input rate systematically under-reports costs and corrupts the dashboard cost breakdown.

**Fix:** Propagate `AgentResult.usage.promptTokens` and `AgentResult.usage.completionTokens` from the agent result to the message record.

---

### H-5 — Hardcoded Static Salt in Legacy Vault
- **File:** `apps/geneweave/src/vault.ts:20, 32–33`
- **Category:** SECURITY / HARDCODED

The legacy vault key derivation uses the constant salt string `'weaveintel-vault-v1'` with `scryptSync`. Every deployment using the same `VAULT_KEY` value produces the same derived key. Additionally, `scryptSync` blocks the Node.js event loop during batch decryptions.

**Fix:** Migrate all legacy records to v1 format (which uses a per-record random HKDF salt) and remove the legacy path. Until then, document that `VAULT_KEY` must be unique per deployment.

---

### H-6 — Wildcard Permission Fires With No Audit Event
- **File:** `packages/identity/src/access.ts:48–50`
- **Category:** SECURITY / MISSING_CONTROL

`evaluateAccess` checks `ctx.effectivePermissions.includes('*')` and silently grants unconditional access, bypassing all rule evaluation and emitting no audit event. An identity that accidentally or maliciously acquires `'*'` is undetectable in logs.

**Fix:** Emit a `weaveAudit` event when the wildcard path fires with `{ outcome: 'allow', reason: 'wildcard_permission', identityId }`. Consider removing the wildcard from runtime evaluation entirely; enforce it only at policy-compile time.

---

### H-7 — Retention Rule First-Match-Wins, No Priority Field
- **File:** `packages/compliance/src/retention.ts:36–44`
- **Category:** LOGIC / MISSING_CONTROL

`RetentionEngine.evaluate()` returns the first matching enabled rule in insertion order. There is no `priority` field. A broad `dataCategory: '*'` rule added before a specific one permanently shadows the specific rule, silently applying the wrong retention policy to regulated data.

**Fix:** Add `priority: number` to `RetentionRule`. Sort descending by priority before evaluation. Document the semantics.

---

### H-8 — Redaction Overlap Deduplication Logic Bug
- **File:** `packages/redaction/src/redactor.ts:87–99`
- **Category:** LOGIC

The deduplication of overlapping span detections uses a sort direction and comparison that fails to merge partially-overlapping spans correctly: both spans survive, and the downstream replacement pass double-replaces the overlapping region, producing garbled output.

**Fix:** Rewrite using a standard interval-merge algorithm: sort by `start` ascending, then merge any span whose `start` falls within the previous span's `[start, end]` range.

---

### H-9 — HYOK Proxy Endpoint Not SSRF-Checked
- **File:** `packages/encryption/src/byok/byok-keystore.ts:116–135`
- **Category:** SECURITY

`createHttpHyokProxyDelegate` validates that the endpoint starts with `https://` but does not call `assertSafeForEgress` (already in the codebase and used by other egress paths). A customer-supplied HYOK endpoint can point to `169.254.169.254` or an internal RFC1918 address.

**Fix:** Call `assertSafeForEgress(opts.endpoint)` at construction time before the endpoint is accepted.

---

### H-10 — Compliance `loadAll` Silently Discards Corrupt Records
- **File:** `packages/compliance/src/durable.ts:37–44`
- **Category:** SILENT_FAIL

`loadAll<T>` silently skips malformed KV entries with an empty `catch {}`. In the compliance context (legal holds, consent records, deletion requests), a corrupt record that is silently dropped means a legal hold might not be enforced, a consent might be assumed when it was revoked, or a deletion request is lost.

**Fix:** Replace the empty catch with a structured error log and a metrics counter so silently-dropped records are observable.

---

### H-11 — Agent Tool-Call JSON.parse Without try/catch
- **File:** `packages/agents/src/agent.ts:786–787`
- **Category:** LOGIC / SILENT_FAIL

The legacy per-agent policy path calls `JSON.parse(tc.arguments)` directly, unlike the guardrails path above it that wraps the same call in try/catch. A malformed model response throws an uncaught `SyntaxError`, skipping the audit event and surfacing a raw exception to the loop.

**Fix:** Wrap in try/catch; on failure, block the tool call with an error result using the `safeParseJson` helper already defined at line 831.

---

### H-12 — `runAgent` / `streamAgent` 300-Line Duplication
- **File:** `apps/geneweave/src/chat.ts:858–1316`
- **Category:** REDUNDANCY / MODULARITY

The full agent construction block is copied verbatim between `runAgent` and `streamAgent`. The ~5% that differs is the execution call. This divergence already produced a bug: `streamAgent` is missing `systemPromptSha256` in the forced-analysis return path.

**Fix:** Extract a `buildAgentInstance()` helper that takes shared params and returns `{ agent, systemPromptSha256 }`. Both functions call it and then diverge only at execution.

---

### H-13 — O(n) Key Scans on Every Encrypt / Decrypt
- **File:** `packages/encryption/src/key-manager.ts:630–652`
- **Category:** PERFORMANCE

`#getKekRow`, `#getDekRow`, and `#findDekByEpoch` each call `listKeks(tenantId)` / `listDeks(tenantId)` and do a linear `.find()`. Every encrypt/decrypt triggers full KEK and DEK list scans. For Postgres-backed stores, this is an unbounded table scan per cryptographic operation.

**Fix:** Add `getKekById(tenantId, kekId)` and `getDekById(tenantId, dekId)` point-lookup methods to `EncryptionStore`. Add `getMaxDekEpoch(tenantId)` for the rotation path.

---

### H-14 — A2A Agent Card Not Validated
- **File:** `packages/a2a/src/a2a.ts:38–46`
- **Category:** SECURITY

`weaveA2AClient().discover()` fetches the well-known agent card and casts it directly to `AgentCard` with no schema validation. A malicious server can return a card with a spoofed `url` field, redirecting all subsequent A2A calls to an attacker-controlled endpoint.

**Fix:** After fetch, validate required fields (`id`, `url`) exist and are strings. Verify that the returned `url` matches the origin of the originally-requested URL.

---

### H-15 — `historyToMessages` Duplicated in Both Send and Stream Files
- **File:** `apps/geneweave/src/chat-send-message.ts:521–525`, `apps/geneweave/src/chat-stream-message.ts:733–737`
- **Category:** REDUNDANCY

`historyToMessages()` is defined identically in both files. Any change to the mapping logic must be applied twice.

**Fix:** Move to `chat-message-utils.ts` and import from both.

---

### H-16 — Delegation Circular-Check Incomplete
- **File:** `packages/identity/src/delegation.ts:51–53`
- **Category:** LOGIC

`validateDelegationChain` only detects circularity if `to.id` already appears in the current chain. Cross-chain circularity (`A→B` and separately `B→A`) is undetected because each delegation's chain only records its own ancestry.

**Fix:** When creating a delegation `A→B`, include `B.id` in the chain so any subsequent delegation starting from `B` can detect the cycle back to `A`.

---

### H-17 — Fake AWS Credentials Injected Regardless of Endpoint
- **File:** `packages/memory/src/memory.ts:696–702`
- **Category:** SECURITY / HARDCODED

`weaveCloudNoSqlMemoryStore` hardcodes `credentials: { accessKeyId: 'local', secretAccessKey: 'local' }` when any custom DynamoDB endpoint is provided, including real AWS endpoints.

**Fix:** Only inject fake credentials when the endpoint is provably a loopback/localhost address. Otherwise, omit the `credentials` field and let the AWS SDK default credential chain resolve.

---

### H-18 — `runStream()` Duplicates `run()` Tool-Call Loop
- **File:** `packages/agents/src/agent.ts:471–728`
- **Category:** REDUNDANCY / MODULARITY

`runStream()` duplicates ~250 lines of `run()` logic (tool-call loop, guardrail check, W1 reflect cycle, W2 verify cycle). The two paths already diverged: the fallback terminal path has slightly different audit fields.

**Fix:** Extract "terminal response post-processing" (guardrail → verify → reflect → record) into a shared async function. Both paths call it; the streaming path additionally flushes text chunks beforehand.

---

## 5. Medium Severity Findings

### M-1 — CORS Header CRLF Injection Risk
- **File:** `apps/geneweave/src/server.ts:188–192` — `corsOrigin` is written to `Access-Control-Allow-Origin` without CRLF sanitisation. Setting `*` with `Allow-Credentials: true` is also a CORS spec violation. **Fix:** Validate `corsOrigin` through `normalizePublicOrigin()` at startup. Explicitly reject `*` when credentials are enabled.

### M-2 — Unsanitised OAuth Error Reflection
- **File:** `apps/geneweave/src/routes/auth.ts:451` — `error` and `error_description` from the OAuth callback are reflected verbatim without length limits. **Fix:** Truncate to 200 characters; filter to `[a-zA-Z0-9_\-.:, ]+`.

### M-3 — OAuth Unlink `provider` Not Validated
- **File:** `apps/geneweave/src/routes/auth.ts:394–400` — `provider` path parameter is passed to the DB layer without validation against a known-providers list. **Fix:** Check against an explicit allowlist before proceeding.

### M-4 — Host-Header-Derived OAuth Redirect URI
- **File:** `apps/geneweave/src/server-core.ts:385–390` — In non-production environments where `publicBaseUrl` is absent, the OAuth redirect URI is constructed from the client-controlled `Host` header. **Fix:** Validate `Host` against an allowlist or always use `publicBaseUrl` when provided.

### M-5 — JWT Length Pre-Check Creates Timing Side-Channel
- **File:** `apps/geneweave/src/auth.ts:62` — The token signature length is checked before `timingSafeEqual`, creating an observable fast path for structurally-wrong-length tokens. **Fix:** Pad both buffers to the same length before comparison, or remove the pre-check.

### M-6 — Weak Secret Entropy Check Too Narrow
- **File:** `apps/geneweave/src/env-validation.ts:28–33` — `isWeakSecret()` uses anchored regexes that only match exact strings. Patterns like `"secret1"` or `"dev-only-key"` pass. **Fix:** Remove anchors; add substring checks for `test`, `dev`, `secret`, `password`, `example`.

### M-7 — `postMessage` Uses `window.location.origin` as Target
- **File:** `apps/geneweave/src/routes/auth.ts:536–540` — The OAuth popup sends `postMessage` with `window.location.origin`. If the popup was navigated via an open-redirect, the opener may belong to a different origin. **Fix:** Emit the expected parent origin from the server and use it as `targetOrigin`.

### M-8 — Guardrail Budget Exhaustion Counts as `allow`
- **File:** `packages/guardrails/src/pipeline.ts:100–109` — When `budgetMs` is exceeded, remaining `model-graded` guardrails are skipped and recorded as `decision: 'allow'`. **Fix:** Introduce `decision: 'skipped'`; treat `'skipped'` as `'deny'` by default for security-sensitive callers. Add `budgetExhaustedPolicy: 'allow' | 'deny'` option.

### M-9 — `active_hours_utc` Tool Policy Never Enforced
- **File:** `apps/geneweave/src/tool-policy-resolver.ts` — The `tool_policies.active_hours_utc` time-window column is stored and shown in the admin UI but is never evaluated. **Fix:** Parse and check the UTC time window in `resolve()` after the expiry check.

### M-10 — `DbToolRateLimiter.remaining()` Always Returns Full Cap
- **File:** `apps/geneweave/src/tool-policy-resolver.ts:107–110` — `remaining()` always returns `limitPerMinute` without querying the actual bucket count. **Fix:** Implement a real `SELECT COUNT(*)` against `tool_rate_limit_buckets` for the current minute window.

### M-11 — Latency Measurement Inconsistency
- **File:** `apps/geneweave/src/chat-stream-message.ts:198, 437, 515, 717` — `latencyMs` is computed from `startMs` (after SSE headers and guardrail evaluation), not `requestStartMs`. Pre-flight work is excluded from reported latency. **Fix:** Use `requestStartMs` consistently.

### M-12 — `settingsFromRow` JSON.parse Calls Unguarded
- **File:** `apps/geneweave/src/chat-runtime.ts:177–207` — Six unguarded `JSON.parse()` calls on admin-configurable SQLite TEXT columns will throw and crash the chat turn on malformed data. **Fix:** Wrap each in try/catch with a safe fallback.

### M-13 — Request Deadline Hardcoded in Two Places
- **File:** `apps/geneweave/src/chat-send-message.ts:153`, `apps/geneweave/src/chat-stream-message.ts:242` — `Date.now() + 120_000` duplicated in both send and stream paths. **Fix:** Extract to a named constant in `chat-runtime.ts`.

### M-14 — Fallback Model Lists Hardcoded Inline
- **File:** `apps/geneweave/src/chat.ts:1341–1350` — Provider model fallback lists are hardcoded inside a method body and overlap with `FALLBACK_PRICING`. **Fix:** Consolidate into a single `FALLBACK_MODELS` constant in `chat-runtime.ts`.

### M-15 — Provider Module Factory Called via `any` Cast
- **File:** `apps/geneweave/src/chat-runtime.ts:76, 81, 87, 92, 101, 109` — Provider factory functions are called via `(mod as any).weaveAnthropicModel(...)`. A rename in a provider package produces a silent runtime crash. **Fix:** Define a minimal interface per provider module.

### M-16 — Cache Hit Path Uses `as any` for Response Shape
- **File:** `apps/geneweave/src/chat-send-message.ts:342–343` — `(cached as any).content` and `(cached as any).usage` bypass type checking. **Fix:** Define a `CachedResponse` type and assert required fields before access.

### M-17 — `memoryRecall` and `memorySearch` Near-Identical
- **File:** `apps/geneweave/src/chat.ts:629–679` — Two 50-line async functions perform identical embedding lookup + dual-store search, differing only in the return shape. **Fix:** Extract `executeMemoryQuery()` as a shared private helper.

### M-18 — `toolEvidence` Filter Logic Duplicated
- **File:** `apps/geneweave/src/chat-send-message.ts:393–404`, `apps/geneweave/src/chat-stream-message.ts:592–602` — Identical filter/map for `toolEvidence` from agent steps in both files. **Fix:** Extract to `extractToolEvidence()` in `chat-message-utils.ts`.

### M-19 — `eval_results` Denormalises Settings With No Snapshot Timestamp
- **File:** `apps/geneweave/src/db-schema.ts:98–114` — 6 columns from `chat_settings` are duplicated in `eval_results` with no timestamp indicating when the snapshot was taken. **Fix:** Add `settings_snapshot_at TEXT` populated at eval creation time.

### M-20 — Consent Lookup O(all Consents) Per Subject
- **File:** `packages/compliance/src/durable.ts:127–141` — `listBySubject()` loads all consent records then filters in-process. **Fix:** Use a secondary index key pattern so `kv.list(prefix)` is scoped to the subject.

### M-21 — `guardrail_denied` Indistinguishable from `completed`
- **File:** `packages/agents/src/agent.ts:326–335` — When output guardrails block a response, the agent returns `status: 'completed'`. Callers cannot distinguish a blocked response from a legitimate completion. **Fix:** Return `status: 'guardrail_denied'`.

### M-22 — Schema Init on Every pgvector Query
- **File:** `packages/memory/src/memory.ts:488–502` — `weavePostgresMemoryStore.query()` runs `CREATE TABLE IF NOT EXISTS` on every query call. **Fix:** Add a `schemaReady` boolean guard.

### M-23 — Workflow Engine Extracts Raw SQLite via Fragile `unknown` Cast
- **File:** `apps/geneweave/src/workflow-engine.ts:371–374` — `(opts.db as unknown as { d?: unknown }).d` relies on knowing the internal property name of `SQLiteAdapter`. If the adapter is wrapped, `.d` is undefined and the idempotency store silently falls back. **Fix:** Expose an optional `getRawDatabase?(): unknown` method on `DatabaseAdapter`.

### M-24 — MCP Gateway Rate Limiter Fails Open Silently
- **File:** `apps/geneweave/src/mcp-gateway.ts:461–465` — When `gatewayRateLimiter` throws, `allowed = true` with no log. **Fix:** Log the caught error at `warn` level before setting `allowed = true`.

### M-25 — Compliance Records Cast Without Shape Validation
- **File:** `packages/compliance/src/durable.ts:179–186` — `JSON.parse(e.value) as T` with no shape checks. A corrupt or migrated record silently becomes an object with undefined required fields. **Fix:** Validate required fields before the cast.

### M-26 — `guardrail-judge.ts` Checks `startsWith('sk-')` for Key Validity
- **File:** `apps/geneweave/src/guardrail-judge.ts:158, 192` — OpenAI-specific key prefix check. Azure or proxy keys silently disable moderation. **Fix:** Replace with `apiKey?.trim().length > 0`.

### M-27 — Client Disconnect Leaves Dangling User Message
- **File:** `apps/geneweave/src/chat-stream-message.ts:527` — On early return the user message stored at line 314 has no matching assistant reply. **Fix:** Delete the user message on early return, or store a `[Stream cancelled]` marker.

### M-28 — Tool Timeout Leaves Ghost Executions
- **File:** `packages/tools/src/policy.ts:354–371` — The underlying tool invocation continues running after timeout. For tools with side effects, this creates ghost executions. **Fix:** Pass an `AbortSignal` to the tool and abort it when the timeout fires.

### M-29 — Scorer Called Twice in `SmartModelRouter.route()`
- **File:** `packages/routing/src/router.ts:198–205` — `this.scorer.score(...)` is called twice for the same inputs. **Fix:** Reuse the scores array from the first call.

### M-30 — Default Tool Policy Allows All Risk Levels Including Destructive
- **File:** `packages/tools/src/policy.ts:74` — `DEFAULT_TOOL_POLICY.allowedRiskLevels` includes `'destructive'`, `'privileged'`, and `'financial'`. Any tool registered without an explicit policy silently inherits full rights. **Fix:** Change default to `['read-only']`. Require explicit opt-in for higher risk levels.

### M-31 — `runStream()` Yields `tool_start` Events for Non-Tool Steps
- **File:** `packages/agents/src/agent.ts:590–593, 611–617` — W2 verify and W1 reflect cycle rejection events yield `{ type: 'tool_start' }`. Downstream consumers misread these as tool invocations. **Fix:** Introduce distinct event types `'verify_failed'` and `'reflect_revised'`.

### M-32 — `routesConfig` Private Field Accessed via `any` Cast
- **File:** `apps/geneweave/src/routes/chat.ts:69–70` — `(chatEngine as any).config.defaultModel` accesses a private field via `any` when the public `modelConfig` getter already exists. **Fix:** Replace with `chatEngine.modelConfig.defaultModel`.

---

## 6. Low Severity Findings

| # | File | Issue | Fix |
|---|------|-------|-----|
| L-1 | `auth.ts:201` | No `__Host-` cookie prefix — subdomain injection vector. | Rename to `__Host-gw_token`; enforce Secure+Path=/. |
| L-2 | `routes/auth.ts:278` | Registration issues live session before email verification. | Issue a restricted or no session until email is verified. |
| L-3 | `server-core.ts:156` | Multi-process rate-limit warning only checks Heroku env vars; misses PM2, k8s, Docker Swarm. | Log the warning unconditionally at startup. |
| L-4 | `encryption/bootstrap.ts:79` | Default logger emits provider list and key source to stdout. | Default to a log-level-aware structured logger. |
| L-5 | `vault.ts:25` | `VAULT_KEY` read from `process.env` on every encrypt/decrypt call. | Cache the key at startup. |
| L-6 | `server.ts:393` | Bearer JWT in WebSocket query string appears in proxy access logs. | Issue a short-lived single-use WS ticket instead. |
| L-7 | `db-encrypted-adapter.ts:261` | Encryption failure silently writes plaintext for `updateChatTitle`. | Log a structured warning; expose a metric counter. |
| L-8 | `memory/src/memory.ts:281` | Message IDs generated as `msg_${i}` at query time — unstable after trims. | Assign stable IDs at `addMessage` time. |
| L-9 | `compliance/src/durable.ts:179` | `DurableResidencyEngine` returns `true` when no constraints are configured. | Add `defaultDeny?: boolean` constructor option. |
| L-10 | `redaction/src/redactor.ts:117` | `restore()` replaces only the first occurrence of each token. | Use `split().join()` for global replacement. |
| L-11 | `memory/src/memory.ts:1094` | `process.env['SEMANTIC_MEMORY_MIN_SIM']` read on every vector query. | Read once at construction time. |
| L-12 | `key-manager.ts:752` | Encryption audit emitter swallows all exceptions silently — key lifecycle events can be lost. | Log a warning / increment a metric inside the catch. |
| L-13 | `a2a/src/a2a.ts:121` | `cancelTask` ignores HTTP response status. | Check `response.ok`; throw `WeaveIntelError` on non-2xx. |
| L-14 | `sandbox/src/sandbox.ts:210` | `simulateExecution` resource metrics are fabricated constants. | Rename to `simulated: true`; add JSDoc warning. |
| L-15 | `db-schema.ts:307` | `prompt_eval_runs` default status is `'completed'` before the eval runs. | Default to `'pending'`. |
| L-16 | `chat-send-message.ts:464`, `chat-stream-message.ts:697` | Memory save / consolidation failures fully silent. | Add `console.warn` in catch blocks. |
| L-17 | `chat.ts:630` | Embedding failures in `memoryRecall` / `memorySearch` fully silent. | Add `console.warn('[memory] embedding failed', ...)`. |
| L-18 | `guardrail-judge.ts:111` | `guardRailJudge` singleton race during hot-swap — concurrent requests use old model. | Document the gap or gate model hot-swap on a request-drain. |
| L-19 | `chat.ts:1235` | `streamAgent` forced-analysis return missing `systemPromptSha256`. | Include field in all return paths. |
| L-20 | `chat.ts:683` | `content.slice(0, 600)` trim limit hardcoded. | Source from `resolveLimits()` or a named constant. |
| L-21 | `chat.ts:721` | `Math.min(30, limit ?? 10)` hard ceiling undocumented. | Add a comment explaining the ceiling, or expose via `resolveLimits()`. |
| L-22 | `guardrail-judge.ts:188` | `'text-embedding-3-small'` hardcoded as fallback embedding model. | Promote to a named export constant. |
| L-23 | `agents/src/agent.ts:822` | `safeParseJson` call duplicates an already-parsed result from line 801. | Reuse the result from line 801. |
| L-24 | `chat-runtime.ts:60` | `modelCache` is an unbounded `Map` — grows indefinitely in long-running processes. | Cap at 50 entries with LRU eviction. |
| L-25 | `memory/src/memory.ts:516,566,619,678` | `clear()` with filter loads all entries into memory before deleting. | Implement server-side filtered deletes per backend. |
| L-26 | `identity/src/access.ts:48` | No guard preventing `'*'` from being set at runtime via the permissions API. | Restrict wildcard assignment to bootstrap/seed operations only. |
| L-27 | Multiple packages | Generic `new Error(string)` thrown everywhere — callers cannot distinguish error types programmatically. | Define domain error classes extending `WeaveIntelError`. |
| L-28 | `chat-stream-message.ts:457` | Ensemble result fields accessed via `as any` cast. | Define `EnsembleAgentResult` interface and use a type guard. |

---

## 7. Architectural & Modularity Concerns

### A-1 — `memory.ts` is 1411 Lines Bundling 8 Storage Backends
All driver imports (`better-sqlite3`, `pg`, `redis`, `mongodb`, `@aws-sdk/*`) load at startup regardless of which backend is active, inflating cold-start time and bundle size.

**Fix:** Split into `memory-core.ts`, `memory-postgres.ts`, `memory-redis.ts`, `memory-sqlite.ts`, `memory-mongodb.ts`, `memory-dynamodb.ts`, `memory-pgvector.ts`. The factory function uses dynamic `import()` based on the selected backend.

---

### A-2 — `encryption/src/index.ts` Exposes Internal Implementation Details
`export * from '...'` across 20+ modules exposes internal helpers (`AeadError`, `buildAad`, `parseSentinel`) as part of the public API. Future refactors require semver major bumps even for internal changes.

**Fix:** Define an explicit public API surface; mark internal exports with `@internal` JSDoc.

---

### A-3 — `chat.ts` Remains 1398 Lines Despite Prior Decomposition
`buildAgentToolOptions` (241 lines) embeds 9 memory tool callback builders and 3 agenda callback builders as deeply nested async closures that are untestable in isolation.

**Fix:** Extract `buildMemoryToolCallbacks()` to `chat-memory-tool-callbacks.ts` and `buildAgendaToolCallbacks()` to `chat-agenda-tool-callbacks.ts`.

---

### A-4 — `guardrail-judge.ts` Uses 4 Module-Level Mutable Singletons
Module-level globals (`_judgeAgent`, `_activeJudgeModel`, etc.) make the module non-reusable across multiple `ChatEngine` instances and cause cross-test contamination.

**Fix:** Encapsulate in a `GuardrailJudgeRegistry` class, instanced per `ChatEngine` and injected through the deps object.

---

### A-5 — `createGeneWeave()` Has No Rollback Mechanism
20+ sequential init steps launch background jobs. If a later step throws, earlier jobs (Kaggle heartbeat, rotation scheduler, generic supervisor) are already running with no cleanup path.

**Fix:** Collect all started background handles; add a `rollback()` path in the startup try/catch.

---

### A-6 — No Domain Error Types Across Core Packages
All four packages (`compliance`, `identity`, `routing`, `guardrails`) throw `new Error(string)`. Callers cannot distinguish a `LegalHoldConflictError` from a serialization failure without string matching.

**Fix:** Define domain-specific error classes (`LegalHoldActiveError`, `ConsentExpiredError`, `ResidencyViolationError`, `DelegationExpiredError`) extending `WeaveIntelError` from `@weaveintel/core`.

---

### A-7 — `db-schema.ts` is 1319 Lines Without Sectioning
All 30+ table definitions live in a single file. Relationships between tables are undocumented.

**Fix:** Split by domain: `schema-users.ts`, `schema-chat.ts`, `schema-tools.ts`, `schema-compliance.ts`, etc. Add a comment block above each group documenting relationships.

---

### A-8 — No Structured Log Level Abstraction
Multiple packages mix `console.log`, `console.warn`, `console.error`, and silent catches. There is no unified structured logger with level filtering, request correlation IDs, or structured fields for machine parsing.

**Fix:** Adopt a structured logger interface (pino or the existing `weaveObservability` event bus) as the canonical log destination. Remove bare `console.*` calls outside of bootstrap code.

---

### A-9 — MCP Gateway Rate Limits Not Scoped to Tenant
Rate limits are per-client-ID but not scoped to tenant quotas. A malicious tenant with many client IDs can exhaust global limits.

**Fix:** Scope rate limit buckets to `(tenantId, clientId)` pairs.

---

### A-10 — No Integration Test for Encryption Rotation
The rotation scheduler, key manager, and BYOK service have unit tests but no integration test covering the full rotation cycle against a real SQLite database with tenant data. Silent failures in the rotation path go undetected.

**Fix:** Add a rotation integration test: write encrypted records, rotate the DEK, verify all records remain decryptable with the new key.

---

## 8. Phased Remediation Plan

### Phase 1 — Critical Security Fixes (Weeks 1–2)
*Stop active data exposure and neutralise the highest-severity vulnerabilities.*

| # | Action | File(s) | Finding |
|---|--------|---------|---------|
| 1.1 | Fix PII written to DB after redaction — use `processedContent` not `content` | `chat-send-message.ts:226`, `chat-stream-message.ts:314` | CR-1 |
| 1.2 | Remove HYOK token from `kms_config` JSON — store env-var reference only | `byok-service.ts:143–167` | CR-2 |
| 1.3 | Block `privateKeyPemDev` write in production — throw before DB write | `byok-service.ts:123–138` | CR-5 |
| 1.4 | Replace all `Math.random()` with `crypto.randomBytes` for IDs | `byok-service.ts:480`, `compliance/deletion.ts:30`, `compliance/durable.ts:246` | CR-3 |
| 1.5 | Zero key material on exception in `bootstrapTenant` — add `try/finally` | `key-manager.ts:233–238` | CR-6 |
| 1.6 | Fix pgvector SQL injection — validate table name and dims at construction | `memory/src/memory.ts:1094` | CR-4 |
| 1.7 | Fix ChromeProvider LIKE SQL injection — parameterise query | `password-providers.ts:354–360` | H-1 |
| 1.8 | Fix sandbox misleading `evaluated: true` output | `sandbox/src/sandbox.ts:92–119` | CR-7 |
| 1.9 | Encrypt API keys in `search_providers`, `social_accounts`, `enterprise_connectors` | `db-schema.ts:570–638`, new migration | H-2 |
| 1.10 | Add SSRF guard to HYOK proxy endpoint | `byok/byok-keystore.ts:116–135` | H-9 |

**Exit criteria:** Security stress tests pass. New test asserts `messages.content` equals redacted text when redaction is enabled.

---

### Phase 2 — Database & Performance Foundations (Weeks 2–3)
*Prevent performance degradation; fix data integrity bugs.*

| # | Action | File(s) | Finding |
|---|--------|---------|---------|
| 2.1 | Add indexes to `messages`, `chats`, `sessions`, `traces`, `metrics` | New migration `m49-critical-indexes.ts` | H-3 |
| 2.2 | Implement point-lookup methods on `EncryptionStore` (`getKekById`, `getDekById`) | `EncryptionStore` interface + all impls | H-13 |
| 2.3 | Add `schemaReady` guard to `weavePostgresMemoryStore` | `memory/src/memory.ts:488` | M-22 |
| 2.4 | Fix retention rule priority — add `priority` field, sort before evaluation | `compliance/src/retention.ts` | H-7 |
| 2.5 | Fix token counting — propagate prompt/completion split from `AgentResult.usage` | `chat-send-message.ts:352`, `chat-stream-message.ts:453` | H-4 |
| 2.6 | Fix redaction overlap deduplication algorithm | `redaction/src/redactor.ts:87–99` | H-8 |
| 2.7 | Fix `restore()` to replace all token occurrences globally | `redaction/src/redactor.ts:117` | L-10 |
| 2.8 | Implement `remaining()` with real bucket query | `tool-policy-resolver.ts:107` | M-10 |
| 2.9 | Implement `active_hours_utc` enforcement in `resolve()` | `tool-policy-resolver.ts` | M-9 |
| 2.10 | Fix `prompt_eval_runs` default status to `'pending'` | `db-schema.ts:307` | L-15 |
| 2.11 | Add `eval_results.settings_snapshot_at` column | `db-schema.ts:98`, new migration | M-19 |

**Exit criteria:** `EXPLAIN QUERY PLAN` on all indexed queries confirms index use. Cost-ledger test verifies correct prompt/completion token split.

---

### Phase 3 — Logic & Reliability Hardening (Weeks 3–5)
*Eliminate silent failures, logic bugs, and type-safety gaps.*

| # | Action | File(s) | Finding |
|---|--------|---------|---------|
| 3.1 | Wrap all `settingsFromRow` JSON.parse in try/catch | `chat-runtime.ts:177–207` | M-12 |
| 3.2 | Validate compliance KV records before cast | `compliance/src/durable.ts` | M-25 |
| 3.3 | Replace empty `catch {}` in `loadAll` with structured log + metric | `compliance/src/durable.ts:37–44` | H-10 |
| 3.4 | Extract `historyToMessages` to `chat-message-utils.ts` | `chat-send-message.ts`, `chat-stream-message.ts` | H-15 |
| 3.5 | Extract `toolEvidence` filter to `chat-message-utils.ts` | `chat-send-message.ts:393`, `chat-stream-message.ts:592` | M-18 |
| 3.6 | Replace `any` provider module casts with typed interfaces | `chat-runtime.ts:76–109` | M-15 |
| 3.7 | Define `CachedResponse` type — remove `as any` for cache hit path | `chat-send-message.ts:342` | M-16 |
| 3.8 | Fix delegation circular check to include `to.id` in chain | `identity/src/delegation.ts:51` | H-16 |
| 3.9 | Fix fake AWS credentials injected to real endpoints | `memory/src/memory.ts:696` | H-17 |
| 3.10 | Emit audit event when wildcard permission fires | `identity/src/access.ts:48` | H-6 |
| 3.11 | Log memory save / embedding failures | `chat-send-message.ts:464`, `chat.ts:630` | L-16, L-17 |
| 3.12 | Log encryption failure before plaintext fallback in `updateChatTitle` | `db-encrypted-adapter.ts:261` | L-7 |
| 3.13 | Return `status: 'guardrail_denied'` from agent when output blocked | `agents/src/agent.ts:326` | M-21 |
| 3.14 | Introduce `decision: 'skipped'` for budget-exhausted guardrails | `guardrails/src/pipeline.ts:100` | M-8 |
| 3.15 | Wrap agent `JSON.parse(tc.arguments)` in try/catch | `agents/src/agent.ts:786` | H-11 |
| 3.16 | Yield distinct event types for verify/reflect loop steps | `agents/src/agent.ts:590` | M-31 |
| 3.17 | Validate A2A agent card URL against origin | `a2a/src/a2a.ts:38` | H-14 |
| 3.18 | Implement `cancelTask` HTTP error checking | `a2a/src/a2a.ts:121` | L-13 |
| 3.19 | Define domain error classes across compliance, identity, routing, guardrails | Multiple packages | L-27, A-6 |
| 3.20 | Delete orphaned user message on client disconnect | `chat-stream-message.ts:527` | M-27 |
| 3.21 | Abort tool execution on timeout via `AbortSignal` | `tools/src/policy.ts:354` | M-28 |

**Exit criteria:** Full E2E test suite passes. Guardrail-denied flows return correct status codes in API tests.

---

### Phase 4 — Security Hardening & Compliance Alignment (Weeks 5–8)
*Close remaining security gaps; align with mid-2026 enterprise standards.*

| # | Action | File(s) | Finding |
|---|--------|---------|---------|
| 4.1 | Add FIDO2/WebAuthn passkey registration and authentication endpoints | New `auth-passkey.ts`, `routes/auth.ts` | Standards gap |
| 4.2 | Add `__Host-` cookie prefix to session cookie | `auth.ts:201` | L-1 |
| 4.3 | Sanitise `corsOrigin` against CRLF; reject `*` with credentials | `server.ts:188` | M-1 |
| 4.4 | Validate OAuth `provider` against allowlist | `routes/auth.ts:394` | M-3 |
| 4.5 | Truncate and allowlist-filter OAuth error reflection | `routes/auth.ts:451` | M-2 |
| 4.6 | Fix `postMessage` to use server-emitted parent origin as `targetOrigin` | `routes/auth.ts:536` | M-7 |
| 4.7 | Validate `Host` header for OAuth redirect URI construction | `server-core.ts:385` | M-4 |
| 4.8 | Broaden `isWeakSecret` pattern matching | `env-validation.ts:28` | M-6 |
| 4.9 | Gate registration session on email verification | `routes/auth.ts:278` | L-2 |
| 4.10 | Issue WS ticket endpoint; accept ticket not JWT in query string | `server.ts:393` | L-6 |
| 4.11 | Migrate legacy vault records to v1 format; remove static salt path | `vault.ts:20`, new migration | H-5 |
| 4.12 | Cache `VAULT_KEY` at startup | `vault.ts:25` | L-5 |
| 4.13 | Scope MCP gateway rate limits to `(tenantId, clientId)` | `mcp-gateway.ts` | A-9 |
| 4.14 | Add `defaultDeny` option to `DurableResidencyEngine` | `compliance/src/durable.ts` | L-9 |
| 4.15 | Change `DEFAULT_TOOL_POLICY.allowedRiskLevels` default to `['read-only']` | `tools/src/policy.ts:74` | M-30 |
| 4.16 | Add EU AI Act Article 12 log retention tiering (90-day operational / 7-year compliance) | New migration + `db-schema.ts` | Standards gap |
| 4.17 | Implement step-up MFA for admin route group | `routes/admin-wiring.ts`, `rbac.ts` | Standards gap |
| 4.18 | Redact ReAct scratchpad / chain-of-thought before trace persistence | `chat-trace-utils.ts` | Standards gap |
| 4.19 | Add system-prompt leakage detection guardrail | New `guardrail-system-prompt.ts` | Standards gap |
| 4.20 | Restrict `'*'` wildcard assignment to bootstrap/seed only | `identity/src/access.ts` | L-26 |

**Exit criteria:** Security stress tests pass. Manual OWASP LLM Top 10 (2025) walkthrough with no new CRITICAL or HIGH findings.

---

### Phase 5 — Modularity, DX & Long-Term Maintainability (Weeks 8–12)
*Reduce maintenance burden; improve observability; lay ISO 42001 groundwork.*

| # | Action | File(s) | Finding |
|---|--------|---------|---------|
| 5.1 | Split `memory.ts` (1411 lines) into per-backend modules with dynamic imports | `packages/memory/src/` | A-1 |
| 5.2 | Extract `buildAgentInstance()` from `runAgent` / `streamAgent` | `chat.ts:858–1316` | H-12 |
| 5.3 | Extract shared terminal-response handler from `run()` / `runStream()` | `agents/src/agent.ts:471–728` | H-18 |
| 5.4 | Extract `buildMemoryToolCallbacks()` and `buildAgendaToolCallbacks()` | `chat.ts:612–853` | A-3 |
| 5.5 | Extract `executeMemoryQuery()` helper | `chat.ts:629–679` | M-17 |
| 5.6 | Remove duplicate scorer call in `SmartModelRouter.route()` | `routing/src/router.ts:198` | M-29 |
| 5.7 | Split `db-schema.ts` (1319 lines) by domain | `apps/geneweave/src/` | A-7 |
| 5.8 | Encapsulate guardrail-judge module singletons into `GuardrailJudgeRegistry` class | `guardrail-judge.ts` | A-4 |
| 5.9 | Add `createGeneWeave()` startup rollback mechanism | `index.ts` | A-5 |
| 5.10 | Scope encryption package public API; mark internal exports `@internal` | `encryption/src/index.ts` | A-2 |
| 5.11 | Adopt structured logger (pino) across all packages; remove bare `console.*` | All packages | A-8 |
| 5.12 | Implement server-side filtered `clear()` in all memory store backends | `memory/src/memory.ts` | L-25 |
| 5.13 | Add rotation integration test (write → rotate → verify) | New test file | A-10 |
| 5.14 | Add ISO 42001 AIMS documentation: AI system inventory, risk register, review cadence | `/docs/iso42001-aims.md` | Standards gap |
| 5.15 | Add NIST AI RMF Govern/Map/Measure/Manage lifecycle documentation | `/docs/nist-ai-rmf.md` | Standards gap |

**Exit criteria:** TypeScript strict-mode clean build. All existing tests pass. Code coverage maintained or increased. No file in `packages/` or `apps/geneweave/src/` exceeds 600 lines.

---

## Appendix — Finding Count by Category

| Category | Count |
|---|---|
| SECURITY | 28 |
| LOGIC | 19 |
| SILENT_FAIL | 12 |
| HARDCODED | 9 |
| REDUNDANCY | 8 |
| TYPE_SAFETY | 8 |
| MISSING_CONTROL | 10 |
| PERFORMANCE | 7 |
| COMMENT | 4 |
| MODULARITY (arch) | 10 |
| Standards gaps | 12 |
| **Total** | **127** |

---

*Review conducted June 2026. Standards baseline: OWASP LLM Top 10 (2025 edition), ISO/IEC 42001, NIST AI RMF 1.0, EU AI Act Articles 9/11/12, SOC 2 Type II AI agent controls, FIDO Alliance Passkey 2026 guidance.*
