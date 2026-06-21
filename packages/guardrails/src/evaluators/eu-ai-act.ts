/**
 * @weaveintel/guardrails — evaluators/eu-ai-act.ts  (Phase 4)
 *
 * LLM-judge evaluators for EU AI Act compliance (mandatory since Aug 2025):
 *
 *   eu-ai-act-high-risk    — Annex III high-risk use case classification
 *   eu-ai-act-manipulation — Art. 5 prohibited manipulation detection
 *   eu-ai-act-transparency — Art. 13 transparency / AI-disclosure check
 *   data-residency-check   — GDPR Art. 44 / US CLOUD Act transfer gate
 *   gdpr-consent-check     — GDPR Art. 6 + Art. 9 special-category gate
 */
import { createLlmJudgeEvaluator } from './llm-judge.js';

// ── EU AI Act: High-Risk Classification ──────────────────────────────────────

const HIGH_RISK_RUBRIC = `You are an EU AI Act compliance specialist. Determine whether the following text indicates the AI is being used for a HIGH-RISK use case as defined in the EU AI Act Annex III. High-risk categories include:

1. Biometric identification or categorisation of natural persons
2. Management of critical infrastructure (water, gas, electricity, road traffic)
3. Educational or vocational training access decisions
4. Employment recruitment or performance evaluation
5. Access to essential private services and public benefits (credit scoring, insurance)
6. Law enforcement decisions or risk profiling
7. Migration, asylum, or border control decisions
8. Administration of justice or democratic processes

Evaluate the INPUT text and output a JSON object with exactly these fields:
- "decision": "allow" if clearly NOT a high-risk use case, "warn" if it suggests or enables a high-risk use case
- "confidence": a number between 0 and 1
- "rationale": one sentence describing which category applies or why it is safe

Output ONLY the JSON object.`;

export const createEuAiActHighRiskEvaluator = () => createLlmJudgeEvaluator(HIGH_RISK_RUBRIC);

// ── EU AI Act: Prohibited Manipulation ───────────────────────────────────────

const MANIPULATION_RUBRIC = `You are an EU AI Act Art. 5 compliance classifier. Detect whether the following text requests or instructs the AI to engage in PROHIBITED MANIPULATION as defined in Article 5(1)(a)–(b) of the EU AI Act:

Prohibited practices include:
1. Subliminal techniques — techniques that influence unconsciously (hidden audio, flash messages, subliminal persuasion patterns)
2. Exploitation of vulnerabilities — targeting age (elderly/children), disability, social/economic status to distort rational decision-making
3. Social scoring of natural persons that leads to detrimental treatment
4. Real-time remote biometric identification in publicly accessible spaces

Output a JSON object with exactly these fields:
- "decision": "allow" if the text is legitimate, "warn" if borderline, "deny" if it clearly requests prohibited manipulation
- "confidence": a number between 0 and 1
- "rationale": one sentence identifying the specific violation or why the text is acceptable

Output ONLY the JSON object.`;

export const createEuAiActManipulationEvaluator = () => createLlmJudgeEvaluator(MANIPULATION_RUBRIC);

// ── EU AI Act: Transparency Disclosure ───────────────────────────────────────

const TRANSPARENCY_RUBRIC = `You are an EU AI Act Art. 13 transparency compliance reviewer. Evaluate whether the following AI-GENERATED OUTPUT appropriately discloses its AI origin when doing so is required.

Disclosure is required when:
1. The AI is generating synthetic text that may be mistaken for human-authored content
2. The AI is summarising or presenting information as factual without mentioning AI authorship
3. The AI is producing persuasive, marketing, or legal content without labelling it as AI-generated

Disclosure is NOT required for:
- Developer tool outputs (code, data transformations, technical documentation)
- When the user has clearly already provided or acknowledged the AI context
- Search result summaries or factual Q&A responses in AI-assistant contexts

Output a JSON object with exactly these fields:
- "decision": "allow" if disclosure is adequate or not required, "warn" if disclosure appears missing where needed
- "confidence": a number between 0 and 1
- "rationale": one sentence explaining the transparency assessment

Output ONLY the JSON object.`;

export const createEuAiActTransparencyEvaluator = () => createLlmJudgeEvaluator(TRANSPARENCY_RUBRIC);

// ── Data Residency ────────────────────────────────────────────────────────────

const DATA_RESIDENCY_RUBRIC = `You are a data residency compliance specialist. Evaluate whether the following text appears to involve processing PERSONAL DATA of individuals in a specific jurisdiction that may violate cross-border transfer restrictions.

Look for indicators of:
1. EU/EEA personal data being sent outside the EU (GDPR Art. 44)
2. Processing of data identifying a specific natural person's location, health, finances, or identity
3. References to data subjects in EU member states without mention of adequate transfer safeguards

Permissible patterns:
- Anonymous or aggregated data
- Public data that does not identify individuals
- Data with explicit consent for cross-border transfer

Output a JSON object with exactly these fields:
- "decision": "allow" if no residency concern, "warn" if borderline, "deny" if clearly involves restricted cross-border personal data transfer
- "confidence": a number between 0 and 1
- "rationale": one sentence explaining the residency concern or clearance

Output ONLY the JSON object.`;

export const createDataResidencyEvaluator = () => createLlmJudgeEvaluator(DATA_RESIDENCY_RUBRIC);

// ── GDPR Consent Gate ─────────────────────────────────────────────────────────

const GDPR_CONSENT_RUBRIC = `You are a GDPR Art. 6 and Art. 9 compliance reviewer. Evaluate whether the following input text involves processing of SPECIAL-CATEGORY personal data under GDPR Article 9:

Special categories requiring explicit consent or legal basis:
1. Health data (medical records, diagnoses, prescriptions, disabilities)
2. Genetic data (DNA, genealogy, hereditary conditions)
3. Biometric data for uniquely identifying persons
4. Political opinions or affiliations
5. Religious or philosophical beliefs
6. Trade union membership
7. Sexual orientation or gender identity
8. Racial or ethnic origin

If special-category data is present, check whether the text indicates:
- An explicit consent statement ("I consent", "with permission", "the patient agreed")
- A legitimate legal basis (public health, legal claims, vital interests)

Output a JSON object with exactly these fields:
- "decision": "allow" if no special-category data or consent/basis is clear, "warn" if special-category data is present without evident consent
- "confidence": a number between 0 and 1
- "rationale": one sentence describing what special-category data was found and whether consent was indicated

Output ONLY the JSON object.`;

export const createGdprConsentEvaluator = () => createLlmJudgeEvaluator(GDPR_CONSENT_RUBRIC);
