# @weaveintel/artifacts — Research, Gap Analysis & Phased Roadmap (Mid-2026)

> Prepared: June 2026  
> Scope: `packages/artifacts`, `packages/core` (artifact contracts), `apps/geneweave` integration  
> Research baseline: Claude Artifacts (Anthropic), Google ADK Artifacts, Cloudflare Artifacts, AI SDK (Vercel), LibreChat, AI SDK Tools

---

## Table of Contents

1. [Current State Audit](#1-current-state-audit)
2. [Mid-2026 Industry Feature Landscape](#2-mid-2026-industry-feature-landscape)
3. [Gap Analysis](#3-gap-analysis)
4. [Issues with Existing Implementation](#4-issues-with-existing-implementation)
5. [geneWeave Integration Gaps](#5-geneweave-integration-gaps)
6. [Phased Implementation Plan](#6-phased-implementation-plan)
   - [Phase 0 — Fixes & Correctness](#phase-0--fixes--correctness-week-1)
   - [Phase 1 — Persistent Storage & Scoping](#phase-1--persistent-storage--scoping-weeks-23)
   - [Phase 2 — Extended Type System](#phase-2--extended-type-system-week-4)
   - [Phase 3 — geneWeave DB, API & Admin](#phase-3--geneweave-db-api--admin-weeks-45)
   - [Phase 4 — Streaming Lifecycle](#phase-4--streaming-lifecycle-weeks-56)
   - [Phase 5 — Sandboxed Rendering](#phase-5--sandboxed-rendering-weeks-78)
   - [Phase 6 — Live Artifacts & MCP Connectivity](#phase-6--live-artifacts--mcp-connectivity-weeks-910)
   - [Phase 7 — Export, Share & Embed](#phase-7--export-share--embed-weeks-1112)
7. [Detailed Specifications](#7-detailed-specifications)
8. [Sources](#8-sources)

---

## 1. Current State Audit

### Package Structure

| File | Lines | Responsibility |
|---|---|---|
| `packages/artifacts/src/artifact.ts` | 91 | Factory functions, size estimation, MIME mapping |
| `packages/artifacts/src/store.ts` | 72 | In-memory `ArtifactStore` implementation |
| `packages/artifacts/src/policy.ts` | 88 | Policy creation, validation, expiry checks |
| `packages/artifacts/src/reference.ts` | 48 | Reference creation, resolution, formatting |
| `packages/artifacts/src/index.ts` | 5 | Re-exports |
| `packages/core/src/artifacts.ts` | 63 | Core TypeScript contracts/interfaces |

**Total: ~367 lines across 6 files.** The package is a minimal, well-typed utility layer — not a production-ready system.

### Exported API Surface

```
createArtifact(opts)               — Factory: id + timestamp + size estimation
createArtifactVersion(id, n, data) — Version snapshot factory
estimateSize(data)                 — Byte-size of arbitrary payloads
inferMimeType(type)                — ArtifactType → MIME string

createInMemoryArtifactStore()      — In-memory Map-backed store

createArtifactPolicy(opts)         — Policy with defaults
validateArtifact(artifact, policy) — {valid, violations[]}
isExpired(artifact, policy)        — Boolean retention check

createArtifactReference(id, v, l)  — Lightweight pointer
resolveReference(store, ref)       — Fetch + version-patch from store
formatReference(ref)               — "artifact:{id}@v{n} ({label})"
```

### ArtifactType Union (current)

```typescript
'text' | 'csv' | 'json' | 'html' | 'markdown' | 'image' | 'pdf' 
| 'diagram' | 'code' | 'report' | 'custom'
```
— 11 types. No React, SVG, Mermaid, audio, video, spreadsheet, or interactive.

### MIME Type Mapping (current)

| Type | MIME (current) | Issue |
|---|---|---|
| `text` | `text/plain` | ✅ |
| `csv` | `text/csv` | ✅ |
| `json` | `application/json` | ✅ |
| `html` | `text/html` | ✅ |
| `markdown` | `text/markdown` | ✅ |
| `image` | `image/png` | ❌ Hardcoded — ignores jpg, gif, svg, webp |
| `pdf` | `application/pdf` | ✅ |
| `diagram` | `image/svg+xml` | ⚠️ Diagram ≠ SVG; Mermaid is text |
| `code` | `text/plain` | ❌ Should vary by language |
| `report` | `text/html` | ✅ |
| `custom` | `application/octet-stream` | ✅ |

### How geneWeave Uses Artifacts Today

1. **`artifact_policies` table** — CRUD for policy governance; 3 seeded defaults (100 MB, 10 MB strict, 1 GB large).
2. **`kaggle_run_artifacts` table** — Stores `CompletionReport` + `RunLog` JSON per Kaggle run for replay. Not typed through `@weaveintel/artifacts` at all — it's a bespoke Kaggle-specific storage.
3. **`docs-html.ts`** — References `createArtifactStore({ backend: 'local', ... })` in the public developer docs. **This function does not exist** in the package — a dead reference.
4. **No agent-level artifact emission** — Agents produce text and tool outputs but do not stamp results as typed artifacts.
5. **No chat-level artifact surface** — The UI does not show artifacts alongside chat messages.

---

## 2. Mid-2026 Industry Feature Landscape

### 2.1 Claude Artifacts (Anthropic, April/June 2026)

The reference implementation for conversational AI artifacts.

#### Supported Types
- HTML/CSS/JavaScript web pages
- React components (with Tailwind, Recharts, Recharts, Lucide icons)
- SVG vector graphics
- Mermaid diagrams (flowcharts, sequence, ER, gantt)
- Code files (any language, syntax-highlighted)
- Markdown documents
- Downloadable files: `.docx`, `.pptx`, `.xlsx`, `.pdf`

#### Key Features
- **Side-panel live preview** — rendered alongside conversation, not static code
- **Iterative editing** — highlight text → "Edit with Claude" without describing location in chat
- **Version selector** — every edit creates a new version, navigable history without overwriting
- **Multiple simultaneous artifacts** — work on several at once within a conversation
- **"Try fixing with Claude"** — error details auto-copied for diagnosis
- **Organized sidebar** — all artifacts browsable across conversations

#### 2026 Additions

**Live Artifacts (April 2026):**
- Artifacts connect to MCP servers and external data sources
- Refresh with real data when reopened (not frozen snapshots)
- State persistence across sessions
- Embed Claude API calls within the artifact itself (AI-powered apps)
- Use cases: KPI dashboards, pipeline trackers, content calendars

**June 2026 Claude Design Update (beta):**
- Imported design systems
- WYSIWYG visual canvas editing
- Claude Code handoff — AI-generated prototype → production code

**Sharing / Publishing:**
- Claude Share: public links, no account required
- Publish: indexed public URLs
- Embed code (iframe) with domain configuration
- End-user usage billing (creator not charged for others' sessions)

### 2.2 Google ADK Artifacts (2026)

Production-grade artifact system for multi-agent workflows.

#### Data Model
- Data as `google.genai.types.Part` (inline_data: bytes + mime_type)
- Handles non-textual data: images, audio, video, PDFs, spreadsheets
- Binary-first, not JSON/text-first like @weaveintel/artifacts

#### Scoping (critical differentiator)
```
Session scope:  scoped to (app_name, user_id, session_id)
User scope:     scoped to (app_name, user_id) — "user:" filename prefix
```
User-scoped artifacts survive across sessions — persistent user data (profiles, preferences, long-term reports).

#### Versioning
- Automatic: every `save_artifact()` call = new version
- Versions are 0-indexed sequential integers
- `load_artifact(filename)` → latest version
- `load_artifact(filename, version=N)` → specific version
- `list_versions(filename)` → all version numbers

#### Storage Backends (interchangeable)
| Backend | Persistence | Use case |
|---|---|---|
| `InMemoryArtifactService` | Ephemeral (process lifetime) | Dev / testing |
| `GcsArtifactService` | Permanent (GCS bucket) | Production |
| Custom (`BaseArtifactService`) | Pluggable | On-premise, SQLite, S3 |

Switch in one line; no application code changes needed.

#### Agent/Tool Integration
```python
# Save
version = await context.save_artifact("report.pdf", artifact_part)

# Load latest
artifact = await context.load_artifact("report.pdf")

# Load specific version
artifact = await context.load_artifact("report.pdf", version=2)

# Cross-session user artifact
await context.save_artifact("user:profile.png", artifact_part)
```

### 2.3 Cloudflare Artifacts (April 2026, private beta)

Git-compatible versioned storage built for AI agents — the most technically advanced system.

#### Core Innovation
- **Git-wire-protocol compatibility** — agents can push/pull artifacts like a Git remote
- **Delta/diff storage** — raw deltas + base hashes persisted alongside full objects; client-aware diff serving (saves bandwidth)
- **Durable Object SQLite backend** — files chunked across rows (2 MB max row size)
- **ArtifactFS** — filesystem driver that mounts large repos lazily (blobless clone + background hydration)
- **First-class history** — file history is an agent-queryable resource, not just metadata

#### Design Philosophy
> "Durable working tree that survives beyond one process, one container, or one browser session."

Artifacts as durable state shared across agent invocations — not ephemeral tool outputs.

### 2.4 AI SDK (Vercel) — Structured Streaming Artifacts

Production-ready framework for streaming typed artifacts from LLM tool calls.

#### Streaming Lifecycle
```typescript
// Three-phase lifecycle
.stream(initialState)   // Initialize artifact with loading state
.update(partialState)   // Send intermediate deltas during generation
.complete(finalState)   // Finalize with full data + success status
```

#### Typed Schemas with Zod
```typescript
const dashboardSchema = z.object({
  title: z.string(),
  metrics: z.object({ revenue: z.number(), users: z.number() }),
  status: z.enum(['loading', 'streaming', 'complete', 'error']),
  progress: z.number().min(0).max(1),
});
```

#### React Integration
```typescript
const { data, status, isActive } = useArtifact(artifactId, {
  onUpdate: (partial) => { ... },
  onComplete: (final)  => { ... },
  onError:    (err)    => { ... },
  onProgress: (pct)    => { ... },
});
```

### 2.5 LibreChat — Sandboxed Rendering

Pragmatic implementation using CodeSandbox Sandpack.

#### Rendering Stack
- CodeSandbox Sandpack library for secure iframe execution
- `frame-src 'self' https://*.codesandbox.io` CSP policy
- Self-hosting option via `SANDPACK_BUNDLER_URL` env var
- Supported: React, HTML, Mermaid

#### Security Model
- No direct filesystem access
- Sandboxed iframes prevent XSS
- localStorage disabled in sandbox
- CDN resources may be restricted

---

## 3. Gap Analysis

### 3.1 Package-Level Gaps (`packages/artifacts`)

| Feature | Current State | Mid-2026 Standard | Priority |
|---|---|---|---|
| **Storage backends** | In-memory only | SQLite, S3, GCS, local filesystem | 🔴 Critical |
| **Session scoping** | None — no concept of owner | session_id + user_id scoping | 🔴 Critical |
| **User-scoped artifacts** | None | Cross-session user artifacts | 🔴 Critical |
| **Streaming lifecycle** | None | stream → update → complete | 🔴 Critical |
| **Policy enforcement at save** | Separate validation call | Enforced inside store.save() | 🔴 Critical |
| **React component type** | Missing | `'react'` type + sandboxed render | 🟠 High |
| **SVG type** | Lumped into `'diagram'` | `'svg'` as distinct type | 🟠 High |
| **Mermaid type** | Missing | `'mermaid'` with diagram render | 🟠 High |
| **Audio/Video types** | Missing | `'audio'` / `'video'` MIME-typed | 🟡 Medium |
| **Spreadsheet type** | Missing | `'spreadsheet'` (xlsx/csv-rich) | 🟡 Medium |
| **Interactive type** | Missing | `'interactive'` (sandbox-executed) | 🟠 High |
| **Version diffing** | Full snapshot storage | Delta / diff-based storage | 🟡 Medium |
| **Version pruning** | Never expires | Retention-driven cleanup | 🟡 Medium |
| **Zod schema validation** | None | Typed schemas per artifact type | 🟠 High |
| **Batch reference resolution** | N×1 queries | Batch resolve + in-process cache | 🟡 Medium |
| **Image MIME flexibility** | Hardcoded `image/png` | Detect from magic bytes / metadata | 🟠 High |
| **Code MIME by language** | `text/plain` for all | `text/typescript`, `text/python`, etc. | 🟡 Medium |
| **MCP data connectivity** | None | Live data sources via MCP | 🟡 Medium |
| **Test coverage** | Zero tests | Full vitest suite | 🔴 Critical |
| **ArtifactStore.update()** | Missing | Update existing artifact → new version | 🔴 Critical |
| **ArtifactStore.search()** | No full-text search | Tag/name/type search | 🟡 Medium |

### 3.2 geneWeave-Level Gaps

| Feature | Current State | Required | Priority |
|---|---|---|---|
| **Artifacts table in DB** | None (only policies) | `artifacts` + `artifact_versions` tables | 🔴 Critical |
| **SQLite artifact backend** | Docs reference it, doesn't exist | `createSQLiteArtifactStore(db)` | 🔴 Critical |
| **Artifact CRUD API** | None | Full REST: GET/POST/PUT/DELETE | 🔴 Critical |
| **Agent artifact emission** | Agents produce raw text only | Agents call `emit_artifact` tool | 🟠 High |
| **Chat-level artifact surface** | Not shown in UI | Inline artifact cards in chat messages | 🟠 High |
| **Admin artifact browser** | Only policy admin | List/view/download artifacts + versions | 🟠 High |
| **Artifact rendering in UI** | None | Sandboxed preview (HTML, React, SVG) | 🟠 High |
| **Version history UI** | None | Version navigator + diff view | 🟡 Medium |
| **Live Artifacts** | None | MCP-connected refresh mechanism | 🟡 Medium |
| **Download/export** | None | Download by type (PDF, DOCX, raw) | 🟡 Medium |
| **Share/publish** | None | Public URLs with expiry | 🟡 Medium |
| **docs-html.ts broken ref** | `createArtifactStore()` doesn't exist | Fix or implement function | 🔴 Critical (doc) |
| **Kaggle artifacts typed** | Bespoke JSON storage | Reuse `ArtifactStore` contract | 🟡 Medium |
| **Retention execution** | `isExpired()` exists but never called | Scheduled retention job | 🟡 Medium |

---

## 4. Issues with Existing Implementation

### 4.1 Missing `ArtifactStore.update()` method

**Problem:** The `ArtifactStore` interface has no `update()` method. Updating an artifact requires calling `save()` again with a new object — but `save()` always assigns a new UUID. There is no way to create a new version of an existing artifact through the current API.

**Impact:** Version history is broken for mutation workflows. Calling `save()` again creates a sibling artifact, not a new version of the same one.

**Fix:**
```typescript
// Add to ArtifactStore interface in core:
update(artifactId: string, patch: Partial<Omit<Artifact, 'id' | 'createdAt'>>): Promise<Artifact>;
```
The implementation should:
1. Fetch existing artifact
2. Merge patch
3. Increment version
4. Write new version record
5. Update `updatedAt`

### 4.2 Policy enforcement is opt-in (not enforced at save)

**Problem:** `validateArtifact(artifact, policy)` exists but is never called by the store itself. Any caller can `store.save()` any artifact regardless of policy. Policy enforcement requires callers to manually validate first.

**Impact:** In a multi-tenant or multi-agent system, one misbehaving agent can store artifacts that violate all policies — there's no guard.

**Fix:** The store constructor should accept an optional policy:
```typescript
createInMemoryArtifactStore(policy?: ArtifactPolicy): ArtifactStore
```
Then inside `save()`:
```typescript
if (policy) {
  const result = validateArtifact(artifact, policy);
  if (!result.valid) throw new Error(`Policy violation: ${result.violations.join(', ')}`);
}
```

### 4.3 `inferMimeType` is a lossy one-way mapping

**Problem:** `image` → `image/png` regardless of actual content. If an agent produces a JPEG or WebP image, it's incorrectly typed as PNG. There is no way to specify image subtype.

**Fix 1 (short-term):** Accept optional `mimeType` override that takes precedence over the inference.  
**Fix 2 (proper):** Add image subtypes — `'image/jpeg'`, `'image/webp'`, `'image/gif'` — and detect from binary magic bytes (`\xFF\xD8` = JPEG, `RIFF...WEBP` = WebP) when data is a Buffer.

### 4.4 `diagram` type conflates SVG and Mermaid

**Problem:** `diagram` maps to `image/svg+xml`. But Mermaid diagrams are text (`text/plain` or `text/x-mermaid`), not SVG. An agent generating Mermaid source code would be incorrectly typed as SVG.

**Fix:** Add separate types:
- `'svg'` → `image/svg+xml` (vector image source)
- `'mermaid'` → `text/x-mermaid` (diagram definition language)
- Keep `'diagram'` as alias for `'svg'` for backwards-compatibility

### 4.5 Version history not exposed via `update()` creates orphaned version records

**Problem:** `createInMemoryArtifactStore().save()` auto-creates a version record (version 1). But there's no way to add version 2, 3, etc. via the store API. `createArtifactVersion()` creates a standalone record but doesn't connect it to the store. The `getVersions()` method on the store will always return just `[version 1]` because nothing ever writes version 2+.

**Impact:** Version history is effectively useless in the current implementation.

### 4.6 Reference resolution has no version-specific data patching for version ≥ 2

**Problem:** `resolveReference(store, ref)` fetches the artifact and then attempts to override `data` with the pinned version's data:
```typescript
const artifact = await store.get(ref.artifactId);
if (ref.version) {
  const versions = await store.getVersions(ref.artifactId);
  const pinned = versions.find(v => v.version === ref.version);
  if (pinned) return { ...artifact, data: pinned.data };
}
```
But since `getVersions()` only ever returns version 1, pinning to version 2 returns `undefined` and falls back to the latest artifact data — silently ignoring the version pin.

### 4.7 `estimateSize` is incorrect for nested objects with circular references

**Problem:** `JSON.stringify` throws on circular references. If `data` is an object with circular references, `estimateSize()` crashes instead of returning a safe estimate.

**Fix:**
```typescript
export function estimateSize(data: unknown): number {
  if (data === null || data === undefined) return 0;
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (data instanceof Uint8Array) return data.byteLength;
  try {
    return Buffer.byteLength(JSON.stringify(data), 'utf8');
  } catch {
    return 0; // circular reference or non-serialisable
  }
}
```

### 4.8 `ArtifactStore.list()` filter is AND-only, no OR/NOT semantics

**Problem:** All filters are ANDed. You cannot query "all artifacts of type code OR html" or "all artifacts NOT tagged 'draft'".

**Fix (short-term):** Support array for `type`:
```typescript
list(filter?: {
  type?: ArtifactType | ArtifactType[];
  // ...
}): Promise<Artifact[]>;
```

### 4.9 No `sessionId` or `userId` on `Artifact`

**Problem:** Artifacts have `agentId` and `runId` but no `sessionId` or `userId`. This makes it impossible to scope artifact access to a specific user or chat session — a fundamental requirement for multi-user deployments.

**Fix:** Add to the `Artifact` interface:
```typescript
sessionId?: string;   // tied to a specific chat/session
userId?: string;      // owner (determines cross-session visibility)
scope?: 'session' | 'user';  // 'session' = ephemeral, 'user' = persistent
```

### 4.10 Zero test coverage

The `package.json` declares `vitest ^3.2.6` as a dev dependency but there are no test files. Given the correctness issues above (versioning, reference resolution, estimateSize), tests are essential.

---

## 5. geneWeave Integration Gaps

### 5.1 `createArtifactStore()` referenced in docs but doesn't exist

`apps/geneweave/src/docs-html.ts` (lines 4965–5056) documents:
```typescript
const store = createArtifactStore({ backend: 'local', path: './artifacts' });
const store = createArtifactStore({ backend: 's3', bucket: 'my-bucket' });
```
These functions are not implemented anywhere in the codebase. Any developer following the docs will hit a runtime error. This is a critical docs/API inconsistency.

**Fix:** Either implement `createArtifactStore()` as a factory with backend adapters, or update the docs to reflect the real `createInMemoryArtifactStore()` API.

### 5.2 No `artifacts` or `artifact_versions` tables in geneWeave DB

The database has `artifact_policies` (governance) and `kaggle_run_artifacts` (bespoke storage), but no general-purpose artifact persistence. There is no way to persist a typed artifact produced by an agent across server restarts.

**Required migrations:**
```sql
-- Table: artifacts
CREATE TABLE IF NOT EXISTS artifacts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  data        BLOB,             -- raw bytes for binary; JSON for structured
  data_text   TEXT,             -- plain text for indexed search
  size_bytes  INTEGER,
  version     INTEGER NOT NULL DEFAULT 1,
  session_id  TEXT,             -- scoped to chat session (nullable = global)
  user_id     TEXT,             -- owner
  agent_id    TEXT,             -- producing agent
  run_id      TEXT,             -- originating run
  tags        TEXT,             -- JSON string[]
  metadata    TEXT,             -- JSON object
  policy_id   TEXT REFERENCES artifact_policies(id),
  scope       TEXT NOT NULL DEFAULT 'session',  -- 'session' | 'user'
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);

-- Table: artifact_versions
CREATE TABLE IF NOT EXISTS artifact_versions (
  id          TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  data        BLOB,
  data_text   TEXT,
  changelog   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(artifact_id, version)
);
```

### 5.3 Agents don't emit artifacts

Worker agents and the supervisor produce text + tool output but never create typed artifact records. The `analyst` worker running `cse_run_data_analysis` produces an analysis but it disappears — no persistent typed record.

**Required:** An `emit_artifact` built-in tool registered in every worker's tool registry. When called, it invokes `db.saveArtifact()` and returns the artifact ID for reference.

### 5.4 No artifact surface in chat messages

Chat responses have no mechanism to attach or display artifact cards. The frontend and message metadata schema have no artifact reference field.

**Required:** 
- Add `artifactIds?: string[]` to message metadata
- Render artifact cards in the chat UI alongside message text
- Link artifact cards to the artifact detail / version navigator

### 5.5 Kaggle run artifacts bypass the artifact system

`kaggle_run_artifacts` stores `CompletionReport` and `RunLog` as raw JSON strings in a bespoke table. This bypasses all of the artifacts system: no versioning, no policy, no typing, no retention, no admin browser.

**Recommended:** Migrate to storing these through `ArtifactStore` with:
- `type: 'report'` (CompletionReport)
- `type: 'custom'` (RunLog with `metadata.artifactKind = 'kaggle-run-log'`)
- `tags: ['kaggle', runId]`

### 5.6 No retention execution

`isExpired(artifact, policy)` correctly checks retention, but nothing ever calls it to actually delete expired artifacts. There is no scheduled job, cron, or GC pass.

**Required:** A periodic retention job (e.g., run on server startup + daily) that:
1. Queries all artifacts with a policy
2. Calls `isExpired()` for each
3. Deletes expired artifacts and their version records

---

## 6. Phased Implementation Plan

### Phase 0 — Fixes & Correctness (Week 1)

**Goal:** Fix the identified bugs without changing the public API footprint.

#### `packages/artifacts/src/artifact.ts`

- [ ] **Fix `estimateSize`** — wrap `JSON.stringify` in try/catch, return 0 on error
- [ ] **Fix MIME map** — separate `image` into a sub-map, detect from Buffer magic bytes; `diagram` stays for backwards-compat but maps to `image/svg+xml`; add `code` language hint support via metadata

#### `packages/artifacts/src/store.ts`

- [ ] **Add `update()` to `createInMemoryArtifactStore`** — fetches existing, increments version, writes new version record, updates `updatedAt`
- [ ] **Fix version chain** — `save()` creates version 1; `update()` creates version 2, 3, etc. stored in the versions Map

#### `packages/core/src/artifacts.ts`

- [ ] **Add `ArtifactStore.update()` to interface** — `update(id, patch): Promise<Artifact>`
- [ ] **Add `sessionId`, `userId`, `scope` fields to `Artifact`** — all optional for backwards-compat

#### `packages/artifacts/src/policy.ts`

- [ ] **Add constructor-level policy option to stores** — `createInMemoryArtifactStore({ policy? })` enforces at `save()` time

#### `packages/artifacts/src/reference.ts`

- [ ] **Fix `resolveReference` version lookup** — after fetching versions, if pinned version not found, throw rather than silently falling back to latest

#### Tests — `packages/artifacts/src/*.test.ts`

- [ ] Add vitest suite covering:
  - `createArtifact` round-trip
  - `estimateSize` with all input types including circular refs
  - `createInMemoryArtifactStore`: save, get, list (all filter combos), delete, getVersions, update
  - `validateArtifact` with all violation scenarios
  - `isExpired` with boundary timestamps
  - `resolveReference` with pinned and unpinned versions
  - Policy enforcement at save time

**Deliverables:** Bug-free package with >90% test coverage.

---

### Phase 1 — Persistent Storage & Scoping (Weeks 2–3)

**Goal:** Production-usable storage backends and session/user scoping.

#### `packages/artifacts/src/backends/`

New directory with pluggable backend implementations:

##### `sqlite-store.ts`

```typescript
export function createSQLiteArtifactStore(
  db: BetterSqlite3.Database,
  opts?: { policy?: ArtifactPolicy; schema?: string }
): ArtifactStore
```

- Uses geneWeave's `artifacts` + `artifact_versions` tables
- Binary data stored as BLOB; text data in `data_text` for full-text search
- All queries prepared statements for performance
- `save()` enforces policy if provided
- `update()` increments version and writes `artifact_versions` row
- `list()` supports `sessionId`, `userId`, `scope` filters

##### `filesystem-store.ts`

```typescript
export function createFilesystemArtifactStore(
  basePath: string,
  opts?: { policy?: ArtifactPolicy }
): ArtifactStore
```

- Files stored as `{basePath}/{artifactId}/v{n}.{ext}`
- Metadata stored as `{basePath}/{artifactId}/meta.json`
- Suitable for development; not recommended for multi-instance

##### `factory.ts` — fixes the broken docs reference

```typescript
export function createArtifactStore(opts: {
  backend: 'memory' | 'sqlite' | 'filesystem';
  db?: BetterSqlite3.Database;       // required for 'sqlite'
  path?: string;                      // required for 'filesystem'
  policy?: ArtifactPolicy;
}): ArtifactStore
```

This makes `docs-html.ts` examples work and provides the discoverable API Anthropic-style callers expect.

#### Scoping

- Add `scope: 'session' | 'user'` to `Artifact`
- Session artifacts: `list(filter)` respects `filter.sessionId` — only returns artifacts from that session
- User artifacts: `list(filter)` with `filter.scope = 'user'` returns across all sessions for that user
- Consistent with Google ADK's session/user namespace model

#### `packages/artifacts/src/index.ts`

Export new backends:
```typescript
export { createArtifactStore } from './backends/factory.js';
export { createSQLiteArtifactStore } from './backends/sqlite-store.js';
export { createFilesystemArtifactStore } from './backends/filesystem-store.js';
```

**Deliverables:** SQLite and filesystem backends; `createArtifactStore()` factory; scoped list queries.

---

### Phase 2 — Extended Type System (Week 4)

**Goal:** Expand `ArtifactType` to cover all mid-2026 standard types.

#### `packages/core/src/artifacts.ts`

```typescript
export type ArtifactType =
  // Text formats
  | 'text' | 'markdown' | 'csv' | 'json' | 'code'
  // Document formats
  | 'html' | 'pdf' | 'report'
  // Visual formats
  | 'image' | 'svg' | 'diagram'  // 'diagram' = alias for 'svg'
  // Diagram-as-code
  | 'mermaid'
  // Rich interactive
  | 'react'        // React component source (TSX/JSX)
  | 'interactive'  // Generic sandbox-executed content
  // Media
  | 'audio'
  | 'video'
  // Data
  | 'spreadsheet'  // XLSX/ODS with schema
  // Escape hatch
  | 'custom';
```

#### Updated MIME Map

```typescript
const MIME_MAP: Record<ArtifactType, string> = {
  text: 'text/plain',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  code: 'text/plain',            // refined by metadata.language
  html: 'text/html',
  pdf: 'application/pdf',
  report: 'text/html',
  image: 'image/png',            // overridden by detectImageMime(data)
  svg: 'image/svg+xml',
  diagram: 'image/svg+xml',      // backward-compat alias
  mermaid: 'text/x-mermaid',
  react: 'text/typescript',      // TSX source
  interactive: 'text/html',
  audio: 'audio/mpeg',           // overridden by metadata.mimeType
  video: 'video/mp4',            // overridden by metadata.mimeType
  spreadsheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  custom: 'application/octet-stream',
};
```

#### Image MIME Detection

```typescript
export function detectImageMime(data: unknown): string {
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) return 'image/png';
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return 'image/png';
}
```

#### Code Language MIME

```typescript
const CODE_LANGUAGE_MIME: Record<string, string> = {
  typescript: 'text/typescript',
  javascript: 'text/javascript',
  python: 'text/x-python',
  rust: 'text/x-rustsrc',
  go: 'text/x-go',
  sql: 'application/sql',
  shell: 'application/x-sh',
  html: 'text/html',
  css: 'text/css',
};

export function inferCodeMime(language?: string): string {
  return CODE_LANGUAGE_MIME[language?.toLowerCase() ?? ''] ?? 'text/plain';
}
```

**Deliverables:** 17-type system; smart MIME detection; Mermaid, React, SVG, audio, video, spreadsheet types.

---

### Phase 3 — geneWeave DB, API & Admin (Weeks 4–5)

**Goal:** Full artifact persistence and management in geneWeave.

#### Migration: `m77-artifacts.ts`

```sql
-- artifacts table (see schema in §5.2)
-- artifact_versions table (see schema in §5.2)
-- Indexes:
CREATE INDEX idx_artifacts_session  ON artifacts(session_id);
CREATE INDEX idx_artifacts_user     ON artifacts(user_id);
CREATE INDEX idx_artifacts_agent    ON artifacts(agent_id);
CREATE INDEX idx_artifacts_run      ON artifacts(run_id);
CREATE INDEX idx_artifacts_type     ON artifacts(type);
CREATE INDEX idx_artifacts_scope    ON artifacts(scope);
CREATE INDEX idx_artifact_versions_artifact ON artifact_versions(artifact_id);
```

Seed: no default rows (artifacts are runtime data, not config).

#### DB Adapter: `adapter-artifacts.ts`

```typescript
export interface ArtifactsAdapterMethods {
  saveArtifact(artifact: Omit<Artifact, 'id' | 'createdAt'>): Promise<Artifact>;
  getArtifact(id: string): Promise<Artifact | null>;
  updateArtifact(id: string, patch: Partial<Omit<Artifact, 'id' | 'createdAt'>>): Promise<Artifact>;
  listArtifacts(filter?: ArtifactFilter): Promise<Artifact[]>;
  deleteArtifact(id: string): Promise<void>;
  getArtifactVersions(id: string): Promise<ArtifactVersion[]>;
  getArtifactVersion(id: string, version: number): Promise<ArtifactVersion | null>;
  expireArtifacts(): Promise<number>;    // returns count deleted
}

export type ArtifactFilter = {
  type?: ArtifactType | ArtifactType[];
  sessionId?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  scope?: 'session' | 'user';
  tags?: string[];
  policyId?: string;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
  offset?: number;
};
```

#### Admin API: `admin/api/artifacts.ts`

REST endpoints:

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/artifacts` | List with filters (type, sessionId, userId, tags) |
| GET | `/api/admin/artifacts/:id` | Get single artifact + metadata |
| GET | `/api/admin/artifacts/:id/versions` | Version history |
| GET | `/api/admin/artifacts/:id/versions/:n` | Specific version data |
| GET | `/api/admin/artifacts/:id/download` | Download raw artifact data |
| DELETE | `/api/admin/artifacts/:id` | Delete artifact + all versions |
| POST | `/api/admin/artifact-policies` | Already exists — no change |

#### Admin UI Tabs

Add to `callable-capability-tabs.ts`:

```typescript
'artifacts': {
  singular: 'Artifact', apiPath: 'admin/artifacts', listKey: 'artifacts',
  readOnly: true,
  cols: ['name', 'type', 'scope', 'size_bytes', 'version', 'agent_id', 'created_at'],
  fields: [
    { key: 'id',        label: 'ID',        readonly: true },
    { key: 'name',      label: 'Name',      readonly: true },
    { key: 'type',      label: 'Type',      readonly: true },
    { key: 'mime_type', label: 'MIME Type', readonly: true },
    { key: 'scope',     label: 'Scope',     readonly: true },
    { key: 'session_id',label: 'Session',   readonly: true },
    { key: 'user_id',   label: 'User',      readonly: true },
    { key: 'agent_id',  label: 'Agent',     readonly: true },
    { key: 'run_id',    label: 'Run',       readonly: true },
    { key: 'version',   label: 'Version',   readonly: true },
    { key: 'size_bytes',label: 'Size (B)',  readonly: true },
    { key: 'tags',      label: 'Tags',      readonly: true, textarea: true, rows: 2, save: 'json' },
    { key: 'policy_id', label: 'Policy',    readonly: true },
    { key: 'created_at',label: 'Created',   readonly: true },
  ],
}
```

Add **Artifacts** group to `ADMIN_TAB_GROUPS` after 'Orchestration'.

#### `emit_artifact` Built-in Tool

Register in `tools.ts` as a built-in tool available to all agents:

```typescript
// Schema
{
  name: 'emit_artifact',
  description: 'Save an output as a named, typed, versioned artifact.',
  parameters: {
    name:     { type: 'string', description: 'Artifact display name' },
    type:     { type: 'string', enum: ALL_ARTIFACT_TYPES },
    data:     { type: 'string', description: 'Artifact content (text/JSON-stringified)' },
    language: { type: 'string', description: 'Language hint for code artifacts' },
    tags:     { type: 'array', items: { type: 'string' }, optional: true },
    changelog:{ type: 'string', description: 'What changed', optional: true },
  }
}

// Execute
async execute(ctx, input) {
  const artifact = await db.saveArtifact({
    name: input.name,
    type: input.type,
    mimeType: inferMimeType(input.type, input.language),
    data: input.data,
    sessionId: ctx.chatId,
    userId: ctx.userId,
    agentId: ctx.agentId,
    scope: 'session',
    tags: input.tags,
    metadata: { changelog: input.changelog, language: input.language },
  });
  return { artifactId: artifact.id, version: artifact.version, name: artifact.name };
}
```

**Deliverables:** `artifacts` + `artifact_versions` DB tables; SQLite adapter; admin REST API; admin UI tab; `emit_artifact` built-in tool.

---

### Phase 4 — Streaming Lifecycle (Weeks 5–6)

**Goal:** Support real-time streaming artifact generation (large reports, progressive rendering).

#### `packages/artifacts/src/streaming.ts`

```typescript
export interface ArtifactStreamHandle<T = unknown> {
  readonly id: string;
  readonly status: 'streaming' | 'complete' | 'error';
  readonly progress: number;      // 0.0 – 1.0

  /** Send partial update (delta or full replacement depending on strategy) */
  update(partial: Partial<T>, progress?: number): Promise<void>;

  /** Finalize with complete data */
  complete(final: T, changelog?: string): Promise<Artifact>;

  /** Mark as failed */
  error(message: string): Promise<void>;
}

export function streamArtifact<T = unknown>(
  store: ArtifactStore,
  opts: CreateArtifactOptions,
  onProgress?: (handle: ArtifactStreamHandle<T>) => void,
): ArtifactStreamHandle<T>
```

#### SSE Endpoint for Streaming Artifacts

`GET /api/artifacts/:id/stream` — Server-Sent Events endpoint:
```
event: update
data: {"version": 1, "progress": 0.4, "data": "...partial..."}

event: complete
data: {"version": 2, "progress": 1.0, "data": "...final..."}

event: error
data: {"message": "Generation failed"}
```

#### Tool Integration

`emit_artifact` tool supports streaming mode:
```typescript
// Start streaming
const handle = streamArtifact(store, { name, type, ... });

// In tool execute — stream chunks as they arrive from LLM
for await (const chunk of stream) {
  await handle.update({ data: accumulated }, progress);
}

await handle.complete({ data: final });
```

**Deliverables:** `ArtifactStreamHandle` API; SSE streaming endpoint; tool streaming mode.

---

### Phase 5 — Sandboxed Rendering (Weeks 7–8)

**Goal:** Safe client-side rendering of HTML, React, SVG, and Mermaid artifacts.

#### Architecture

Following LibreChat's approach (Sandpack) with geneWeave-specific security:

```
Artifact data (server)
    → GET /api/artifacts/:id/render  (returns HTML wrapper)
    → Sandboxed <iframe sandbox="allow-scripts allow-same-origin">
    → Content Security Policy: frame-src 'self'; script-src 'nonce-{n}'
    → No outbound network (no cookies, no localStorage by default)
```

#### `ArtifactRenderer` component (frontend)

Render strategy by type:

| Type | Strategy |
|---|---|
| `html` | Sandboxed iframe with full HTML document |
| `react` | Sandpack live preview (CodeSandbox CDN or self-hosted) |
| `svg` | Inline SVG render (sanitised with DOMPurify) |
| `mermaid` | Mermaid.js in sandboxed iframe, render on load |
| `markdown` | marked.js render, sanitised HTML |
| `code` | Shiki syntax-highlighted code block |
| `json` | Collapsible tree view |
| `csv` | Sortable HTML table (first 1000 rows) |
| `image` | `<img>` with content-type from mimeType |
| `pdf` | PDF.js viewer in iframe |
| `audio` | `<audio>` element |
| `video` | `<video>` element |
| `report` | Sandboxed iframe (same as html) |
| `text` | Plain text with line numbers |
| `interactive` | Sandboxed iframe with scripts |

#### Security Considerations

- All untrusted HTML/SVG sanitised with DOMPurify before render
- React artifacts rendered inside Sandpack sandbox (no direct DOM access)
- `sandbox="allow-scripts"` — no top-level navigation, no form submit
- No access to parent window (no `window.parent.postMessage` to geneWeave origin)
- CSP `frame-src 'self'` — no cross-origin iframe escalation
- Optionally: self-host Sandpack bundler (`SANDPACK_BUNDLER_URL` env var)

#### Admin UI Preview

Add "Preview" button to artifact admin detail view. Opens modal with `ArtifactRenderer`.

**Deliverables:** Sandboxed iframe renderer; type-specific render strategies; DOMPurify sanitization; admin preview modal.

---

### Phase 6 — Live Artifacts & MCP Connectivity (Weeks 9–10)

**Goal:** Artifacts that refresh with real data when opened — the "Live Artifacts" paradigm.

#### Live Artifact Model

```typescript
export interface LiveArtifactConfig {
  artifactId: string;
  /** MCP server key from mcp_gateway_clients */
  mcpServerKey?: string;
  /** Tool to call on refresh */
  refreshTool?: string;
  /** Arguments passed to the refresh tool */
  refreshArgs?: Record<string, unknown>;
  /** Refresh interval in seconds (0 = manual only) */
  refreshIntervalSeconds?: number;
  /** Last refresh timestamp */
  lastRefreshedAt?: string;
}
```

New DB table `live_artifact_configs` stores configurations.

#### Refresh Mechanism

1. Client opens artifact → sends `POST /api/artifacts/:id/refresh`
2. Server calls the configured MCP tool
3. Tool returns new data
4. Server calls `db.updateArtifact(id, { data: newData })` → new version created
5. Response: `{ artifact, fromCache: boolean, refreshedAt: string }`

#### Admin UI for Live Config

"Make Live" action on artifact detail view:
- Select MCP server
- Select tool + args
- Set refresh interval
- "Refresh Now" button

#### Auto-refresh in Renderer

When viewing a live artifact, the `ArtifactRenderer` shows:
- Last refreshed timestamp
- "Refresh" button
- Auto-refresh toggle (uses the configured interval)

**Deliverables:** `live_artifact_configs` table; refresh endpoint; MCP integration; admin UI config; auto-refresh in renderer.

---

### Phase 7 — Export, Share & Embed (Weeks 11–12)

**Goal:** Download, share, and embed artifacts beyond geneWeave's own UI.

#### Download/Export

| Type | Export Format | Endpoint |
|---|---|---|
| `html` / `report` | `.html` file | `/api/artifacts/:id/download` |
| `markdown` | `.md` file | `/api/artifacts/:id/download` |
| `csv` | `.csv` file | `/api/artifacts/:id/download` |
| `json` | `.json` file | `/api/artifacts/:id/download` |
| `code` | `.<lang>` file | `/api/artifacts/:id/download` |
| `image` | `.png`/`.jpg` etc. | `/api/artifacts/:id/download` |
| `pdf` | `.pdf` file | `/api/artifacts/:id/download` |
| `svg` / `mermaid` | `.svg` file (rendered) | `/api/artifacts/:id/download?format=svg` |
| `react` | `.tsx` file | `/api/artifacts/:id/download` |
| Any | Zip of all versions | `/api/artifacts/:id/export` |

Content-Disposition: `attachment; filename="{artifact.name}.{ext}"`

#### Public Share Links

```
POST /api/artifacts/:id/share
Body: { expiresInDays?: number, password?: string }
→ { shareToken, url: "/share/artifacts/{shareToken}" }

GET /share/artifacts/:token          → renders artifact (public, no auth)
GET /share/artifacts/:token/raw      → returns raw data
```

- Share tokens are signed JWTs (not stored in DB)
- Optional password protection (bcrypt-hashed in token claim)
- Optional expiry (exp claim in JWT)

#### Embed Code

```
GET /api/artifacts/:id/embed-code?width=800&height=600
→ <iframe src="/embed/artifacts/:id" width="800" height="600" frameborder="0"></iframe>
```

Add "Copy Embed Code" button to artifact detail view.

#### Version Export

```
GET /api/artifacts/:id/versions/:n/download   → specific version
GET /api/artifacts/:id/export                  → all versions as zip
```

**Deliverables:** Typed download endpoints; JWT share tokens; embed code generation; version zip export.

---

## 7. Detailed Specifications

### File Layout After All Phases

```
packages/
  core/
    src/
      artifacts.ts               [MODIFIED] — extended types, scoping fields
  artifacts/
    src/
      artifact.ts                [MODIFIED] — estimateSize fix, MIME detection
      store.ts                   [MODIFIED] — update(), policy enforcement
      policy.ts                  [unchanged]
      reference.ts               [MODIFIED] — version pin fix
      streaming.ts               [NEW] — ArtifactStreamHandle
      backends/
        factory.ts               [NEW] — createArtifactStore()
        sqlite-store.ts          [NEW] — SQLite backend
        filesystem-store.ts      [NEW] — filesystem backend
      index.ts                   [MODIFIED] — export backends
      artifact.test.ts           [NEW]
      store.test.ts              [NEW]
      policy.test.ts             [NEW]
      reference.test.ts          [NEW]
      backends/sqlite-store.test.ts [NEW]

apps/geneweave/src/
  migrations/
    m77-artifacts.ts             [NEW] — artifacts + artifact_versions tables
  db-types/
    adapter-artifacts.ts         [NEW] — ArtifactsAdapterMethods
    artifacts.ts                 [NEW] — ArtifactRow, ArtifactVersionRow types
  admin/
    api/artifacts.ts             [NEW] — CRUD + download REST routes
    schema/artifact-tabs.ts      [NEW] — AdminTabDef for artifacts
  tools.ts                       [MODIFIED] — register emit_artifact tool
  docs-html.ts                   [MODIFIED] — fix createArtifactStore() docs
  server-admin.ts                [MODIFIED] — register artifact routes
  admin-schema.ts                [MODIFIED] — add Artifacts tab group
```

### Backwards Compatibility

- All changes to `ArtifactType` are **additive** — existing `'custom'` values still work
- `Artifact` interface additions (`sessionId`, `userId`, `scope`) are **optional** — existing code compiles unchanged
- `ArtifactStore` gets `update()` — existing stores that don't implement it will get a TS error only when the method is called; `createInMemoryArtifactStore` will implement it
- `inferMimeType` behaviour for existing types is **unchanged** (image still maps to `image/png` unless `detectImageMime` is called explicitly)

### Migration Path for geneWeave

1. Run `m77-artifacts.ts` on startup (auto via migration runner)
2. `ChatEngine` constructor wires `emit_artifact` tool with `db.saveArtifact`
3. Existing chats are unaffected — no artifacts will be backfilled
4. New chats produce artifacts when agents call `emit_artifact`

---

## 8. Sources

- [Claude Artifacts Help Center — Anthropic](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- [Claude Live Artifacts Guide — Eigent](https://www.eigent.ai/blog/claude-live-artifacts-guide)
- [Claude Code Artifacts Enterprise Update — VentureBeat](https://venturebeat.com/data/anthropics-claude-code-artifacts-update-brings-live-shared-dashboards-and-interactive-workspaces-to-enterprises)
- [Claude Artifacts Complete Guide (April 2026) — ShareDuo](https://www.shareduo.com/blog/claude-artifacts)
- [Claude Artifacts: What It Builds & Where It Breaks — p0stman](https://p0stman.com/guides/claude-artifacts-limitations)
- [Artifact Component API — AI SDK Elements](https://elements.ai-sdk.dev/components/artifact)
- [AI SDK Structured Streaming Artifacts — ai-sdk-tools.dev](https://ai-sdk-tools.dev/artifacts)
- [Artifacts — Google Agent Development Kit (ADK)](https://irbox.github.io/adk-docs/artifacts/)
- [Cloudflare Artifacts: Versioned Storage That Speaks Git](https://blog.cloudflare.com/artifacts-git-for-agents-beta/)
- [Cloudflare Artifacts Product Page](https://www.cloudflare.com/products/artifacts/)
- [Artifacts — LibreChat (Generative UI)](https://www.librechat.ai/docs/features/artifacts)
- [Open Source AI Artifacts — Vercel Templates](https://vercel.com/templates/next.js/open-source-ai-artifacts)
- [AI SDK 6 — Vercel Blog](https://vercel.com/blog/ai-sdk-6)
- [Claude Artifacts Features 2026 — Suprmind](https://suprmind.ai/hub/claude/features/)
