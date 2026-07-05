# @weaveintel/skills

**Reusable capability bundles an agent discovers and applies on its own — each skill describes when, why, and how to do one kind of task.**

## Why it exists

A capable assistant knows more than facts — they know *procedures*: "when someone asks for a refund, here's how we handle it; here's what 'done' looks like; here's what not to touch." You don't want to re-explain that procedure in every prompt, and you don't want a brittle keyword rule that fires on the wrong request. A skill is that written-down procedure, phrased so the model can recognise when it applies. Think of an onboarding binder full of "how we do X here" cards: the agent flips to the right card when the situation matches, follows it, and checks the result against the card's definition of done. This package is that binder — text-first, semantic (not keyword), with governance and completion contracts baked in.

## When to reach for it

Reach for `@weaveintel/skills` when you have recurring task-shapes you want an agent to recognise and handle consistently — with guidance on execution, output, and what counts as complete. If you instead need concrete callable functions (search, send email, run SQL), those are tools from `@weaveintel/tools`, not skills. A skill often *points at* tools, but it is guidance, not code.

## How to use it

```ts
import { createSkillRegistry, BUILT_IN_SKILLS, applySkillsToPrompt } from '@weaveintel/skills';

const registry = createSkillRegistry();
for (const skill of BUILT_IN_SKILLS) registry.register(skill);

// Match the user's request against registered skills.
const result = await registry.activate('summarise this contract and flag risky clauses');

// Fold the activated skill guidance into the system prompt before the model runs.
const systemPrompt = applySkillsToPrompt('You are a helpful assistant.', result);
```

## Finding the right skill (retrieval)

When you have a handful of skills, matching a request to the right one is easy. When you have hundreds
or thousands, two things get hard: **finding** the right skill even when the user words it differently,
and **not overwhelming the model** by showing it every skill at once. This package gives you three ways
to find candidates, and a router that keeps things cheap at any scale.

- **Lexical (the default, no setup).** Matches on shared words. Fast and exact — great for rare, specific
  terms (a skill id, a product name, a trigger keyword). Its weakness: it can't tell that *"tidy up my
  messy code"* means the same as a *"code quality"* skill, because they share no words.
- **Embedding (meaning-based).** Turns each skill's short "card" (its name, one-line summary, and
  when-to-use) and the user's request into vectors, and matches by *meaning*. Now *"tidy up my messy
  code"* finds the *"code quality"* skill. You bring the embedding model (e.g. from an OpenAI provider),
  so this package stays model-agnostic.
- **Hybrid (recommended).** Runs both and blends the results, so you get the best of each: embeddings
  catch paraphrases, lexical catches exact/rare terms. If the embedding model is unavailable, it quietly
  falls back to lexical — nothing breaks.

```ts
import { hybridSkillRetriever, createSkillRouter, activateSkills } from '@weaveintel/skills';

// You provide the embedder — any function that turns texts into vectors.
const embed = async (texts) => (await myProvider.embed(texts)); // e.g. OpenAI text-embedding-3-small

// Option A — hand a retriever to activateSkills (drop-in; the rest of the pipeline is unchanged):
const result = await activateSkills('help me clean up my messy code', mySkills, {
  retriever: hybridSkillRetriever({ embed }),
});

// Option B — "retrieve then select": fetch a small top-K, then only reason over those K.
// This is what keeps a 5,000-skill catalog as cheap as a 6-skill one — the model never sees the
// whole library, just the few most relevant skills.
const router = createSkillRouter({ retriever: hybridSkillRetriever({ embed }), retrieveK: 8, maxSelected: 3 });
const routed = await router.route('the website is down, help me find out why', mySkills);
```

Nothing changes for existing code: **lexical stays the default**, and the embedding/hybrid path is
opt-in. For very large or multi-tenant catalogs you can back the index with a vector store from
`@weaveintel/retrieval` instead of the built-in in-memory one.

## Composing skills (dependencies & order)

Big tasks usually need **several skills working together in the right order** — "load the data →
analyse it → write the report". If you just hand the model a flat list, it has to guess the order and
might pick skills that clash or that need something that isn't ready yet. `resolveSkillGraph()` turns a
set of chosen skills into a **safe, ordered plan**.

Give a skill a little typed wiring:

```ts
const load    = defineSkill({ id: 'load',    name: 'Data Loader',   summary: 'Load a dataset.',            provides: ['dataset.loaded'] });
const analyze = defineSkill({ id: 'analyze', name: 'Data Analyst',  summary: 'Analyse a dataset.',
  requires: ['load'], precondition: { requires: ['dataset.loaded'] }, provides: ['analysis.done'] });
const report  = defineSkill({ id: 'report',  name: 'Report Writer', summary: 'Write up the findings.',
  requires: ['analyze'], precondition: { requires: ['analysis.done'] } });
```

- **`requires`** — hard dependency. If you pick `report`, the resolver pulls in `analyze` and `load` too.
- **`provides` / `precondition`** — typed inputs and outputs (plain string "capability tokens"). A skill
  only runs once the things it needs are available — either from the context you pass in, or produced by
  an earlier skill. This is what decides the order.
- **`conflictsWith`** — two skills that can't both run (e.g. two report styles); the higher-priority one
  wins and the other is set aside with a reason.
- **`composesWith`** — a soft "these pair well" hint (opt-in, never forced).

```ts
import { resolveSkillGraph } from '@weaveintel/skills';

// You picked just 'report'; the resolver completes and orders the plan:
const plan = resolveSkillGraph([report], [load, analyze, report]);
plan.ordered.map((s) => s.id);   // → ['load', 'analyze', 'report']
plan.added;                       // → ['load', 'analyze']  (pulled in for you)
plan.deferred;                    // skills whose inputs aren't ready yet, with the missing tokens
plan.cycle;                       // set if you accidentally created a loop (A needs B needs A)
```

It's a plain, fast, deterministic function (no model call), and it has two built-in safety rails:
**cycles** ("A needs B needs A") are detected and reported instead of looping forever, and a skill can
only pull in dependencies **at its own privilege level or lower** (`trust`), so a low-trust skill can't
quietly escalate by requiring a powerful one. Runaway dependency fan-out is bounded (`maxSkills`,
`maxDepth`).

## Skill packages (a folder that ships references and runnable scripts)

A skill can be more than a paragraph of advice. In the open **Agent-Skills** format (agentskills.io,
adopted by Claude Code, Cursor, Codex and others) a skill is a *folder* — a `SKILL.md` file plus
optional reference documents and small scripts. That lets a skill carry the exact reference material
*and* the deterministic code to do a job, not just describe it. This package reads that format and
serves it the smart way — **only loading what's needed, when it's needed**:

- **Level 1 — the card.** Just the name and one-line description. Tiny, always visible, so the model
  can tell at a glance whether the skill is relevant.
- **Level 2 — the instructions.** The Markdown body, loaded only once the skill is actually chosen.
- **Level 3 — the files.** Reference documents are opened only when the task calls for them, and
  bundled scripts are **run in a sandbox**, never in your app's process.

```
sales-summary/
├── SKILL.md                     # header (name, description) + instructions
├── references/methodology.md    # opened on demand (Level 3)
└── scripts/summarize.py         # run in a sandbox on demand (Level 3)
```

```ts
import { parseSkillPackage, skillPackageToDefinition, skillFileTools, runSkillScript } from '@weaveintel/skills';

// Your app reads the folder (from disk, a database, or a zip) into a { path: contents } map.
const pkg = parseSkillPackage(files);

skillPackageToDefinition(pkg);   // → a normal SkillDefinition, so it flows through retrieval + composition
```

**Running a bundled script safely.** This package never runs code itself — it hands the script to a
sandbox *you* provide (typically `@weaveintel/sandbox`, which isolates it in a container). You stay in
charge of the isolation policy; the engine enforces safe defaults around whatever sandbox it's given:

- **network is off by default** — a script can't phone home unless the package explicitly declares a
  network tool *and* the caller opts in;
- **no escaping the package** — path traversal (`../`) and absolute paths are rejected;
- **no host execution** — with no sandbox, it refuses to run rather than fall back to your machine;
- **bounded concurrency** — wrap the sandbox with `limitScriptConcurrency` so a burst of script calls
  can't exhaust the host.

```ts
// Adapt your sandbox to the tiny runner seam (this is the whole adapter):
const runner = { run: (spec) => myComputeSandbox.run(spec) };

const result = await runSkillScript({
  pkg, path: 'scripts/summarize.py', runner,
  inputFiles: { 'sales.csv': userUploadedCsv },   // the user's data, placed beside the script
});
result.stdout;  // "revenue=45.00 top=A"

// Or expose the two Level-3 tools to your agent runtime directly:
const tools = skillFileTools(pkg, runner);  // → [read_skill_file, run_skill_script]
```

## Trusting a skill before you run it (security)

A skill you downloaded is *someone else's instructions and code* running inside your agent. In early
2026, public skill registries were poisoned at scale — some of the most-downloaded skills turned out
to be malware, and roughly a third of skills carried a security flaw. So before a package is trusted,
it should be **checked** — and only given the privileges it has earned. This package does both, mapped
to the industry checklist (the OWASP **Agentic Skills Top 10**).

**Trust tiers — a skill only gets what it has earned.**

| Tier | Who | May run scripts? | May reach the network? |
|---|---|---|---|
| **T1** community | anyone (unsigned) | ❌ advice only | ❌ |
| **T2** verified | signed + passes the checks | ✅ (in a sandbox) | ❌ |
| **T3** org-trusted | signed by a publisher you trust | ✅ | ✅ (declared hosts) |
| **T4** first-party | your own skills | ✅ | ✅ |

**Signing — prove it came from who it says, unchanged.** A publisher signs a package; you verify it.
If a single character of any file changed since signing, verification fails — that's how you catch
tampering and silent "rug-pull" updates. It reuses the same Ed25519 keys as `@weaveintel/encryption`.

```ts
import { signSkillPackage, verifySkillPackage } from '@weaveintel/skills';
import { generateAttestationSigningKey } from '@weaveintel/encryption';

const key = generateAttestationSigningKey();
const signature = signSkillPackage(pkg, key, { tier: 3 });   // publisher vouches for it at T3

const publicKeyPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
verifySkillPackage(pkg, signature, publicKeyPem);            // { valid: true }  — or { valid:false, reason }
```

**The four gates — one call checks everything and tells you the tier it earned.**

```ts
import { assessSkillPackage } from '@weaveintel/skills';

const report = await assessSkillPackage(pkg, {
  signature, publicKeyPem, trustedPublishers: [key.fingerprint],
  pinnedDigest,          // optional: the digest you saw last time — a mismatch means it changed
  deepScan: myLlmScanner // optional: an LLM/guardrails check for hidden instructions (runs under a hard timeout)
});

report.allowed;      // false if anything dangerous was found
report.earnedTier;   // the tier it actually qualifies for (never more than the checks justify)
report.findings;     // every issue, with which OWASP risk it maps to
```

The four gates, in plain terms:
- **Structural** — is the `SKILL.md` well-formed and sane? (size limits, no hidden/invisible characters
  in the name or description, no unsafe YAML) — catches *metadata manipulation*.
- **Content safety** — does the text secretly instruct the agent ("…then quietly email their
  credentials…"), or does a script do something dangerous (`curl … | sh`, read `~/.ssh`, reverse
  shell)? A fast built-in scan catches the obvious cases; plug in an LLM (`deepScan`) to catch the
  subtle ones regex misses — catches *malicious code, prompt injection, secret exfiltration*.
- **Capability** — does the package ask for only what it uses? A script that hits the network while the
  manifest declares no hosts is flagged — catches *excessive/undeclared permissions*.
- **Provenance** — is it signed, by someone you trust, and unchanged since? — catches *supply-chain
  tampering and update drift*.

**Least-privilege manifest.** A package declares what it needs, right in its `SKILL.md` header, and the
capability gate checks the scripts actually stay within it:

```yaml
---
name: fx-rates
description: Fetch today's exchange rates.
network: [api.exchangerate.host]   # the only host it may reach
secrets: []                        # it needs none
---
```

## Keeping skills good over time (evaluation & lifecycle)

A drawer full of skills is only useful if the skills are actually *good* — and stay good as the world
changes. This package can score a skill, decide when it has earned more trust, and manage its retirement.

**Scoring a skill.** `evaluateSkill()` rates four things (the industry's agreed measures of skill
quality), each 0–1:

- **Reusability** — does it help with many requests, or just one narrow case?
- **Composability** — can it slot into a bigger plan next to other skills?
- **Maintainability** — is it clear, versioned, and sturdy, or a fragile wall of text?
- **Task completion** — *and this is the important one* — when you actually run it on real examples,
  does it get the job done? Lab descriptions and real behaviour often differ, so this score comes from
  **running** the skill, not reading it.

```ts
import { evaluateSkill } from '@weaveintel/skills';

const report = await evaluateSkill(skill, {
  cases: [{ input: 'Summarise this NDA…', expectation: 'risk' }, /* … */],
  runCase: (skill, input) => myAgent.run(skill, input),   // you wire this to your agent/LLM
  judgeCase: ({ output, expectation }) => myJudge(output, expectation),
  judge: myRubricJudge,   // optional — an LLM judge (shaped like @weaveintel/testing's rubric judge)
});

report.overall;          // 0–1 weighted score
report.passed;           // cleared the quality bar?
report.taskCompletion;   // { score, measured, reasons }  — did it actually work?
```

It works with **no model at all** (fast heuristics), and gets sharper when you plug in a judge and a
way to run the example cases. The judge seam matches `@weaveintel/testing`'s rubric judge, so you can
pass that straight in.

**Earning trust — and not being fooled.** A skill only moves up a trust tier (see the security
section) when its evaluation clears the bar. Crucially, the powerful high tiers need a **human
sign-off too** — so even a perfect (or quietly *gamed*) eval score can't promote a skill into a
dangerous tier on its own.

```ts
import { evaluatePromotion } from '@weaveintel/skills';

const decision = evaluatePromotion({
  currentTier: 1, targetTier: 2, evaluation: report,
  signatureValid: true,     // from the signing check
  humanApproved: false,     // needed for the high tiers
});
decision.decision;  // 'promote' | 'hold' | 'demote'
decision.toTier;    // the tier it's allowed to move to
```

If a later re-evaluation shows the skill got **worse**, promotion turns into automatic **demotion** —
the "step it back down while we fix it" pattern.

**Lifecycle — no dead skills lying around.** Skills move through *draft → active → deprecated →
retired*. Deprecating one keeps it working but points users at a replacement; retiring one turns it off.

```ts
import { deprecateSkill, retireSkill, isSkillUsable } from '@weaveintel/skills';

const dep = deprecateSkill(skill, { reason: 'superseded', replacedBy: 'summarise-contract-v2' });
isSkillUsable(dep);                     // true — still works, but flagged
const gone = retireSkill(skill, 'no longer maintained');
isSkillUsable(gone);                    // false — turned off
```

## Sharing skills with other tools (import / export & MCP)

Skills shouldn't be trapped in one app. The open **Agent-Skills** format (`SKILL.md`) is understood by
many tools — Claude Code, Cursor, Codex and more — so you can bring skills in from the wider community
and send yours back out.

**Import a `SKILL.md` someone else wrote.** Import is deliberately cautious: anything from outside
enters at the **lowest trust tier (T1)** and is run through the full security scan first — it's never
trusted just because you imported it.

```ts
import { importSkillMd } from '@weaveintel/skills';

const { definition, assessment } = await importSkillMd(downloadedSkillMd);
assessment.earnedTier;   // 1 — untrusted on arrival
assessment.allowed;      // did it pass the safety scan?

// Import a whole folder of skills at once; a bad one is reported, not fatal:
import { importSkillMdDirectory } from '@weaveintel/skills';
const { imported, failed } = await importSkillMdDirectory(folders);
```

**Export one of your skills** back out to the standard — a lossless round trip:

```ts
import { exportSkillMd, exportSkillPackage } from '@weaveintel/skills';
exportSkillMd(pkg);        // the SKILL.md text
exportSkillPackage(pkg);   // the whole folder (SKILL.md + references + scripts)
```

**Serve your skills over MCP.** MCP is the wire other agents already speak. Rather than dumping every
skill into a model's context, the bridge lets an agent **search for the skill it needs and pull just
that one** — discovery on demand.

```ts
import { createSkillMcpBridge } from '@weaveintel/skills';
import { handleMcpMessage } from '@weaveintel/mcp-server';

const bridge = createSkillMcpBridge({ skills: myCatalog, retriever: myRetriever });
// bridge is a drop-in set of MCP handlers — feed protocol messages straight to it:
const reply = await handleMcpMessage(incomingJsonRpc, bridge);
```

It exposes three tools any MCP client (Claude Desktop, Cursor, …) can call: `list_skills`,
`search_skills` (finds the few that match a request), and `get_skill` (returns one skill's `SKILL.md`).
Retired skills are automatically hidden.

## Learning new skills from experience (mining, tuning, multimodal)

The most useful skills are often the ones your agent *keeps needing but doesn't have*. When the same
kind of request fails again and again in the same way, that's a missing skill announcing itself.

**Mining a skill from failures.** `mineSkillCandidates()` reads your run history, groups the recurring
failures, and drafts a skill to fix each one.

```ts
import { mineSkillCandidates } from '@weaveintel/skills';

const proposals = await mineSkillCandidates(runHistory, {
  minOccurrences: 3,           // a pattern must recur at least 3 times to be worth a skill
  proposer: myLlmDrafter,      // optional: an LLM writes a good first draft
});
proposals[0].evidence;         // { pattern, occurrences, exampleRequests }
proposals[0].draft;            // a proposed skill — DISABLED, draft, untrusted
```

**The single most important rule: a mined skill can never turn itself on.** Every proposal is created
disabled, at the lowest trust tier, marked `draft`. Turning it on takes a **human sign-off *and* a
passing evaluation** — the one and only path is `approveMinedSkill()`. This matters because a
self-improving agent is a prime target: if a poisoned run trace could mint a live, trusted skill, one
malicious request would compromise everything. So any trace showing signs of prompt-injection is
flagged and never copied into a draft.

```ts
import { approveMinedSkill, evaluateSkill } from '@weaveintel/skills';

// A human reviews and completes the draft, then it's evaluated…
const evaluation = await evaluateSkill(reviewedDraft, { cases, runCase, judgeCase });
const result = approveMinedSkill({ proposal, evaluation, humanApproved: true });
result.approved;   // only true with BOTH a human sign-off and a passing evaluation
result.skill;      // the now-enabled skill (present only when approved)
```

**Tuning what counts as a match.** Over time you learn which retrieved skills actually helped.
`suggestedMinScore()` reads that feedback and suggests a better cut-off, so your search shows fewer
wrong skills:

```ts
import { suggestedMinScore } from '@weaveintel/skills';
const { minScore } = suggestedMinScore(feedbackSamples); // feed this into your retriever
```

**Beyond text.** A skill can declare it works on images, audio, PDFs, tables or code — so the runtime
won't offer an image-only skill for a plain-text request:

```ts
import { skillAcceptsModality, filterSkillsByModality } from '@weaveintel/skills';
filterSkillsByModality(catalog, 'image'); // only the skills that handle images
```

## Benchmarking your skills layer

How do you know your skills setup is actually *good*? `runSkillBenchmark()` scores it the way the
public agent-skill benchmarks do — measuring the **skills layer, not the model** — and prints a
scorecard with those benchmarks' own targets, so a green result means you're performing where the
research says you should be.

```ts
import { runSkillBenchmark } from '@weaveintel/skills';

const result = await runSkillBenchmark({ log: console.log });
result.passed;    // did every capability meet its public-benchmark target?
result.sections;  // the measured numbers, section by section

// Benchmark YOUR OWN skills by passing your catalog + labelled queries (and a real embedder):
await runSkillBenchmark({ catalog: mySkills, queries: myLabelledQueries, embed: myEmbedder });
```

It checks all seven capabilities against targets drawn from public results (SkillRouter / SkillsBench
for retrieval; MalSkillBench / Snyk agent-scan / AgentDojo for security):

| Capability | What's measured | Target (from public benchmarks) |
|---|---|---|
| **Retrieval** | Hit@1, Recall@5/@10, MRR@10, nDCG@10 | Recall@5 ≥ 0.85, MRR@10 ≥ 0.70 |
| **Composition** | ordering, dependency completeness, cycle catch | 100% |
| **Security** | malicious-skill recall, benign false-positives, Attack Success Rate | recall ≥ 0.90 (Snyk: 90–100%), **ASR = 0** (public undefended: 84%+) |
| **Evaluation** | ranks good skills above weak ones | ≥ 0.90 |
| **Interop** | SKILL.md round-trip fidelity, MCP discovery | fidelity 100%, discovery ≥ 0.85 |
| **Mining** | never auto-enables, injection can't mint a skill | 100% |
| **Scale** | retrieval p95 latency + throughput over thousands of skills | p95 < 50 ms |

A runnable version is in [`examples/168-skill-benchmark.ts`](../../examples/168-skill-benchmark.ts) —
`tsx examples/168-skill-benchmark.ts` (offline by default; uses real embeddings if `OPENAI_API_KEY` is
set). On the built-in demo catalog it prints **all targets met**, with retrieval Recall@5 ≈ 0.92
(1.00 with real embeddings), malicious-skill recall 1.00, and Attack Success Rate 0.

### A real-world run

There's also an **extended, real-world dataset** — `buildRealWorldCatalog()` (≈50 skills modelled on
*actual published* Agent Skills: Anthropic's official `pdf`/`docx`/`xlsx`/`pptx`/`skill-creator`/
`mcp-builder`/… plus community skills like Next.js, Terraform, Stripe, Playwright, Semgrep, Notion,
Cloudflare Workers, PostgreSQL) and `REAL_WORLD_QUERIES` (the messy, colloquial way people actually
type: *"my nextjs site feels really sluggish, how do i speed it up"*, *"scan my repo for any passwords
i left in the code"*). Many skills overlap (three security skills; Playwright vs Cypress), so picking
the right one from a vague message is genuinely hard. With real OpenAI embeddings it still clears every
target — **Hit@1 0.88, Recall@5 0.91, MRR@10 0.91, MCP discovery 0.97, malicious recall 1.00, Attack
Success Rate 0**. Run it: [`examples/169-skill-benchmark-realworld.ts`](../../examples/169-skill-benchmark-realworld.ts).

## What's in the box

| Export | What it does |
|---|---|
| `createSkillRegistry` | A registry to `register`, `discover`, `list`, and `activate` skills. |
| `SkillDefinition` (type) | The shape of a skill — `summary`, `whenToUse`, `whenNotToUse`, execution/output/completion guidance, policy, examples. |
| `BUILT_IN_SKILLS` | Ready-made skills you can register as-is. |
| `activateSkills` | Match a query against a set of skills and return the activated set (accepts an optional `retriever`). |
| `lexicalSkillRetriever` / `embeddingSkillRetriever` / `hybridSkillRetriever` | Candidate-finding strategies: word-overlap (default), meaning-based, or both blended. |
| `createSkillRouter` | Retrieve a small top-K then select among them — keeps huge catalogs cheap. |
| `createSkillEmbeddingIndex` | A cached in-memory embedding index over skill cards (re-embeds only what changed). |
| `parseSkillPackage` / `skillPackageToDefinition` | Read a `SKILL.md` folder into a package, and bridge it into a normal `SkillDefinition`. |
| `readSkillFile` / `runSkillScript` | Level-3 access: open a bundled reference file, or run a bundled script in an injected sandbox with safe defaults. |
| `skillFileTools` | The `read_skill_file` + `run_skill_script` tools for an active package, ready to register with your agent runtime. |
| `limitScriptConcurrency` | Wrap a script runner so at most N scripts run at once (the rest queue). |
| `skillCardL1` / `skillBodyL2` / `listSkillFiles` | The three progressive-disclosure levels for a package. |
| `signSkillPackage` / `verifySkillPackage` | Sign a package (Ed25519) and verify it's from the claimed publisher and unchanged. |
| `assessSkillPackage` | Run the four security gates and return what's wrong + the trust tier it earned. |
| `tierPermissions` | What a package installed at tier T1–T4 is allowed to do (scripts / network / secrets). |
| `OWASP_AGENTIC_SKILLS_TOP_10` | The risk-to-gate mapping, so you can see exactly what each check defends against. |
| `evaluateSkill` | Score a skill on reusability / composability / maintainability / task-completion (runs example cases). |
| `evaluatePromotion` | Decide whether a skill moves up, holds, or is demoted a trust tier (eval + signature + human gate). |
| `deprecateSkill` / `retireSkill` / `isSkillUsable` | Manage a skill's lifecycle: point users at a replacement, or turn it off. |
| `lifecycleForEvaluation` | Auto-advance or auto-demote a skill's lifecycle state from its latest evaluation. |
| `importSkillMd` / `importSkillMdDirectory` | Bring in a `SKILL.md` (or a whole folder) — always scanned, always entering untrusted at T1. |
| `exportSkillMd` / `exportSkillPackage` / `skillDefinitionToSkillMd` | Send a skill back out to the open standard (lossless round trip). |
| `createSkillMcpBridge` | Expose your skill catalog over MCP so other agents can search and pull skills on demand. |
| `mineSkillCandidates` | Read run history and propose draft skills for recurring failures (always disabled, untrusted). |
| `approveMinedSkill` | The only path to enable a mined skill — requires a human sign-off AND a passing evaluation. |
| `suggestedMinScore` | Tune the retrieval match cut-off from real feedback (fewer wrong matches over time). |
| `skillAcceptsModality` / `filterSkillsByModality` | Handle multimodal skills (image / audio / PDF / table / code, not just text). |
| `scanTextForInjection` | Check free text (e.g. a run trace) for prompt-injection attempts. |
| `runSkillBenchmark` / `buildDemoCatalog` / `BENCHMARK_TARGETS` | Score a skill catalog against public-benchmark targets and print a scorecard. |
| `resolveSkillGraph` | Turn chosen skills into a safe, ordered plan: pull in dependencies, resolve conflicts, order by readiness, defer what isn't ready. |
| `detectRequiresCycle` | Find a `requires` loop (A→B→A) in a set of skills. |
| `isSkillTerminated` | Check a skill's declared "done" condition (`termination`). |
| `evaluateSkillCompletion` | Check a run's result against a skill's completion contract. |
| `collectSkillTools` | Gather the tools a skill's guidance references. |
| `createSkillTelemetry` | Record which skills fired and how they performed. |
| `buildSkillInvocationPrompt`, `buildSkillSystemPrompt`, `applySkillsToPrompt` | Turn skill guidance into prompt text. |
| `A2A_SKILL_CATALOG`, `SUPERVISOR_V2_WORKERS`, `mapA2ASkillToRow` | The A2A skill taxonomy and DB-seed helpers. |
| `mapSkillToRow` | Seed a skill into a database row. |

## License

MIT.
