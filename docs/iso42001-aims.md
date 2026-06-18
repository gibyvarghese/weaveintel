# ISO/IEC 42001:2023 — AI Management System (AIMS) Alignment

> **Status:** Adopted. This document maps WeaveIntel's existing controls to the ISO 42001 clause structure. Gaps are tracked as issues and linked from each clause entry.

---

## Scope

WeaveIntel operates as an AI-assisted software platform providing conversational agents, multi-tenant workflow orchestration, and autonomous reasoning pipelines. This AIMS covers:

- **GeneWeave server** (core AI pipeline, chat engine, tool execution)
- **Tenant encryption** and data governance
- **Memory and extraction subsystems**
- **Routing and cost governance**
- **Voice and live-agent capabilities**

Exclusions: hardware infrastructure, third-party LLM providers (OpenAI, Anthropic, Google) beyond what is contractually controllable at the API boundary.

---

## Clause 4 — Context of the Organization

### 4.1 Understanding the organization and its context

WeaveIntel provides AI orchestration tooling to enterprise tenants. Internal stakeholders include engineering, product, and security. External stakeholders include tenant organizations, their end users, and regulators.

**AI-specific context factors:**
- Outputs are probabilistic and non-deterministic; accuracy cannot be guaranteed.
- LLMs may produce hallucinated, biased, or harmful content.
- Model capability changes with each provider API update.

### 4.2 Understanding the needs and expectations of interested parties

| Party | Need | WeaveIntel control |
|---|---|---|
| Tenant organizations | Data isolation, auditability | Per-tenant DEK encryption, audit trail |
| End users | Privacy, correction rights | Memory governance, forget/expiry APIs |
| Regulators (GDPR, CCPA) | Data deletion, portability | `forgetUser`, `forgetSession`, purge scheduler |
| Security team | Incident detection | Guardrail eval logging, rotation alerts |

### 4.3 Determining the scope of the AIMS

Scope covers all AI processing performed within the GeneWeave service boundary. Third-party inference providers are scoped as supply chain (Clause 8.4).

### 4.4 AI Management System

The AIMS is documented here. The key management review cadence is quarterly.

---

## Clause 5 — Leadership

### 5.1 Leadership and commitment

- Engineering leadership owns the AI risk register.
- Product reviews AI feature additions against the AIMS policy before launch.

### 5.2 AI Policy

**Policy statement:** WeaveIntel will develop and operate AI systems that are accurate, fair, transparent, privacy-preserving, and controllable. AI outputs must never replace human judgment on irreversible decisions without explicit operator opt-in.

### 5.3 Organizational roles, responsibilities, and authorities

| Role | Responsibility |
|---|---|
| AI System Owner (CTO) | Policy sign-off, risk acceptance |
| Security Engineer | Encryption, audit, incident response |
| ML Engineer | Model selection, prompt governance, guardrails |
| Data Engineer | Memory extraction rules, retention enforcement |

---

## Clause 6 — Planning

### 6.1 Actions to address risks and opportunities

**Risk assessment process:** Risks are scored on likelihood × impact across four domains: accuracy, safety, privacy, security.

| Risk | Likelihood | Impact | Current control |
|---|---|---|---|
| Hallucinated tool calls with destructive effects | Medium | High | Human-in-the-loop tool approval (`tool_approval_requests`) |
| PII leakage in memory | Medium | High | Memory governance rules; `weaveGovernancePolicy` |
| DEK exposure via key compromise | Low | Critical | Envelope encryption; rotation scheduler; KEK rotation |
| Prompt injection from user content | Medium | High | Guardrail eval pipeline (`guardrail_evals`) |
| Bias in model outputs | Medium | Medium | Guardrail moderation model (omni-moderation-latest) |

### 6.2 AI objectives and planning to achieve them

| Objective | Metric | Owner |
|---|---|---|
| < 1% guardrail false-negative rate on harmful content | `eval_results` table | ML Engineer |
| 100% of tenant messages encrypted at rest | Encryption health dashboard | Security |
| DEK rotation within schedule ± 24h | `rotation_scheduler` tick results | Security |
| Memory retention violations: zero | `expiry.ts` enforcement coverage | Data Engineer |

---

## Clause 7 — Support

### 7.1 Resources

- Compute: cloud-hosted LLM inference (provider APIs).
- Storage: SQLite (single-node dev), Postgres (production).
- Tooling: GeneWeave runtime, WeaveIntel SDK packages.

### 7.2 Competence

Engineers operating AI features complete internal training on:
- Prompt injection and defense patterns
- Data retention obligations under GDPR/CCPA
- Incident response for AI-specific failures (hallucination, jailbreak)

### 7.3 Awareness

All contributors are made aware of:
- The AI policy (Clause 5.2)
- The consequence of misconfigured guardrails or retention rules
- How to flag unexpected model behavior (via internal incident channel)

### 7.4 Communication

- External: privacy policy, terms of service, AI-specific disclosures.
- Internal: AIMS review notes shared with engineering team quarterly.

### 7.5 Documented information

This document, plus:
- `TENANT_ENCRYPTION_DESIGN.md` — encryption key lifecycle
- `ENCRYPTION_OBSERVABILITY.md` — audit and metrics
- `SEED_DATA_PLAN.md` — safe test data practices
- `guardrail-conditional-triggers.md` — guardrail trigger logic

---

## Clause 8 — Operation

### 8.1 Operational planning and control

Deployment gates:
1. TypeScript compile check (`tsc --noEmit`)
2. Full unit + integration test suite (`vitest`)
3. Guardrail eval regression test (per-model)
4. Encryption rotation integration test (`rotation.test.ts`)

### 8.2 AI risk assessment

AI risk assessments are triggered by:
- New model provider integration
- New tool with network or filesystem side effects
- New memory extraction rule
- New tenant onboarding with custom KMS

### 8.3 AI system design and development

Key design constraints:
- **Human-in-the-loop:** irreversible tool calls require `tool_approval_requests` row approved by operator.
- **Auditability:** every agent turn writes a `traces` row; every tool call writes `tool_audit_events`.
- **Deterministic tests:** all integration tests use in-memory stores with controlled clocks.

### 8.4 AI supply chain

Third-party LLM providers (OpenAI, Anthropic, Google, Mistral) are treated as supply chain. Controls:
- Provider API keys scoped to minimum required permissions.
- Responses are guardrail-evaluated before being surfaced to users.
- Model capability scores tracked in `model_capability_scores` table.
- Provider outages handled by routing fallback (`routing_policies`).

### 8.5 AI system operation

- Guardrail judge, moderation, and embedding models are resolved at startup; absence is logged and gracefully degraded (checks skip rather than block).
- Memory governance policies are evaluated on every extraction event.
- Retention enforcement runs via `enforceRetention()` in `expiry.ts`.

### 8.6 AI incident management

**Incident types:**
- Harmful output escaping guardrails
- PII in memory store without governance rule
- Unauthorized tool execution (missing approval)
- Key compromise or DEK integrity failure

**Response steps:**
1. Quarantine affected tenant (disable encryption, halt agent)
2. Capture `guardrail_evals` + `traces` rows for the incident window
3. Rotate DEK/KEK if key material is implicated
4. Notify affected users per privacy policy SLA
5. Post-incident review; update risk register

---

## Clause 9 — Performance Evaluation

### 9.1 Monitoring, measurement, analysis, and evaluation

| Metric | Source | Frequency |
|---|---|---|
| Guardrail block rate | `guardrail_evals` table | Continuous |
| Tool approval latency | `tool_approval_requests` | Daily |
| DEK age distribution | `rotation_scheduler` tick log | Hourly |
| Memory extraction coverage | `memory_extraction_events` | Per-session |
| Routing decision accuracy | `routing_decision_traces` | Weekly regression |

### 9.2 Internal audit

Annual internal audit against this document. Findings tracked as GitHub issues labeled `aims-audit`.

### 9.3 Management review

Quarterly review of:
- AI incident log
- Risk register updates
- Objective progress (Clause 6.2)
- Supply chain changes (new providers, model updates)

---

## Clause 10 — Improvement

### 10.1 Nonconformity and corrective action

Nonconformities found in audit or incident review are:
1. Documented with root cause
2. Corrective action assigned with owner and due date
3. Re-tested before closure

### 10.2 Continual improvement

The AIMS is reviewed annually or after any major AI capability addition. This document is version-controlled alongside the codebase.

---

## Annex A — AI System Impact Assessment Template

For each new AI feature, complete before merge:

| Question | Answer |
|---|---|
| What data does this process? | |
| Does it produce irreversible outputs? | |
| What are failure modes? | |
| Is human oversight available? | |
| Which guardrail rules apply? | |
| Which retention rules apply? | |
| Is encryption required? | |
| Supply chain dependencies? | |
