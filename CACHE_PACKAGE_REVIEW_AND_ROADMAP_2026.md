# `@weaveintel/cache` — Code Review, Mid‑2026 Gap Analysis & Phased Roadmap

**Status:** Draft for review · **Date:** 2026‑06‑23 · **Author:** engineering review
**Scope:** `packages/cache/*`, its consumers in `apps/geneweave`, and the database‑level
configuration that drives it. Includes a research‑backed gap analysis against the state of
the art in agentic‑AI caching as of mid‑2026 and a package‑first, reuse‑oriented implementation plan.

---

## 0. Executive summary

`@weaveintel/cache` is a small, clean, well‑typed package that implements **five** primitives
behind the `@weaveintel/core` cache contracts: an in‑memory `CacheStore`, an embedding
`SemanticCache`, a `CachePolicy` model, a deterministic `CacheKeyBuilder`, and an
invalidation rule engine. The code is readable and tested at the unit level.

However, **as integrated into geneWeave today it delivers only one of its five capabilities** —
exact‑match response caching in the chat path — and several of the primitives are either
**dead code, mis‑wired, or unenforced**:

| Primitive | Implemented in package | Wired in geneWeave | Notes |
|---|---|---|---|
| Exact‑match `CacheStore` | ✅ | ✅ (chat) | In‑process only; `max_entries` **never enforced** (unbounded growth). |
| `SemanticCache` | ✅ | ❌ **dead** | Never passed to `createRuntimeCacheAdapter`; the seeded "Semantic Query Cache" policy does nothing. |
| `CachePolicy` / `resolvePolicy` | ✅ | ⚠️ partial | Resolution ignores request scope → "scope" is decorative (see F‑1). |
| Invalidation engine | ✅ | ❌ **dead** | `invalidate_on` events stored in DB but no event bus calls `applyInvalidation`. |
| `semanticGet` adapter | ⚠️ broken | ❌ | Keys on `JSON.stringify(embedding.slice(0,8))` — can never match a stored query. |

Against the mid‑2026 state of the art the package is missing the highest‑leverage modern
techniques entirely: **provider‑native prompt caching** (the ~90 % input‑token discount —
supported in `provider-anthropic` but never reached from the chat path), **multi‑tier /
distributed (Redis) caching** (the package is in‑process only despite docstrings promising a
"drop‑in Redis replacement"), **tool‑result caching** (named in the package description but not
implemented), **stampede protection**, **cost‑aware eviction**, and **cache observability**.

There are also concrete **security/correctness** issues: raw prompts are stored verbatim in
cache keys (PII + unbounded length + delimiter‑injection collisions), cache keys carry **no
`tenantId`** (multi‑tenant isolation gap), the semantic cache has **no per‑user/tenant
partitioning** (cross‑user answer leakage by design if ever wired), the scope enum in the admin
UI disagrees with the core type, and responses are cached regardless of sampling temperature.

This document reviews the code module‑by‑module, summarizes the mid‑2026 research, enumerates
the gaps/bugs/security issues, and proposes a **package‑first, reusable** phased plan with the
exact **database‑level configuration** (tables, columns, constants, seeds) that should be
tunable without code changes.

---

## Part A — Code review of `packages/cache`

Package layout (`packages/cache/src`):

```
index.ts                    Public API surface
store.ts                    weaveInMemoryCacheStore()   — Map-based TTL KV store
semantic.ts                 weaveSemanticCache()        — cosine-similarity cache
policy.ts                   createCachePolicy / shouldBypass / resolvePolicy
key-builder.ts              weaveCacheKeyBuilder()      — deterministic keys
invalidation.ts             evaluate / apply / applySemantic invalidation
runtime-cache-adapter.ts    createRuntimeCacheAdapter() — RuntimeCacheSlot wrapper
cache.test.ts               unit tests
runtime-cache-adapter.test.ts
```

Contracts live in `packages/core/src/cache.ts` (`CacheStore`, `SemanticCache`, `CachePolicy`,
`CacheScopeType`, `CacheKeyBuilder`, `CacheInvalidationRule`, `CacheScope`) and
`packages/core/src/runtime.ts` (`RuntimeCacheSlot`). Good separation — the package depends
only on `@weaveintel/core` types, so the interfaces are reusable.

### A‑1 `store.ts` — `weaveInMemoryCacheStore()`

A `Map<string, CacheEntry>` with lazy TTL expiry and a `clear(scope?)` that matches either an
entry's `scope` field or a `key.startsWith(scope + ':')` prefix.

Findings:

- **A‑1a (High) — `max_entries` is never enforced.** The store accepts no capacity bound and
  performs no eviction. `set()` ([store.ts:37](packages/cache/src/store.ts#L37)) appends
  unboundedly. The `max_entries` column in `cache_policies` and the `maxEntries` field on
  `CachePolicy` are pure decoration here. Under sustained unique traffic this is an **unbounded
  memory leak / DoS surface**. (Only the *semantic* cache enforces a cap, and only via FIFO.)
- **A‑1b (Med) — `clear(scope)` does not work for app keys.** `set()` never populates the
  optional `scope` field on `CacheEntry`, so scope‑clear depends entirely on the
  `key.startsWith(scope + ':')` branch ([store.ts:64](packages/cache/src/store.ts#L64)). But
  geneWeave keys are namespaced `gw-chat:...` (not `user:` / `tenant:`), so a
  `clear('user')` matches nothing. Scope‑based eviction is effectively inert.
- **A‑1c (Low) — lazy‑only expiry.** Expired entries are only removed on access or `size()`.
  A large set of expired‑but‑untouched keys keeps memory pinned. No periodic sweep / no max age.
- **A‑1d (Low) — no metrics hooks.** No hit/miss counters, no byte accounting, no eviction
  events. Impossible to compute hit rate or cost savings (see Part C §8).

### A‑2 `semantic.ts` — `weaveSemanticCache()`

An array of `{query, embedding, response, cachedAt, metadata}` with a linear cosine‑similarity
scan and FIFO eviction (`entries.shift()`).

Findings:

- **A‑2a (High, latency) — O(n) scan + re‑embed on every `find`.** Each lookup embeds the
  query ([semantic.ts:52](packages/cache/src/semantic.ts#L52)) and linearly scans all entries
  ([semantic.ts:58](packages/cache/src/semantic.ts#L58)). At 1 000 entries this is 1 000 cosine
  computations per request plus an embedding round‑trip. No ANN index, no vector store. Does
  not scale beyond a few hundred entries.
- **A‑2b (High, security) — no scope/tenant/user partitioning.** `find()` searches **all**
  entries globally. If this cache were ever wired into a multi‑tenant chat path, a
  semantically‑similar query from tenant B could return tenant A's cached response. This is the
  documented "semantic‑cache cross‑user leakage" failure mode (Part C §7).
- **A‑2c (Med) — FIFO eviction, not LRU/LFU.** `entries.shift()`
  ([semantic.ts:82](packages/cache/src/semantic.ts#L82)) evicts the oldest *inserted*, not the
  least *useful*. Hot entries are evicted while cold ones survive.
- **A‑2d (Med) — no TTL on semantic entries.** Unlike the KV store, semantic entries never
  expire by time — only by capacity. A stale answer can be served indefinitely.
- **A‑2e (Med) — hard‑coded `0.95` invalidation radius.**
  [semantic.ts:98](packages/cache/src/semantic.ts#L98) buries a magic threshold; not policy‑
  or DB‑configurable.
- **A‑2f (Low) — no persistence.** Cache is lost on restart; cold start every deploy.

### A‑3 `policy.ts` — `createCachePolicy` / `shouldBypass` / `resolvePolicy`

Findings:

- **A‑3a (Med, correctness) — `resolvePolicy` ignores per‑request scope context.** When called
  with an empty context (which is exactly how geneWeave calls it — see F‑1) it returns the
  single highest‑priority *enabled* policy across the whole system
  ([policy.ts:78](packages/cache/src/policy.ts#L78)). It does not select a policy *matching the
  current request's tenant/user/session*. "Scope" therefore behaves as a global priority knob,
  not isolation.
- **A‑3b (Med, security) — `shouldBypass` only inspects the input.** Bypass patterns
  ([policy.ts:41](packages/cache/src/policy.ts#L41)) protect against caching when the *prompt*
  matches `password|secret|token|key`, but a benign prompt that yields a **sensitive response**
  is cached and later served. There is no output‑side bypass.
- **A‑3c (Low, security) — admin regex compiled untrusted.** `new RegExp(pat, 'i')` on each
  request is a **ReDoS** vector if an admin enters a catastrophic pattern. Trust boundary is
  admin‑only, but the per‑request compile is also wasteful (no compiled‑regex cache).

### A‑4 `key-builder.ts` — `weaveCacheKeyBuilder()`

Builds keys by sorting parts and joining `k=v` pairs with a separator.

Findings:

- **A‑4a (High, security/perf) — raw values, no hashing.** geneWeave builds the key as
  `{model, prompt, userId}` ([chat-send-message.ts:458](apps/geneweave/src/chat-send-message.ts#L458)),
  so the **entire user prompt is embedded verbatim in the cache key**. Consequences:
  (1) **PII in keys** — keys leak into logs, Redis `KEYS`/`SCAN` output, and metrics labels;
  (2) **unbounded key length** — multi‑KB prompts become multi‑KB keys;
  (3) **delimiter injection / collisions** — a prompt containing the separator `:` or `=`
  corrupts `parse()` ([key-builder.ts:28](packages/cache/src/key-builder.ts#L28)) and can collide
  distinct inputs. Keys should be salted **SHA‑256** of the canonicalized parts.
- **A‑4b (Med) — no versioning.** Keys carry no embedding‑model version, prompt‑template
  version, or schema version. A model/template upgrade silently serves stale entries (Part C §9).

### A‑5 `invalidation.ts`

A clean rule engine: `evaluateInvalidationRules` (event‑type + payload‑regex match) →
`applyInvalidation` (scope clear / key delete) / `applySemanticInvalidation` (query / clearAll).

Findings:

- **A‑5a (High) — never invoked anywhere in the app.** No event bus, scheduler, or admin
  action calls these functions. `invalidate_on` arrays (`model_change`, `prompt_update`,
  `session_end`, `knowledge_update`, `preference_change`) seeded in the DB
  ([db-sqlite.ts:6167](apps/geneweave/src/db-sqlite.ts#L6167)) are inert. After a model or
  prompt change the chat cache continues to serve stale answers until TTL.
- **A‑5b (Med) — `applyInvalidation` treats `keyPattern` as an exact key.** It calls
  `store.delete(keyPattern)` ([invalidation.ts:61](packages/cache/src/invalidation.ts#L61)) —
  a single exact delete, not a pattern/prefix scan. The name promises pattern semantics the
  `CacheStore` interface can't express (no `deleteByPrefix`).

### A‑6 `runtime-cache-adapter.ts` — `createRuntimeCacheAdapter()`

Wraps a `CacheStore` (+ optional `SemanticCache`) into the `RuntimeCacheSlot` consumed by
`weaveRuntime({ cache })`.

Findings:

- **A‑6a (High) — `semanticGet` is broken by construction.** It builds
  `embeddingKey = JSON.stringify(embedding.slice(0, 8))` and calls
  `semanticCache.find(embeddingKey, …)` ([runtime-cache-adapter.ts:44](packages/cache/src/runtime-cache-adapter.ts#L44)).
  `SemanticCache.find` **re‑embeds that JSON string** and compares it to stored *query*
  embeddings — so it can never match a real cached query. The method's own comment concedes it
  is "best‑effort." In practice the runtime's `semanticGet` is non‑functional. The contract
  mismatch is structural: `RuntimeCacheSlot.semanticGet(embedding[])` is embedding‑first, but
  `SemanticCache` is query‑string‑first.
- **A‑6b (Med) — geneWeave never passes a semantic cache.**
  `createRuntimeCacheAdapter(sharedCacheStore)` ([index.ts:404](apps/geneweave/src/index.ts#L404))
  omits the second argument, so `semanticStore`/`semanticGet` are always absent.

### A‑7 Tests

`cache.test.ts` / `runtime-cache-adapter.test.ts` cover the happy paths of each primitive in
isolation. Gaps: no eviction/capacity tests (because there's no eviction), no concurrency /
stampede tests, no scope‑isolation tests, no tenant‑leakage tests, no key‑collision/injection
tests, and the integration wiring (semantic, invalidation) is untested because it's unwired.

---

## Part B — How `@weaveintel/cache` is used in geneWeave

### B‑1 Wiring

- **Runtime slot.** `apps/geneweave/src/index.ts:403‑404` constructs one
  `weaveInMemoryCacheStore()` and wraps it with `createRuntimeCacheAdapter(...)` (no semantic
  cache), then passes it to `weaveRuntime({ cache })`. Capability `RuntimeCapabilities.Cache` is
  advertised when present ([runtime.ts:769](packages/core/src/runtime.ts#L769)).
- **ChatEngine.** `chat.ts:289` reuses `config.runtime?.cache?.store ?? weaveInMemoryCacheStore()`
  and builds a `weaveCacheKeyBuilder({ namespace: 'gw-chat' })` ([chat.ts:201](apps/geneweave/src/chat.ts#L201)).
  These are threaded into the send path as `deps.responseCache` / `deps.cacheKeyBuilder`
  ([chat.ts:674‑675](apps/geneweave/src/chat.ts#L674)).

### B‑2 The one live cache path (exact‑match response cache)

`chat-send-message.ts:454‑509`:

1. `allowResponseCache = attachments.length === 0` — never cache multimodal turns.
2. `cachePolicy = await resolveActiveCache(db, settings.mode)` — loads enabled policies from
   `cache_policies` and resolves one ([chat-routing-utils.ts:240](apps/geneweave/src/chat-routing-utils.ts#L240)).
3. `cacheKey = cacheKeyBuilder.build({ model, prompt: processedContent, userId })`.
4. On a policy hit and `!shouldBypass`, `responseCache.get(cacheKey)` → reuse `{content, usage}`.
5. On miss, run the model/agent, then `responseCache.set(cacheKey, {content, usage}, ttlMs)`
   unless the content includes `[Execution guard failure]`.

This is the **only** functioning use of the package. Semantic lookup, invalidation, and scope
isolation are not exercised.

### B‑3 Database‑level configuration today

- **Table `cache_policies`** ([schema-workflows.ts:68](apps/geneweave/src/schema-workflows.ts#L68)):
  `id, name, description, scope, ttl_ms, max_entries, bypass_patterns(JSON), invalidate_on(JSON), enabled`.
- **Seeds** (4 policies) ([db-sqlite.ts:6162](apps/geneweave/src/db-sqlite.ts#L6162)): Global
  Default (5 min, bypass `password|secret|token|key`), Session Short‑Lived (60 s), Semantic
  Query Cache (10 min — **inert, no semantic cache wired**), User Personalised (disabled).
- **Admin CRUD** ([admin/routes/routing.ts:270‑](apps/geneweave/src/admin/routes/routing.ts#L270))
  and admin schema tab ([platform-capability-tabs.ts:427](apps/geneweave/src/admin/schema/platform-capability-tabs.ts#L427)).

### B‑4 Cross‑cutting integration findings

- **F‑1 (High, correctness) — scope resolution is a no‑op.** `resolveActiveCache` passes `{}`
  context and ignores `_mode` ([chat-routing-utils.ts:242,258](apps/geneweave/src/chat-routing-utils.ts#L242)),
  so `resolvePolicy` always returns the single highest‑priority enabled policy regardless of
  the actual tenant/user/session. Enabling the "User Personalised" policy (priority 5) would
  silently apply its 2‑minute TTL to **every** request, including unauthenticated/global ones.
- **F‑2 (High, security) — no `tenantId` in the cache key.** Key is `{model, prompt, userId}`.
  In a multi‑tenant deployment the cache is keyed only by user; there is no tenant boundary in
  the key. Combined with F‑1 (no scope enforcement) the cache cannot actually isolate tenants.
  (Note the recent commit `c95d048 fix(security): admin API multi‑tenant isolation` fixed admin
  APIs — the *response cache* still lacks tenant isolation.)
- **F‑3 (High) — in‑process only; breaks on multi‑replica deploys.** The repo ships
  `fly.toml`, `railway.toml`, `render.yaml`, `docker-compose.yml` — all multi‑instance capable.
  Each replica holds a private cache; the same prompt hits on replica A and misses on replica B,
  so the effective hit rate collapses and behavior is non‑deterministic across instances. The
  store docstring claims a Redis drop‑in exists; **it does not**.
- **F‑4 (Med) — scope enum disagreement.** Core `CacheScopeType = global|tenant|user|session|agent`
  ([core/src/cache.ts:35](packages/core/src/cache.ts#L35)) but the admin UI offers
  `['global','model','prompt','user']` ([platform-capability-tabs.ts:433](apps/geneweave/src/admin/schema/platform-capability-tabs.ts#L433)).
  `model`/`prompt` are invalid (fall through to priority `?? 0` in `resolvePolicy`), and
  `tenant`/`session`/`agent` are unreachable from the UI.
- **F‑5 (Med) — provider prompt caching is supported but unreachable.** `provider-anthropic`
  understands `cache_control` ([anthropic.ts:134,191](packages/provider-anthropic/src/anthropic.ts#L134))
  and surfaces `cache_read/creation_input_tokens` ([anthropic-format.ts:183](packages/provider-anthropic/src/anthropic-format.ts#L183)),
  but the core `ModelRequest` carries no `cacheControl`/breakpoint field and the chat path
  ([chat-send-message.ts:488](apps/geneweave/src/chat-send-message.ts#L488)) never sets one. The
  single highest‑ROI 2026 technique (the ~90 % cached‑input discount) is left on the table.
- **F‑6 (Low) — no determinism guard.** Responses are cached regardless of `temperature`
  ([chat-send-message.ts:493](apps/geneweave/src/chat-send-message.ts#L493)). A creative
  (temperature > 0) answer is frozen and replayed, defeating intended variation.

---

## Part C — Research: agentic‑AI caching, state of the art (mid‑2026)

Condensed from a dedicated web‑research pass; full citations inline. Ten areas.

### C‑1 Provider‑native prompt caching (highest ROI, lowest effort)
Caching is a **prefix match** — any byte change in the prefix invalidates everything after.
- **Anthropic** — explicit `cache_control: {type:'ephemeral', ttl?:'1h'}` markers; render order
  `tools → system → messages`; **5‑min (1.25× write) or 1‑hour (2× write); read = 0.1× (90 % off)**;
  break‑even ~2 requests; min cacheable ≈ **1 024 tokens** (Opus 4.8 / Sonnet 4.6); max 4
  breakpoints, walks back ≤20 blocks. Docs: platform.claude.com/docs/build-with-claude/prompt-caching.
- **OpenAI** — automatic, prefix‑based, min 1 024 tokens then 128‑token increments; 50–90 %
  cached‑input discount; `prompt_cache_key` routing hint; idle TTL 5–10 min (Extended up to 24 h).
- **Gemini** — implicit (75–90 % off, on by default 2.5+) + explicit context caching (storage
  ~$1–4.5 /M‑tok/hr, default 60 min TTL).
- **Best practice:** static content first (system/tools/few‑shot/docs), dynamic last; freeze the
  prefix with deterministic serialization; never interpolate dates/user IDs into the prefix.
  "Don't Break the Cache" (arXiv:2601.06007) reports **45–80 % cost** and **13–31 % TTFT**
  improvement from strategic block control; naive full‑context caching can *raise* latency.

### C‑2 Semantic caching
Embed prompt → ANN search past prompt→response pairs → return if cosine > threshold. A false
hit returns a **wrong/another user's** answer (correctness + security risk).
- **GPTCache** is the canonical OSS framework but is effectively in maintenance mode (last
  release Aug 2024). **vCache** (UC Berkeley, arXiv:2502.03771) is the notable successor:
  *verified* caching with user‑defined error bounds, no static threshold.
- **Thresholds:** start **0.92–0.95**, backtest for >99 % accuracy; the **0.85–0.92** band is
  unreliable (correct/incorrect score distributions overlap). GPT Semantic Cache reports up to
  68.8 % hit / >97 % accuracy at cosine 0.8 on bounded domains.
- **Frameworks 2026:** LangChain `RedisSemanticCache`; **LangGraph node‑level `CachePolicy`**
  (`key_func` + per‑node `ttl`) is the agent‑relevant primitive; Semantic Kernel via a
  prompt‑render filter. Managed: **Redis LangCache**, **Portkey**, **Helicone**, **Cloudflare AI Gateway**.
- **Production reality:** real hit rates cluster **20–45 %** (not 90 %) because 60–70 % of
  production queries are unique; best in FAQ/support/docs.

### C‑3 Tool‑result / function‑call caching
"Cache the tools, not the completions" — the external call is often slower/costlier than the LLM.
Key = `sha256(tool_name + sorted/normalized args)`. **Opt‑in per tool** (`cacheable=true`);
never cache side‑effect tools; per‑tool TTL by source volatility. MCP's 2026‑07 RC adds caching
hints so hosts can prefetch/evict.

### C‑4 Multi‑tier architecture
**L1 (in‑process RAM) + L2 (Redis/distributed) + L3 (durable).** In‑process‑only fails at scale:
low cross‑replica hit rate, memory duplication across replicas, useless under serverless cold
starts. A distributed L2 stores each key once and shares it across replicas. (Foyer/Caffeine/
Ristretto for L1; Redis/Momento for L2.)

### C‑5 Stampede / thundering‑herd protection
**Single‑flight / request coalescing** (concurrent identical requests share one computation) —
*more* important for LLM caches because recompute is expensive. **Stale‑while‑revalidate**
(RFC 5861). **Probabilistic early expiration (XFetch**, VLDB 2015) — lock‑free, provably
optimal. Lock‑based revalidation (`SET NX` + TTL).

### C‑6 Eviction & sizing
LRU/LFU/TTL/size‑based have known failure modes. Modern: **W‑TinyLFU** (Caffeine default),
**ARC**, **S3‑FIFO** (6× throughput vs LRU), **SIEVE**. **Cost‑aware = GDSF**
(`priority ≈ (frequency + fetch_cost)/size` → evict cheap‑to‑recompute first). LLM‑specialized
**RAGCache/PGDSF** (prefix‑aware) → 1.2–4× TTFT.

### C‑7 Security & privacy
- **Cross‑tenant leakage is proven.** "Auditing Prompt Caching in LM APIs" (arXiv:2502.07776,
  ICML 2025) found global cache sharing across users in **7 providers** via timing side‑channels.
  Per‑user caching is the mitigation.
- **Semantic‑cache hijack:** adversarial suffixes collide in embedding space with a benign
  query — 77–81 % injection success at τ=0.8 (arXiv:2601.23088). Locality (hit rate) conflicts
  with collision resistance. Defenses: key salting, perplexity screening, per‑user isolation.
- **OWASP LLM08:2025 "Vector and Embedding Weaknesses"** covers multi‑tenant vector isolation.
- **PII/keys:** hash + salt prompts (SHA‑256); never store raw prompt as key. **Determinism:**
  only cache temperature=0 (and even then ≠ bit‑exact). **GDPR Art. 17:** no major provider
  offers per‑entry cache erasure — a differentiator to build. **Encryption:** treat cache stores
  as databases (`rediss://`, encryption at rest).

### C‑8 Observability
Metrics: hit rate, **token savings** (cache_read vs cache_creation), **cost saved ($)**, latency
saved, per‑policy breakdown. **OTel GenAI semantic conventions** define
`gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_creation.input_tokens` — instrument
to these. L1+L2 stacked ≈ 54 % savings on hot paths.

### C‑9 Invalidation
TTL alone is insufficient for RAG/semantic. **Event‑driven source‑change invalidation**;
**versioned keys** embedding the **embedding‑model version** and **prompt‑template version** (a
silent model upgrade busts the cache); a **global version token** for "invalidate everything";
**tag‑based invalidation** via Redis Sets (works for exact caches, degrades for semantic).

### C‑10 Emerging 2026 patterns
**vLLM Automatic Prefix Caching** (70–90 % hit, 30–50 % throughput; can hurt TTFT at low hit
rates), **SGLang RadixAttention** (up to 6.4× throughput), **LMCache** (tiered KV, TTFT 3.7–6.8×
lower), **prefix‑cache‑aware routing** (llm‑d, AIBrix, Mooncake). Agent‑specific (the new
frontier): **Agentic Plan Caching** (arXiv:2506.14852, NeurIPS 2025 — **−50.31 % cost,
−27.28 % latency** by reusing structured *plan templates*), **KVFlow** (workflow‑aware eviction),
**KVCOMM** (cross‑agent KV reuse >70 %).

---

## Part D — Consolidated gap / issue register

Severity: **P0** ship‑blocking correctness/security · **P1** high‑value · **P2** improvement.

### D‑1 Correctness & wiring bugs
| ID | Sev | Issue | Ref |
|---|---|---|---|
| A‑1a | P0 | `max_entries` never enforced → unbounded in‑memory growth | store.ts:37 |
| F‑1 | P1 | `resolveActiveCache` ignores request scope → scope isolation is a no‑op | chat-routing-utils.ts:240 |
| A‑5a | P1 | Invalidation engine never wired to any event → `invalidate_on` inert | invalidation.ts |
| A‑6a | P1 | `semanticGet` keys on truncated‑embedding JSON → can never match | runtime-cache-adapter.ts:44 |
| A‑6b/B‑2 | P1 | Semantic cache never wired → "Semantic Query Cache" policy is dead | index.ts:404 |
| A‑1b | P2 | `clear(scope)` inert for app keys (scope field unset; wrong prefix) | store.ts:64 |
| F‑4 | P2 | Scope enum mismatch (UI `model/prompt` vs core `tenant/session/agent`) | tabs.ts:433 |
| A‑5b | P2 | `applyInvalidation` keyPattern is exact‑delete, not pattern | invalidation.ts:61 |

### D‑2 Security & privacy
| ID | Sev | Issue | Ref |
|---|---|---|---|
| F‑2 | P0 | No `tenantId` in cache key → multi‑tenant isolation gap | chat-send-message.ts:458 |
| A‑4a | P0 | Raw prompt in cache key → PII in keys/logs + delimiter‑injection collisions; no hashing | key-builder.ts:22 |
| A‑2b | P1 | Semantic cache has no scope/tenant/user partitioning → cross‑user answer leakage if wired | semantic.ts:50 |
| A‑3b | P2 | `shouldBypass` only inspects input, not the response | policy.ts:41 |
| A‑3c | P2 | Admin regex compiled per‑request → ReDoS + waste | policy.ts:45 |
| F‑6 | P2 | No determinism guard — caches temperature>0 responses | chat-send-message.ts:493 |
| — | P2 | No encryption‑at‑rest / TLS story for a future durable store | — |

### D‑3 Missing capabilities vs mid‑2026 SOTA
| ID | Sev | Missing capability | Research |
|---|---|---|---|
| G‑1 | P1 | Provider‑native **prompt caching** orchestration (90 % discount) | C‑1, F‑5 |
| G‑2 | P1 | **Multi‑tier / Redis (L2)** distributed store | C‑4, F‑3 |
| G‑3 | P1 | **Tool‑result caching** (named in package desc, not built) | C‑3 |
| G‑4 | P1 | **Cache observability** (hit rate, token/cost saved, OTel attrs) | C‑8 |
| G‑5 | P2 | **Stampede protection** (single‑flight / SWR / XFetch) | C‑5 |
| G‑6 | P2 | **Eviction policy** (LRU/LFU/W‑TinyLFU/cost‑aware) | C‑6 |
| G‑7 | P2 | **Versioned keys** (embedding‑model + prompt‑template versions) | C‑9 |
| G‑8 | P2 | **Negative caching** (short‑TTL miss/error caching) | C‑2 |
| G‑9 | P2 | **GDPR per‑entry erasure** API | C‑7 |
| G‑10 | P3 | **Agentic plan caching / step caching** | C‑10 |
| G‑11 | P3 | **Embedding cache** (avoid re‑embedding identical text) | C‑2 |

---

## Part E — Phased implementation plan (package‑first & reusable)

Design principle throughout: **all behavior lives behind `@weaveintel/core` interfaces and is
implemented in `@weaveintel/cache` as composable, storage‑agnostic, app‑agnostic adapters.**
geneWeave only *wires and configures* — it adds no caching logic of its own. Anything tunable
goes to the **database** (Part F), not to code. Each phase is independently shippable.

### Phase 0 — Stop the bleeding (P0 correctness/security) — ✅ IMPLEMENTED (2026-06)

**Delivered:**
- **Package** — `weaveInMemoryCacheStore({ maxEntries, maxBytes, evictionPolicy: 'lru'|'lfu'|'fifo', onEvict })`
  (bounded, LRU default, byte cap, expired-prune-before-evict); `weaveCacheKeyBuilder({ hash:'sha256', salt, version })`
  (salted SHA-256, version segment, structural-only `parse()`); `cacheScopeKey({tenantId,userId,scope,...})`
  (always-tenant + always-user isolation); `shouldBypassResponse`, `isCacheableTemperature`; `CachePolicy`
  gains `maxBytes/keyHashing/tenantIsolation/temperatureGate/outputBypassPatterns` with secure `createCachePolicy` defaults.
- **geneWeave** — chat key now `cacheScopeKey(tenant,user) + model + hashed(prompt)`; shared store bounded from DB
  (`index.ts`); determinism gate + response-side secret bypass on write (`chat-send-message.ts`); `cached` flag on the result.
- **DB** — migration `m82` adds `max_bytes/key_hashing/tenant_isolation/cache_temperature_gate/output_bypass_patterns`
  to `cache_policies`; schema + seeds + admin routes + admin tab updated; scope enum fixed to `global|tenant|user|session|agent`;
  secret output-bypass patterns seeded on all policies (defence-in-depth given F-1).
- **Tests** — 30 package unit tests (positive/negative/stress/security), 12 app integration tests, 4 Playwright e2e
  (admin API CRUD, admin UI, real-LLM cache-HIT, real-LLM determinism-gate). All green.

Original plan:


**Package (`@weaveintel/cache`)**
- **Bounded store + eviction.** Extend `weaveInMemoryCacheStore(opts?)` with
  `{ maxEntries, maxBytes, evictionPolicy: 'lru'|'lfu'|'fifo', sweepIntervalMs }`. Default to
  **LRU** with a configurable cap; add an optional periodic sweep for expired keys (fixes A‑1a,
  A‑1c). Keep the `CacheStore` contract unchanged so it stays drop‑in.
- **Hashing/versioned key builder.** Add `weaveCacheKeyBuilder({ hash:'sha256', salt, version })`:
  canonicalize parts → stable JSON → salted SHA‑256 → `ns:version:hash`. Preserve a `parse()`
  that returns only structural segments (never the raw prompt). Fixes A‑4a, A‑4b.
- **Tenant/scope segments as first‑class.** Helper `cacheScopeKey({tenantId,userId,scope})`
  enforced by the builder so isolation can't be forgotten.

**geneWeave**
- Build keys as `{ tenantId, userId(scope‑dependent), model, promptHash, templateVersion }`
  (fixes F‑2). Drop the raw prompt from the key.
- Construct the shared store with an enforced `maxEntries`/`maxBytes` from DB config.
- Add a **determinism guard**: only `set()` when `temperature === 0` (or a policy
  `cache_nondeterministic` opt‑in). Fixes F‑6.
- Output‑side bypass: re‑run `shouldBypass` against the *response* before `set()` (fixes A‑3b).

**Database (Part F‑1)**
- Add `max_bytes`, `cache_temperature_gate`, `key_hashing`, `tenant_isolation` columns to
  `cache_policies`; fix the admin scope enum (F‑4).

**Acceptance:** memory bounded under unique‑traffic load test; no raw prompt in any key/log;
two tenants with identical prompts never share an entry; temperature>0 not cached.

### Phase 1 — Distributed L2 + multi‑tier composite (G‑2, F‑3) — ✅ IMPLEMENTED (2026-06)

**Delivered:**
- **Core** — `ScannableCacheStore` (`keys(prefix)` / `deleteByPrefix`) + `ClosableCacheStore` + `isScannableCacheStore` guard.
- **Package** — `weaveRedisCacheStore({ client | url, keyPrefix })` (distributed L2; node-`redis` via DI or lazy URL; JSON values, `PX` TTL,
  namespaced keys, glob-escaped scope clear) shipped as subpath `@weaveintel/cache/redis`; `weaveTieredCacheStore(l1, l2, { l1TtlMs })`
  (read L1→L2 + back-fill, write-through, fan-out delete/clear, L2-authoritative `deleteByPrefix`/size, `close()`); in-memory store now
  implements `keys`/`deleteByPrefix`.
- **geneWeave** — `index.ts` selects the store from `cache_settings`: when `l2_enabled` + `l2_provider='redis'` + `REDIS_URL`, the shared
  store becomes tiered L1+L2 (else L1 only); `global_version_token` threads into the cache-key version (`ChatEngineConfig.cacheKeyVersion`)
  so an admin bump invalidates every key. **Streaming path now cached** (F-3 follow-up): `streamMessageImpl` resolves the policy, builds the
  same scoped/hashed key as the send path, replays a hit as SSE (`done.cached:true`), and write-throughs after a successful stream under the
  same gates (determinism, output-secret bypass, non-deny, non-empty).
- **DB** — migration `m83` adds the single-row `cache_settings` table (`l2_enabled/l2_provider`, `l1_max_entries/l1_max_bytes/l1_ttl_ms`,
  `key_namespace`, `global_version_token`, `stampede_protection`, `metrics_enabled`) + adapter `getCacheSettings`/`updateCacheSettings` +
  admin `GET/PUT /api/admin/cache-settings`. Redis URL stays in `REDIS_URL` (secret, not in DB).
- **Tests** — 18 package tiered/redis tests (incl. real-Redis cross-instance sharing + glob-escape security), 9 app integration tests
  (cache_settings CRUD, key parity, version bust, tiered sharing, real-Redis), 2 streaming-cache integration tests (mock model: cold-write /
  warm-hit-replay / output-bypass), 3 Playwright e2e (cache_settings API, real-LLM **streaming** cache HIT, streaming determinism gate). All green.

Original plan:

### Phase 1 (original) — Distributed L2 + multi‑tier composite — ~1–2 sprints
**Package**
- New `weaveRedisCacheStore({ url, keyPrefix, tls })` implementing `CacheStore` (uses `SET …
  PX`, `GET`, `DEL`, `SCAN`‑based scope clear, `rediss://` TLS). Ship as a **subpath export**
  `@weaveintel/cache/redis` so apps that don't need Redis don't pull the client.
- New `weaveTieredCacheStore(l1, l2, { writeThrough, l1Ttl })` — read L1→L2, populate L1 on L2
  hit, write‑through on `set`, fan‑out `delete`/`clear`. Implements `CacheStore`, so the runtime
  adapter is unchanged.
- Add `deleteByPrefix(prefix)` / `keys(prefix)` as an **optional** capability interface
  (`ScannableCacheStore`) in core; tiered store and Redis store implement it (enables real
  pattern invalidation → fixes A‑5b).

**geneWeave**
- Choose store from DB/env: `REDIS_URL` present → `weaveTieredCacheStore(inMemory, redis)`;
  else in‑memory. No code path in chat changes — it still talks to `RuntimeCacheSlot`.

**Database (Part F‑2)**
- Global `cache_settings` row: `l2_enabled`, `l2_provider`, `l1_max_entries`, `l1_ttl_ms`,
  `key_namespace`, `global_version_token`. (Connection secrets stay in env, not DB.)

**Acceptance:** two replicas share hits via Redis; killing one replica preserves the warm cache;
prefix invalidation deletes a tenant's entries.

### Phase 2 — Provider‑native prompt caching (G‑1, F‑5) — ✅ IMPLEMENTED (2026-06)

**Delivered (verified end-to-end with a real LLM — OpenAI):**
- **Core** — `ModelRequest.promptCache?: { ttl: '5m'|'1h' }` hint; `TokenUsage.cacheReadTokens` / `cacheWriteTokens`.
- **provider-anthropic** — the previous `body['cache_control']` was a no-op (Anthropic ignores top-level cache_control). Now a real
  `cache_control: ephemeral` breakpoint is placed on the **system content block** (covers tools+system in render order) via
  `applySystemCacheControl`; `cache_read`/`cache_creation` tokens surface in `usage` for both generate and stream (`message_start`).
- **provider-openai** — surfaces `prompt_tokens_details.cached_tokens` → `usage.cacheReadTokens` (chat-completions, responses, and stream).
- **Package** — `planPromptCacheBreakpoints({ systemText, toolsText, estimatedPrefixTokens, minTokens, ttl, enabled, providerSupported })`
  + `estimatePromptTokens` — decides whether the stable prefix is large enough to cache (skips sub-minimum prefixes to avoid wasted writes).
- **geneWeave** — both the **send and stream direct paths** order static-first, compute the plan from the model's policy, set
  `request.promptCache` for Anthropic (explicit) and a stable `prompt_cache_key` for OpenAI (implicit routing affinity), and surface a
  `promptCache: { readTokens, writeTokens, applied, ttl }` field on the send result and the SSE `done` event. **Bonus fix:** the streaming
  consumer no longer `break`s on `done`, so OpenAI's trailing usage chunk (and its cache tokens) is captured — OpenAI streaming usage was
  previously dropped to 0.
- **DB** — migration `m84` adds per-model `prompt_cache_enabled` / `prompt_cache_min_tokens` / `prompt_cache_ttl` to `model_pricing`
  (admin-tunable), surfaced through `loadModelPricing`, the admin `model-pricing` tab, and the PUT route.
- **Seeding** — `createModelPricing` / `upsertModelPricing` now derive a **provider-aware** prompt-cache policy for every seeded model:
  cloud providers (anthropic/openai/google) → enabled, local providers (ollama/llamacpp) → disabled (no provider cache), min 1024, ttl 5m.
  Applies across all seed paths (migration, `seedDefaultData`, `seedFramework`); a pricing **re-sync preserves an operator's tuning**
  (ON CONFLICT does not overwrite the prompt_cache_* columns); `m84` also idempotently disables caching on existing local-model rows.
- **Tests** — 11 package planner tests, 7 provider unit tests (breakpoint placement + token surfacing), 11 app integration tests, 2 real-LLM
  provider tests (OpenAI: `cached_tokens > 0` on repeat, 0 for a short prompt), 3 Playwright e2e (admin API + real-LLM prompt-cache reads on
  **both** non-streaming and streaming). All green; observed ~4k cached input tokens read per warm turn.

Original plan:


**Core / providers**
- Add an optional `cacheControl?: {type:'ephemeral'; ttl?: '5m'|'1h'}` (or a `cacheBreakpoints`
  marker) to `ModelRequest` message/system blocks in `@weaveintel/core`.
- `provider-anthropic` already honors `meta.cacheControl` — plumb the new field through;
  add equivalent automatic handling for OpenAI/Gemini (no‑op markers, since implicit).
- New `@weaveintel/cache` helper `planPromptCacheBreakpoints({ system, tools, fewShot })` that
  marks the **stable prefix** (system + tools + few‑shot) with one breakpoint, leaving the
  dynamic user turn uncached — the C‑1 best practice, in one reusable function.

**geneWeave**
- In `chat-send-message.ts`, order the prompt **static‑first** (system/policy prompt, tools,
  retrieved docs) and apply `planPromptCacheBreakpoints` when the provider supports it and the
  stable prefix exceeds the model's minimum (≈1 024 tokens).
- Record `cache_read/creation_input_tokens` (already surfaced by the provider) into the cost
  ledger so the savings are visible.

**Database (Part F‑3)**
- `model_pricing` (or `cache_settings`): per‑model `prompt_cache_min_tokens`,
  `prompt_cache_ttl`, `prompt_cache_enabled`. Tunable without redeploy.

**Acceptance:** repeated chats over a stable system prompt show `cache_read_input_tokens > 0`
and measurable input‑cost reduction.

### Phase 3 — Observability (G‑4) — ✅ IMPLEMENTED (2026-06)

**Delivered (verified end-to-end with a real LLM — OpenAI):**
- **Core** — `CacheMetrics` sink + `CacheStatsSnapshot` interfaces; `RuntimeCacheSlot.metrics?`.
- **Package** — `createCacheMetrics()` (in-process counters: response hits/misses/sets/evictions + prompt-cache read/write tokens +
  est. cost saved, with `snapshot()`/`reset()`); `withMetrics(store, metrics)` — a storage-agnostic decorator that counts every
  response-cache lookup/write and preserves scannable/closable capability; `estimatePromptCacheSavingsUsd(provider, readTokens, inputCost)`
  (provider-aware discount: anthropic 0.9 / openai 0.5 / google 0.75).
- **geneWeave** — `index.ts` wraps the shared store with `withMetrics` and feeds L1 evictions into the sink; the chat path records a
  per-turn outcome (response hit/miss + prompt-cache tokens + cost saved) on **both send and stream** (incl. the streaming hit
  short-circuit) into the live sink AND the durable rollup; admin `GET /api/admin/cache-metrics` returns totals + recent windows + the live
  snapshot; a read-only **Cache Metrics** admin tab (Monitoring group) renders the rollup.
- **DB** — migration `m85` adds the `cache_metrics` hourly rollup table (response_hits/misses, prompt_cache_read/write_tokens,
  cost_saved_usd) with `recordCacheMetrics(delta)` (atomic upsert-increment of the current window) + `getCacheMetrics()` (aggregate +
  windows); flips `cache_settings.metrics_enabled` on by default (admin-tunable; `ChatEngine` respects it).
- **Tests** — 12 package tests (counters, hit-rate, savings, decorator, stress, security/privacy), 6 app integration tests (rollup
  increment/aggregate, negative-clamp, seeded state, streaming cold-miss→warm-hit via mock model), 3 Playwright e2e (real-LLM response
  hit/miss rollup, real-LLM prompt-cache savings in the rollup, admin UI tab). All green.

Original plan:


**Package**
- `CacheMetrics` interface in core (`onHit/onMiss/onSet/onEvict(bytes, latency)`); a
  `withMetrics(store, metrics)` decorator that wraps any `CacheStore`. Emit OTel GenAI attrs
  `gen_ai.usage.cache_read.input_tokens` / `cache_creation.input_tokens`.
- Per‑policy counters (hit rate, token saved, est. cost saved) exposed via a `cacheStats()` API.

**geneWeave**
- Wire `withMetrics` into the shared store; surface a **Cache** admin panel (hit rate, entries,
  bytes, token/cost saved, top keys by namespace — never raw prompts).

**Database (Part F‑4)**
- `cache_metrics` rollup table (optional) for historical hit‑rate/cost‑saved charts.

**Acceptance:** admin dashboard shows live hit rate and cumulative token/cost savings.

### Phase 4 — Semantic cache, done correctly (G‑3 partial, fixes A‑2*, A‑6a) — ✅ IMPLEMENTED (2026-06)

**Delivered (verified end-to-end with REAL OpenAI embeddings):**
- **Core** — redesigned `SemanticCache` with scoped `find(query, {scope, threshold})` / `store(query, response, {scope, ttlMs, metadata})`
  / `invalidate(query, {scope, radius})` / `clear(scope?)` / `size()`; fixed `RuntimeCacheSlot.semanticGet` to be query-first
  (`semanticGet(query, {scope, threshold})` — the old embedding-first form could never match, A‑6a).
- **Package** — rewritten `weaveSemanticCache`: scope partitioning (A‑2b cross-tenant/user isolation), per-entry TTL (A‑2d), **LRU**
  eviction (A‑2c), an **embedding cache** (no re-embedding identical text, G‑11), configurable invalidation radius (A‑2e), and a pluggable
  `VectorIndex` backend (`createInMemoryVectorIndex`; pgvector/Redis adapters can implement the same interface — A‑2a).
- **geneWeave** — builds the semantic cache in `index.ts` from the live `text-embedding-3-small` embedder, gated by `semantic_cache_config`,
  wired via `createRuntimeCacheAdapter(store, semanticCache, metrics)`. On an exact-match miss, **both send and stream** do a scoped semantic
  lookup (`chat-semantic-utils.ts`): a paraphrase hit replays the cached answer (no LLM call; streaming emits `done.semantic:true`); on a real
  miss the answer is stored scoped. Time-sensitive prompts are bypassed; a semantic hit counts in the Phase 3 metrics. The result/SSE carry a
  `semantic` flag.
- **DB** — migration `m86` adds single-row `semantic_cache_config` (embedding_model/version, similarity_threshold 0.92, invalidation_radius,
  max_entries, ttl_ms, scope='user', bypass_patterns, verified_bounds), seeded enabled; admin `GET/PUT /api/admin/semantic-cache-config`
  (PUT resets the chat path's config cache) + an editable admin **Semantic Cache** tab.
- **Tests** — 15 package tests (paraphrase match, scope isolation, threshold, TTL, LRU, embedding cache, invalidation, pluggable index,
  stress), 6 app integration tests (config, scope/bypass helpers, streaming paraphrase hit + cross-user isolation via a deterministic
  embedding), 4 Playwright e2e with **real embeddings** (non-streaming + streaming paraphrase hits, cross-user isolation, admin API + UI). All green.

Original plan:


**Package**
- Redesign `SemanticCache` to be **scoped and pluggable**: `find(query, {scope, threshold})`
  partitions by `tenantId`/`userId` (fixes A‑2b); back it with a vector store interface
  (`VectorIndex`) with adapters for in‑memory (small), **pgvector**, and Redis‑Vector (fixes
  A‑2a). Add **per‑entry TTL** (A‑2d), **LRU/cost‑aware eviction** (A‑2c), and a configurable
  invalidation radius (A‑2e).
- Fix the runtime contract: make `RuntimeCacheSlot.semanticGet` accept `(query, embedding?,
  {scope, threshold})` so the adapter can delegate correctly (fixes A‑6a). Add an
  **embedding cache** so identical text isn't re‑embedded (G‑11).
- Optionally implement **vCache‑style verified bounds** (online per‑prompt threshold) behind a
  flag, given the correctness risk in the 0.85–0.92 band (C‑2).

**geneWeave**
- Wire the semantic cache into `createRuntimeCacheAdapter(store, semanticCache)` and add a
  semantic lookup *before* the model call in the chat path, **scoped to the tenant/user**, gated
  by the "Semantic Query Cache" policy. Bypass for time‑sensitive prompts (already seeded).

**Database (Part F‑5)**
- New `semantic_cache_config`: `embedding_model`, `embedding_version`, `similarity_threshold`,
  `invalidation_radius`, `max_entries`, `ttl_ms`, `scope`, `verified_bounds`, `enabled`.

**Acceptance:** semantically equivalent queries hit; tenant B never receives tenant A's answer;
hit‑rate/accuracy backtested >99 % at the chosen threshold.

### Phase 5 — Event‑driven invalidation + versioning (A‑5a, G‑7) — ✅ IMPLEMENTED (2026-06)

**Delivered (verified end-to-end with a real LLM — OpenAI):**
- **Package** — `createCacheInvalidator({ store, semanticCache?, getRules })` wires the previously-dead engine: `handleEvent(event)` evaluates
  DB rules → `applyInvalidation` / `applySemanticInvalidation`; `invalidate({ all | prefix | scope | semantic })` for manual/GDPR erasure.
  `applyInvalidation` now supports `clearAll` / `prefix` / `prefixFromPayload` / `scope` via `deleteByPrefix`. New `cacheScopeKeyString` returns a
  **visible** scope prefix (`t=<tenant>|u=<user>`) so the exact cache key is `<scopePrefix>||<hash(prompt)>` — the prompt stays hashed (PII-safe)
  while a tenant/user can be invalidated by prefix (A‑5a fix; `CacheInvalidationRule.trigger` widened to `string`).
- **geneWeave** — both send and stream build the scoped + **versioned** key (`_gv` token folded into the hash; bumping `global_version_token`
  invalidates every key at runtime, cached 60s, reset on PUT — G‑7). `index.ts` builds the invalidator over the shared store + semantic cache from
  DB rules. Real triggers emit events: **prompt-template update**, **model-pricing change** (`emitCacheEvent`), **chat delete → session_end**
  (per-user erasure). Admin **`POST /api/admin/cache/invalidate`** (`all` / `tenantId` / `userId` → GDPR erasure of exact + semantic) + full
  `cache-invalidation-rules` CRUD. `semanticScope` aligned to `cacheScopeKeyString` so one scope key clears both caches.
- **DB** — migration `m87` adds `cache_invalidation_rules` (trigger + config JSON), seeded with `model_change` / `prompt_update` /
  `knowledge_update` → clearAll and `session_end` / `preference_change` → per-user prefix; adapter CRUD + an editable admin **Cache Invalidation** tab.
- **Tests** — 11 package tests (direct invalidate, per-user/tenant prefix erasure, event rules incl. payload-scoped, semantic-scope clear, stress),
  5 app integration tests (rules CRUD + streaming GDPR-prefix / version-bump / event-driven invalidation via mock model), 5 Playwright e2e with a
  **real LLM** (invalidate-all, per-user GDPR erasure, version-bump, prompt-update event, rules admin API+UI) — each proving a warm hit → miss. All green.

Original plan:


**Package**
- `createCacheInvalidator(store, semanticCache, rules)` that subscribes to a generic event
  source and runs `evaluateInvalidationRules` → `applyInvalidation` / `applySemanticInvalidation`
  (wires the existing dead engine).
- Versioned keys: bump a `global_version_token` (Part F‑2) to invalidate everything; embed
  `embedding_version` / `template_version` in keys (G‑7).

**geneWeave**
- Emit cache events on the real triggers: model‑pricing change, prompt‑template update, session
  end, knowledge/source update, user‑preference change → invalidator clears the right scope.
- Admin "Invalidate now" button per policy/scope (GDPR erasure foundation, G‑9).

**Database (Part F‑6)**
- New `cache_invalidation_rules` table (`id, name, trigger, pattern, config(JSON), enabled`)
  replacing the overloaded `invalidate_on` JSON; keep back‑compat read.

**Acceptance:** changing a prompt template or model pricing clears the affected entries within
one event cycle; admin can erase a user's cached entries on request.

### Phase 6 — Tool‑result caching (G‑3) — ✅ IMPLEMENTED (2026-06)

**Delivered (verified end-to-end with a real LLM — OpenAI; both send AND stream paths):**
- **Package** — `withToolResultCache(tool, store, { cacheable, ttlMs, keyFn, keyPrefix, metrics, now })` wraps ANY `Tool` so an identical call
  within TTL skips `invoke()` and replays the cached `ToolOutput`. **Opt-in** (`cacheable:false` returns the tool UNCHANGED — side-effecting tools
  are safe by default); **errors are never cached** (no poison); key = `tool-result||<prefix>||sha256(name+canonical(args))` (args hashed, never
  raw — PII-safe) via `buildToolCacheKey`. Reusable from any `@weaveintel/tools-*` package. Exported from `@weaveintel/cache`.
- **geneWeave** — `tool-cache-registry.ts` adds `wrapWithToolResultCache(registry, { store, getPolicy, keyPrefix, metrics })` as the **INNERMOST**
  registry wrapper in `createToolRegistry` (beneath policy-enforcement + scope-guard) so authorization/scope/rate-limit still run on every call while
  only the external `invoke()` is skipped on a hit. Driven by DB `tool_cache_policies` (`loadToolCachePolicies`, 60s cache; `makeToolCachePolicyResolver`).
  Wired via `ChatEngineConfig.toolCache` → `this.toolOptions.toolResultCache`, so it propagates to **every** per-turn registry build — send, stream,
  and workers. Shares the response-cache's underlying store (a global clear / version bump busts tool entries too) with a DEDICATED metrics sink; the
  version token is folded into tool keys. Admin **`tool_cache_policies` CRUD** + a live **`GET /api/admin/tool-cache/stats`** (hits/misses/sets/entries).
- **DB** — migration `m88` adds `tool_cache_policies` (`tool_name, cacheable, ttl_ms, enabled`), seeded for read-only tools
  (`web_search`/`news_search`/`market_data`/`http_request`/`calculator`/`datetime`/`unit_convert`); write/side-effecting tools are intentionally
  NOT seeded so they are never cached. Editable admin **Tool Cache** tab (Infrastructure group).
- **Tests** — 12 package tests (hit replays/skip, arg-order canonicalisation, opt-out passthrough, error-not-cached, distinct args/tools/prefix,
  TTL expiry, key security, stress 1000), 11 app integration tests (seed + CRUD, policy resolution, skip-on-hit through the real registry, disabled/
  no-policy → no caching, error-not-cached, version isolation, stats holder, stress), 4 Playwright e2e with a **real LLM** (agent run caches the
  calculator result → an identical call HITS; streaming path flows through the cached registry; tool-cache-policies admin API/UI). All green.

Original plan:

**Package**
- `withToolResultCache(tool, store, { cacheable, ttlMs, keyFn })` wrapper: key =
  `sha256(toolName + canonical(args))`; **opt‑in `cacheable` per tool**; never cache
  side‑effecting tools. Reusable across any `@weaveintel/tools-*` package.

**geneWeave / tools**
- Mark read‑only tools (`tools-search`, `tools-news`, `tools-marketdata`, `tools-http` GETs)
  `cacheable` with per‑tool TTL; leave write tools uncached.

**Database (Part F‑7)**
- `tool_cache_policies` (`tool_name, cacheable, ttl_ms, enabled`) — per‑tool TTLs tunable in DB.

**Acceptance:** repeated identical tool calls within TTL skip the external call; side‑effect
tools never cached.

### Phase 7 — Stampede protection, cost‑aware eviction, negative caching (G‑5/6/8) — ✅ IMPLEMENTED (2026-06)

**Delivered (verified end-to-end with a real LLM — OpenAI; both send AND stream paths; direct/agent/supervisor modes):**
- **Package** — `createSingleflight()` coalesces N concurrent identical keys into ONE computation (`run(key,fn)` for the send path; `beginOrJoin(key)` leader/follower handshake for the streaming path) with live `stats()` (flights/coalesced/inFlight). `createStampedeCache(store,…)` is a turnkey read-through cache composing singleflight + SWR + XFetch + negative caching behind `getOrCompute`; the SWR/XFetch *algorithms* are exposed as pure helpers (`shouldServeStale`, `shouldEarlyRefresh`) so an app can reuse them over its own (shape-preserving) storage. `weaveInMemoryCacheStore` gains **`tinylfu`** (LFU + LRU tie-break) and cost-aware **`gdsf`** (`H = clock + freq·cost/bytes`, evict cheap/large/cold first) eviction, with a `costOf(value)` weight. All exported from `@weaveintel/cache`; `CachePolicy` gains `swrMs`/`negativeTtlMs`/`evictionPolicy`.
- **geneWeave** — a process-wide singleflight (built in `index.ts`, `cache-stampede.ts` holder) coalesces concurrent identical response-cache misses on **both** the send and stream paths (the model compute is extracted into a `produce()` closure; streaming uses `beginOrJoin` with `res` `finish`/`close` events as a guaranteed-settle net so followers never hang). **Negative caching** (`neg::` marker) shields the backend after a failure; **SWR** serves a stale entry within the window via a sidecar timestamp (both gated, default off → zero behaviour change). The L1 store's eviction strategy is DB-driven (`gdsf` weights by response token count). Gated by `cache_settings.stampede_protection` (enabled by default). Admin **`GET /api/admin/stampede/stats`** + a **Cache Settings** tab + `swr_ms`/`negative_ttl_ms`/`eviction_policy` on the Cache Policies tab.
- **DB** — migration `m89` adds `swr_ms`/`negative_ttl_ms`/`eviction_policy` to `cache_policies` and `l1_eviction_policy`/`l1_negative_ttl_ms` to `cache_settings`, and enables `stampede_protection`.
- **Tests** — 22 package tests (singleflight coalescing/error-recovery/leader-follower, SWR/XFetch/negative `getOrCompute`, all 5 eviction strategies incl. cost-aware gdsf, stress), 11 app integration tests (singleflight coalescing 5→1 across **agent + supervisor** modes via streamMessageImpl, negative caching, SWR serve-stale, eviction store, DB plumbing), 6 Playwright e2e with a **real LLM** (concurrent identical requests collapse to ONE in-flight leader across **direct/agent/supervisor**; cache-settings + cache-policies knobs persist; stats endpoint + Cache Settings UI). All green; full suite (167 pkg + 1650 app) regression-clean.

Original plan:

**Package**
- `singleflight(store)` wrapper coalescing concurrent identical key computations; optional
  **SWR** (serve stale + background refresh) and **XFetch** probabilistic early refresh.
- Pluggable eviction strategies incl. **W‑TinyLFU** and **cost‑aware GDSF** (evict
  cheap‑to‑recompute first, using token cost as weight).
- **Negative caching** helper: short‑TTL caching of misses/errors to shield backends.

**Acceptance:** N concurrent identical requests trigger one model call; load tests show reduced
backend pressure; no negative‑cache poisoning beyond its short TTL.

### Phase 8 (stretch) — Agentic plan/step caching (G‑10) — ✅ IMPLEMENTED (2026-06)

**Delivered (verified end-to-end with a real LLM — OpenAI; supervisor AND agent modes; send + stream paths):**
- **Package (`@weaveintel/agents`)** — `createAgentPlanCache({ semanticCache, threshold, ttlMs, metrics, maxStepChars, maxSteps })` (arXiv:2506.14852): `distill(run, goal)` turns a finished run's `AgentStep[]` into a compact, reusable plan template (ordered `delegate→worker` / `tool:name(args)` / `think` / `respond` descriptors + distinct workers/tools + true step count); `lookup(goal, {scope, threshold})` semantically matches a similar past goal; `renderGuidance(plan)` renders an **advisory** "[Reference plan — ADAPT it to the CURRENT request…]" block; `store(goal, plan, {scope, ttlMs})`. Rides on the existing `SemanticCache` (so "similar task" = "nearby embedding"), storage-agnostic, reusable from any app. Plus `createPlanCacheMetrics`. **Safety:** the plan is GUIDANCE only — the agent still EXECUTES with the new task's params and every tool call re-runs the host's full guardrail/scope/policy pipeline, so a cached plan can never bypass authorization or replay a stale answer; templates are truncated (secret-light) and scope-isolated.
- **geneWeave** — a dedicated **plan** semantic cache (separate partition from the response semantic cache) is built in `index.ts` over the same embedder and gated by `agent_plan_cache_config`. `agent-plan-cache.ts` holds the active cache + DB-driven config (60s cached) + `planScope` + the `planCacheLookupGuidance` / `planCacheStoreFromResult` helpers. `runAgent` AND `streamAgent` (every run/return path) look up a plan for the user's goal, prepend the rendered guidance to the agent goal, and after a **completed, non-trivial** run (≥ `min_steps`) distill + store the plan. Engages only for `agent`/`supervisor` turns (a `direct` turn has no plan). Failed/guardrail-denied runs are never cached. Admin **`GET /api/admin/plan-cache/stats`** + a **Plan Cache** config tab.
- **DB** — migration `m90` adds the single-row `agent_plan_cache_config` (enabled, similarity_threshold, min_steps, max_entries, ttl_ms, scope, embedding_model), seeded enabled.
- **Tests** — 10 package tests (distill/renderGuidance/lookup/store, threshold + scope isolation, non-plan/empty/store-failure negatives, stress), 11 app integration tests (store + reuse-as-guidance across agent + supervisor, config CRUD/loading, mode gating, scope isolation, never-cache-failed/trivial/disabled), 4 Playwright e2e with a **real LLM** (a plan from a `supervisor` and an `agent` task is reused for a similar later task — store → HIT; config persists; stats endpoint + Plan Cache UI). All green; full suite (package + 1661 app) regression-clean.

**Note:** plan matching is intentionally fuzzier than response caching (the plan is advisory, not a replayed answer) — a lower similarity threshold (~0.7) is appropriate because distinct proper nouns drag real-embedding cosine to ~0.75 even for an identical task template.

---

## Part F — Database‑level configuration & constants (tune without code)

Everything an operator might change at runtime belongs in the DB, surfaced through the admin
schema tabs. Below is the target DB surface.

### F‑1 Extend `cache_policies`
Add columns (with `ALTER TABLE … ADD COLUMN` migrations + admin‑tab fields):

| Column | Type | Default | Purpose |
|---|---|---|---|
| `max_bytes` | INTEGER | NULL | Byte cap for the policy's L1 budget (A‑1a). |
| `key_hashing` | TEXT | `'sha256'` | `none`/`sha256` — never store raw prompts (A‑4a). |
| `tenant_isolation` | INTEGER | 1 | Force `tenantId` into the key (F‑2). |
| `cache_temperature_gate` | REAL | 0 | Only cache when `temperature ≤` this (F‑6). |
| `swr_ms` | INTEGER | 0 | Stale‑while‑revalidate window (G‑5). |
| `negative_ttl_ms` | INTEGER | 0 | TTL for cached misses/errors (G‑8). |
| `eviction_policy` | TEXT | `'lru'` | `lru`/`lfu`/`tinylfu`/`gdsf`/`fifo` (G‑6). |
| `output_bypass_patterns` | TEXT(JSON) | `[]` | Bypass on response content (A‑3b). |
| `template_version` | TEXT | `'v1'` | Bust on prompt‑template change (G‑7). |

**Fix the scope enum** in the admin tab to the canonical
`['global','tenant','user','session','agent']` (F‑4) and align `resolvePolicy` priorities.

### F‑2 New `cache_settings` (single global row)
`l2_enabled`, `l2_provider` (`redis`/`none`), `l1_max_entries`, `l1_max_bytes`, `l1_ttl_ms`,
`l1_sweep_ms`, `key_namespace`, `global_version_token` (bump → invalidate all),
`stampede_protection` (bool), `metrics_enabled`. Connection **secrets stay in env** (`REDIS_URL`),
never in the DB.

### F‑3 Provider prompt‑cache constants (in `model_pricing` or `cache_settings`)
Per‑model: `prompt_cache_enabled`, `prompt_cache_min_tokens` (≈1 024), `prompt_cache_ttl`
(`5m`/`1h`). Lets ops turn provider caching on/off and tune breakpoints per model without code.

### F‑4 `cache_metrics` (rollup, optional)
`policy_id, window_start, hits, misses, tokens_saved, cost_saved_usd` for historical dashboards.

### F‑5 `semantic_cache_config`
`embedding_model`, `embedding_version`, `similarity_threshold` (0.92 default),
`invalidation_radius` (0.95), `max_entries`, `ttl_ms`, `scope`, `verified_bounds` (bool), `enabled`.

### F‑6 `cache_invalidation_rules`
`id, name, trigger` (`event|ttl|manual|source-change`), `pattern`, `config(JSON)`, `enabled` —
replaces the overloaded `invalidate_on` JSON (A‑5a) and powers the admin "Invalidate now" action.

### F‑7 `tool_cache_policies`
`tool_name, cacheable, ttl_ms, enabled` — per‑tool result‑cache TTLs (G‑3).

### F‑8 Seed updates
- Wire the existing **"Semantic Query Cache"** seed to real config in `semantic_cache_config`.
- Add a default `cache_settings` row and a default `cache_invalidation_rules` set mirroring the
  current `invalidate_on` events (`model_change`, `prompt_update`, `session_end`,
  `knowledge_update`, `preference_change`).
- Default `tool_cache_policies` for read‑only tools.

---

## Part G — Examples & docs to update

| File | Change |
|---|---|
| [examples/25-semantic-cache.ts](examples/25-semantic-cache.ts) | Add scoped semantic lookup, hashing/versioned keys, eviction, and the corrected `semanticGet`. |
| [examples/147-cache-checkpoint-multimodal.ts](examples/147-cache-checkpoint-multimodal.ts) | Show tiered (L1+L2) store + metrics decorator. |
| [examples/148-weaveagent-full-runtime-e2e.ts](examples/148-weaveagent-full-runtime-e2e.ts) | Wire semantic cache + invalidator into the runtime adapter. |
| [examples/26-advanced-retrieval.ts](examples/26-advanced-retrieval.ts) | Demonstrate RAG source‑change invalidation + versioned keys. |
| New `examples/NN-prompt-caching.ts` | Provider‑native prompt caching breakpoints + cost read‑back (Phase 2). |
| New `examples/NN-tool-result-cache.ts` | `withToolResultCache` opt‑in per tool (Phase 6). |
| [packages/cache/package.json](packages/cache/package.json) | Add `./redis` subpath export; bump version; the description already claims "tool result caching" — make it true. |
| `packages/cache/README` (missing) | Add a package README documenting stores, tiers, semantic, invalidation, security model. |
| Provider docstring [store.ts:4](packages/cache/src/store.ts#L4) | Stop claiming a Redis drop‑in until Phase 1 ships it. |

---

## Part H — Recommended sequencing & rationale

1. **Phase 0** first — these are P0 correctness/security defects (unbounded memory, PII keys,
   missing tenant isolation) that exist *today* and are cheap to fix.
2. **Phase 2 (provider prompt caching)** next — highest ROI/effort ratio: ~90 % input‑token
   discount for a stable‑prefix reorder + one breakpoint, with infra you already have in
   `provider-anthropic`.
3. **Phase 1 (Redis/tiered)** before scaling out replicas — required for any multi‑instance
   deploy (`fly.toml`/`railway`/`render`) to behave correctly.
4. **Phase 3 (observability)** early so every later phase is measurable.
5. **Phases 4–7** in value order; **Phase 8** is research‑grade and optional.

Net effect: the package becomes a genuinely reusable, storage‑agnostic caching layer for *any*
`@weaveintel` app (exact, semantic, tool‑result, provider‑prefix; in‑memory/Redis/tiered; with
stampede protection, cost‑aware eviction, observability, and DB‑driven policy) — and geneWeave
becomes a thin, fully‑wired consumer whose behavior is tuned from the database, not the code.

---

### Appendix — key source references
- Package: `packages/cache/src/{store,semantic,policy,key-builder,invalidation,runtime-cache-adapter}.ts`
- Contracts: `packages/core/src/cache.ts`, `packages/core/src/runtime.ts` (`RuntimeCacheSlot`)
- Consumers: `apps/geneweave/src/chat-send-message.ts` (live path), `chat.ts`, `chat-routing-utils.ts`, `index.ts`
- DB: `apps/geneweave/src/schema-workflows.ts` (`cache_policies`), `db-sqlite.ts` (seeds, CRUD),
  `db-types/admin.ts`, `admin/routes/routing.ts`, `admin/schema/platform-capability-tabs.ts`
- Provider prompt caching: `packages/provider-anthropic/src/{anthropic,anthropic-types,anthropic-format}.ts`
- Research anchors: arXiv 2502.07776 (ICML 2025, cross‑tenant cache leakage), 2506.14852
  (NeurIPS 2025, agentic plan caching), 2502.03771 (vCache), 2601.23088 (semantic‑cache hijack),
  OWASP LLM08:2025, OTel GenAI semantic conventions, provider prompt‑caching docs.
</content>
</invoke>
