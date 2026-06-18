# NIST AI Risk Management Framework (AI RMF 1.0) — WeaveIntel Alignment

> **Status:** Adopted. This document maps WeaveIntel's controls to the four NIST AI RMF core functions: **Govern, Map, Measure, Manage**. It complements the ISO 42001 AIMS document (`iso42001-aims.md`).

---

## Overview

The NIST AI RMF provides a voluntary framework for organizations to address AI risk across the AI system lifecycle. WeaveIntel applies it to the GeneWeave AI pipeline and all dependent packages.

---

## GOVERN — Cultivating a Culture of AI Risk Management

The Govern function establishes the organizational context, accountability structures, and culture for responsible AI.

### GOVERN 1 — Policies, Processes, Procedures, and Practices

**GV-1.1 — AI risk policies are documented and accessible.**

- AI policy: see `iso42001-aims.md` §5.2.
- Encryption policy: `TENANT_ENCRYPTION_DESIGN.md`.
- Data retention: `expiry.ts` (`packages/memory/src/expiry.ts`) — enforces session and user-scoped TTLs.

**GV-1.2 — Roles and responsibilities are defined.**

| Role | AI RMF responsibility |
|---|---|
| AI System Owner (CTO) | Accountable for organizational AI risk posture |
| ML Engineer | AI system design, guardrail configuration, prompt governance |
| Security Engineer | Encryption, key rotation, audit trail |
| Data Engineer | Memory extraction rules, retention, governance |
| Product Lead | Deployment gates; feature-level impact assessments |

**GV-1.3 — Organizational risk tolerance is established.**

Risk tolerance: **conservative**. Any AI output that could trigger an irreversible side effect requires human approval (`tool_approval_requests` table) before execution. Model-graded guardrail checks are required for all user-facing chat completions.

### GOVERN 2 — Accountability

**GV-2.1 — AI risks are owned.**

Each AI subsystem (chat, guardrails, memory, routing, encryption) has a named engineer owner tracked in the internal systems registry.

**GV-2.2 — Teams understand their accountability.**

Engineers complete onboarding on:
- The tool approval flow and its invariants
- Memory governance rules and when new rules are needed
- Incident escalation path for AI-specific failures

### GOVERN 3 — Organizational Teams

Cross-functional AI review is triggered for:
- New LLM provider or model integration
- Changes to guardrail policy (`guardrails` table schema or eval logic)
- New tool with external side effects (network, filesystem, databases)
- New tenant with BYOK/HYOK key management

### GOVERN 4 — Organizational Culture

- AI failures are treated as learning events, not blame events.
- Post-incident reviews are blameless and documented.
- AI design decisions (system prompt changes, model selection, guardrail thresholds) are reviewed in PRs with the `ai-decision` label.

### GOVERN 5 — Organizational Policies in relation to the AI Lifecycle

All AI features must pass:
1. AI system impact assessment (see `iso42001-aims.md` Annex A)
2. Guardrail configuration review
3. Encryption review (for features handling PII)
4. Retention review (for features producing persistent memory)

### GOVERN 6 — Policies and Procedures for AI Risk in the Supply Chain

Third-party LLM providers are assessed on:
- Data residency (do prompts leave the region?)
- Logging/retention policy (does the provider log prompts?)
- Model update notification (do capability changes get announced?)
- Contractual SLA for availability and response consistency

Provider responses are never trusted unconditionally; they are guardrail-evaluated before surfacing to users.

---

## MAP — Categorizing AI Risks in Context

The Map function identifies and frames AI risks in context.

### MAP 1 — AI System Categorization

| Attribute | Value |
|---|---|
| System type | Conversational AI + autonomous agent pipeline |
| Deployment context | Enterprise SaaS, multi-tenant |
| Decision reversibility | Mix: most outputs advisory; tool calls with side effects require approval |
| Affected population | Tenant end users, operators |
| Autonomy level | Semi-autonomous (agents plan and act; irreversible steps require approval) |

### MAP 2 — Scientific Basis and AI Risk Identification

**Known AI risk categories present in WeaveIntel:**

| Risk category | Manifestation | Current mitigations |
|---|---|---|
| Hallucination | Agent produces false facts | Guardrail judge model; trace logging |
| Prompt injection | Malicious user input redirects agent | System prompt separation; guardrail eval |
| Data poisoning | Corrupt memory extraction influences future responses | Memory governance rules; extraction confidence thresholds |
| Model drift | Provider model update changes behavior | Routing regression job (`startRoutingRegressionJob`) |
| Privacy leakage | PII surfaces in completions or memory | Guardrail PII redactor; memory retention enforcement |
| Tool misuse | Agent calls destructive tool without authorization | Tool approval flow; tool policies table |
| Bias | Model outputs reflect training data bias | Moderation model (omni-moderation-latest); eval logging |

### MAP 3 — AI Risks and Benefits

**Benefits:**
- Reduced operator workload via agent automation of research and reasoning tasks.
- Faster knowledge retrieval via semantic memory and entity memory.
- Consistent policy enforcement via guardrails (vs. ad-hoc human review).

**Risks (residual after controls):**
- Occasional hallucination escaping guardrail detection.
- Subtle bias in generated content not caught by moderation.
- Latency of human approval loop introducing friction for time-sensitive tools.

### MAP 4 — Risks from the AI Supply Chain

See Govern 6. The primary supply chain risk is unannounced model capability changes by LLM providers breaking downstream guardrail calibration.

**Mitigation:** `model_capability_scores` table tracks capability signals per model; routing regression job flags anomalies; routing surface items allow rapid fallback.

### MAP 5 — Potential Impacts to People

- **End users:** privacy risk if PII is retained beyond consent. Controlled by `forgetUser`, `forgetSession`, and retention policy enforcement.
- **Third parties:** agent tool calls can affect external systems. Controlled by tool policies and approval flow.
- **Vulnerable populations:** moderation model screens for harmful content; guardrail bias checks are in scope for quarterly review.

---

## MEASURE — Analyzing AI Risks

The Measure function quantifies and evaluates identified risks.

### MEASURE 1 — Metrics for AI Risk

| Metric | Source | Target |
|---|---|---|
| Guardrail false negative rate (harmful content not blocked) | `guardrail_evals` | < 1% |
| Tool approval rejection rate | `tool_approval_requests` | Tracked; no target (operator discretion) |
| Memory PII retention violations | Memory governance audit | Zero |
| DEK rotation SLA adherence | Rotation scheduler tick log | 100% within schedule ± 24h |
| Model capability regression signals | `routing_capability_signals` | Zero unresolved regressions |
| Mean time to detect AI incident | Incident log | < 4 hours |

### MEASURE 2 — Ongoing Evaluation

- **Guardrail evals:** Every chat completion writes a `guardrail_evals` row when a guardrail check runs. These are queryable for rate analysis.
- **Traces:** Every agent turn writes a `traces` row including tool calls, model used, latency, and token counts. Queryable via admin routes.
- **Routing decisions:** `routing_decision_traces` records every routing choice with scorer breakdown. Used for drift detection.
- **Eval results:** `eval_results` table stores per-session quality scores from automated evaluators.

### MEASURE 3 — Testing AI Systems

Testing approach:

| Test type | Scope | Tool |
|---|---|---|
| Unit tests | Individual functions, pure logic | Vitest |
| Integration tests | In-process with real stores | Vitest (e.g., `rotation.test.ts`) |
| Guardrail regression | Adversarial prompt suite | Custom eval runner |
| Routing regression | Capability signal consistency | `startRoutingRegressionJob` |
| Encryption round-trip | Encrypt → rotate → decrypt | `rotation.test.ts` (5.13) |

### MEASURE 4 — Measurement of AI Risk Over Time

- Quarterly review of guardrail false negative trend.
- Monthly review of tool approval rejection patterns (identifies overly permissive tool policies).
- Weekly routing regression scan.
- Annual full AI risk assessment (re-runs MAP 2 risk identification).

---

## MANAGE — Prioritizing and Addressing AI Risks

The Manage function addresses identified and measured risks.

### MANAGE 1 — Responses to AI Risks

**Risk response matrix:**

| Risk level | Response |
|---|---|
| Critical (key compromise, harmful output in production) | Immediate incident response: quarantine, rotate, notify |
| High (guardrail bypass, PII leak) | Same-day fix; rollback if needed |
| Medium (model drift, elevated false negatives) | Fix within sprint; monitor |
| Low (minor bias, non-sensitive hallucination) | Backlog item; quarterly review |

### MANAGE 2 — Risk Treatment Plans

**DEK compromise:**
1. Disable affected tenant's encryption slot.
2. Rotate KEK and DEK immediately via `weaveKekRotator` / `weaveDekRotator`.
3. Trigger ciphertext rewrite scheduler (`rewrite-scheduler.ts`) to re-encrypt all sentinel-bearing rows with new DEK.
4. Audit log all decryption events since compromise window.
5. Notify affected tenant organization.

**Guardrail bypass (confirmed):**
1. Identify the bypass pattern from `guardrail_evals` rows.
2. Add or tighten matching guardrail rule (`guardrails` table).
3. Re-run adversarial eval suite.
4. Deploy to production; monitor false negative rate.

**Prompt injection attack:**
1. Capture the injection payload from `traces` rows.
2. Add injection pattern to system prompt hardening rules.
3. Add rule to guardrail eval pipeline.
4. Consider restricting user-controlled input segments in affected prompt templates.

**Memory PII violation:**
1. Identify the extraction rule that produced the PII entry.
2. Update `memory_extraction_rules` to exclude the field category.
3. Call `forgetUser` or `forgetSession` to remove the violating entries.
4. Review retention policy for the affected memory type.

### MANAGE 3 — Residual Risk

Residual risks after controls are accepted by the AI System Owner with documented rationale:
- Probabilistic outputs may occasionally be incorrect; users are notified that AI outputs should be verified.
- Third-party provider model updates may temporarily degrade guardrail accuracy; the routing regression job provides early warning but cannot prevent the update.

### MANAGE 4 — Risk Monitoring

- Rotation scheduler tick results logged with structured fields via `WeaveLogger` (5.11).
- Guardrail eval results persisted per-session.
- Routing anomalies flagged in `routing_capability_signals`.
- Encryption audit events captured by `CapturingAuditEmitter` (test) and `db-audit-emitter.ts` (production).
- AI incident register maintained as GitHub issues labeled `ai-incident`.

---

## Mapping to WeaveIntel Packages

| NIST AI RMF Function | Primary WeaveIntel implementation |
|---|---|
| Govern — policy | `iso42001-aims.md`, `TENANT_ENCRYPTION_DESIGN.md` |
| Govern — accountability | `tool_approval_requests`, `traces`, `guardrail_evals` tables |
| Map — risk identification | `guardrails` table, `field-policy.ts`, `memory_governance` table |
| Map — supply chain | `model_capability_scores`, `routing_policies`, `provider_tool_adapters` |
| Measure — metrics | `eval_results`, `routing_decision_traces`, `rotation_scheduler` tick log |
| Measure — testing | `rotation.test.ts`, `rotator.test.ts`, `guardrail` unit tests |
| Manage — incident | `db-audit-emitter.ts`, `rewrite-scheduler.ts`, `weaveDekRotator` |
| Manage — monitoring | `WeaveLogger` structured log, `startRoutingRegressionJob` |

---

## Revision History

| Date | Change |
|---|---|
| 2026-06-18 | Initial adoption — Phase 5 DX & Maintainability milestone |
