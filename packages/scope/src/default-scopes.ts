/**
 * @weaveintel/scope — default-scopes.ts
 *
 * Built-in scope definitions and cross-scope policies for weaveIntel.
 *
 * This module defines the WEAVEINTEL_DEFAULT_SCOPES and WEAVEINTEL_DEFAULT_POLICIES
 * that ship with every host-application deployment. They can be extended (or overridden
 * by tenant-specific policies) but these defaults cover the standard skill taxonomy.
 *
 * Scope Topology:
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  system  (orchestration — top-level supervisor scope)   │
 *   └──────────────┬──────────────────────────────────────────┘
 *                  │ can delegate to any scope
 *                  ▼
 *   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
 *   │analytics │  │  kaggle  │  │   code   │  │ browser  │  │  voice   │
 *   │          │  │          │  │          │  │          │  │          │
 *   │ data     │  │ competi- │  │ code-    │  │ browser- │  │ voice-   │
 *   │ pipeline │  │ tion ML  │  │ execution│  │ automat. │  │ interact.│
 *   │ research │  │ playbook │  │ code-    │  │ computer │  │          │
 *   │ document │  │ mesh     │  │ review   │  │ -use     │  │          │
 *   └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘
 *        │              │                            │
 *        │ A2A only     │ A2A only                   │ A2A only
 *        ▼              ▼                            ▼
 *   ┌──────────┐   analytics can NEVER delegate     memory
 *   │  code    │   directly to kaggle — this is     retrieval
 *   │ (for     │   the core isolation boundary       (shared)
 *   │  scripts)│
 *   └──────────┘
 *
 * Key policy rule:
 *   analytics → kaggle: BLOCKED (the core isolation boundary)
 *   kaggle → analytics: allowed via A2A (kaggle can request data interpretation)
 *   system → *:        allowed (supervisor privilege)
 *   * → system:        BLOCKED (confused-deputy protection)
 *
 * Skill → Scope mappings (used in seed data):
 *   system:    general-chat, supervisor-orchestration, ensemble-reasoning, workflow-orchestration
 *   analytics: data-pipeline, research-synthesis, document-intelligence, image-analysis,
 *              hypothesis-validation
 *   kaggle:    (seeded from kaggle live mesh agents, not from a2a_skills directly)
 *   code:      code-execution, code-review
 *   browser:   browser-automation, computer-use
 *   voice:     voice-interaction
 *   memory:    memory-retrieval
 */
import type { AgentScope, ScopeCrossPolicy } from './types.js';

// ── Scope Definitions ─────────────────────────────────────────────────────────

export const WEAVEINTEL_DEFAULT_SCOPES: readonly AgentScope[] = [
  {
    name: 'system',
    displayName: 'System Orchestration',
    description:
      'Core orchestration scope. Hosts supervisor agents, ensemble reasoning, and workflow ' +
      'orchestration. Can delegate to any other scope. Agents here see the full picture and ' +
      'route work to domain specialists.',
    sandboxed: true,
    maxDelegationDepth: 10,
    auditLevel: 'log',
  },
  {
    name: 'analytics',
    displayName: 'Data Analytics',
    description:
      'General business intelligence and data analysis. Hosts data-pipeline, research-synthesis, ' +
      'document-intelligence, and related skills. This is the right scope for questions like ' +
      '"analyze my sales data", "identify my hero product", or "summarize this report". ' +
      'Deliberately isolated from the Kaggle competition domain.',
    sandboxed: true,
    maxDelegationDepth: 3,
    auditLevel: 'log',
  },
  {
    name: 'kaggle',
    displayName: 'Kaggle Competition',
    description:
      'Competitive ML/data science domain. Hosts the Kaggle competition mesh (9-agent pipeline: ' +
      'discoverer, strategist, implementer, validator, submitter, etc.). This scope is purpose-built ' +
      'for Kaggle competitions and should NOT be activated for general data analysis or business BI. ' +
      'Isolated from analytics by an explicit DENY policy.',
    sandboxed: true,
    maxDelegationDepth: 5,  // Kaggle mesh is a deep pipeline
    auditLevel: 'alert',    // Alert on any cross-scope access into Kaggle
  },
  {
    name: 'code',
    displayName: 'Code Execution',
    description:
      'Sandboxed code execution and review. Hosts code-execution (CSE Python sandbox) and ' +
      'code-review skills. Accessible from analytics and kaggle via A2A for data scripts, ' +
      'model training, and analysis notebooks.',
    sandboxed: true,
    maxDelegationDepth: 2,
    auditLevel: 'log',
  },
  {
    name: 'browser',
    displayName: 'Browser Automation',
    description:
      'Web browsing, Playwright automation, and computer-use. Used for web scraping, ' +
      'UI testing, and general browser tasks. Accessible via A2A when a task genuinely ' +
      'requires external web interaction.',
    sandboxed: true,
    maxDelegationDepth: 2,
    auditLevel: 'log',
  },
  {
    name: 'voice',
    displayName: 'Voice Interaction',
    description:
      'Speech-to-text and text-to-speech pipeline. Isolated because voice turns involve ' +
      'different latency constraints and modality handling than text-based agents.',
    sandboxed: true,
    maxDelegationDepth: 1,
    auditLevel: 'none',
  },
  {
    name: 'memory',
    displayName: 'Memory Retrieval',
    description:
      'Vector-based and episodic memory retrieval. Shared utility scope — most other scopes ' +
      'can read from memory. Writing memory is more restricted (requires analytics or system scope).',
    sandboxed: true,
    maxDelegationDepth: 1,
    auditLevel: 'none',
  },
] as const;

// ── Cross-Scope Policies ──────────────────────────────────────────────────────

export const WEAVEINTEL_DEFAULT_POLICIES: readonly ScopeCrossPolicy[] = [
  // ── system scope: can delegate to ANYTHING ─────────────────────────────────
  {
    fromScope: 'system',
    toScope: '*',
    allowed: true,
    requiresA2A: false,    // system is the supervisor — direct delegation is expected
    maxDelegationDepth: 10,
    auditLevel: 'log',
  },

  // ── analytics → code: allowed (for analysis scripts, ETL notebooks) ────────
  {
    fromScope: 'analytics',
    toScope: 'code',
    allowed: true,
    requiresA2A: true,     // must use A2A so every cross-scope call is logged
    maxDelegationDepth: 2,
    auditLevel: 'log',
  },

  // ── analytics → kaggle: EXPLICITLY DENIED ─────────────────────────────────
  // This is the primary isolation boundary this system was built to enforce.
  // A general "analyze my sales data" request must NOT trigger the Kaggle
  // competition mesh. The domains are completely separate:
  //   - analytics: business BI, sales insights, document analysis
  //   - kaggle: competitive ML competitions with a 9-agent specialized pipeline
  //
  // If a user genuinely wants Kaggle, they must express explicit intent:
  //   "run a Kaggle competition" / "help me with this competition problem"
  // In that case, the SYSTEM scope (supervisor) will activate the kaggle scope
  // directly — analytics never needs to.
  {
    fromScope: 'analytics',
    toScope: 'kaggle',
    allowed: false,
    auditLevel: 'alert',  // Any attempt to cross this boundary raises an alert
  },

  // ── analytics → memory: allowed (read context for analysis) ───────────────
  {
    fromScope: 'analytics',
    toScope: 'memory',
    allowed: true,
    requiresA2A: true,
    maxDelegationDepth: 1,
    auditLevel: 'none',
  },

  // ── analytics → browser: allowed (for web-sourced data) ──────────────────
  {
    fromScope: 'analytics',
    toScope: 'browser',
    allowed: true,
    requiresA2A: true,
    maxDelegationDepth: 1,
    auditLevel: 'log',
  },

  // ── kaggle → code: allowed (model training, kernel execution) ─────────────
  {
    fromScope: 'kaggle',
    toScope: 'code',
    allowed: true,
    requiresA2A: true,
    maxDelegationDepth: 3,  // kaggle pipeline is deep, so allow more hops to code
    auditLevel: 'log',
  },

  // ── kaggle → analytics: allowed via A2A (for result interpretation) ────────
  // A Kaggle agent may want to call the analytics scope to interpret results
  // (e.g. "explain why this model's RMSE improved"). Allowed, but only via A2A
  // so it's explicit and logged. This is NOT a general shortcut — the kaggle
  // agent must explicitly request data interpretation from the analytics scope.
  {
    fromScope: 'kaggle',
    toScope: 'analytics',
    allowed: true,
    requiresA2A: true,
    maxDelegationDepth: 1,  // one hop — no chain: kaggle→analytics→kaggle is not allowed
    auditLevel: 'log',
  },

  // ── kaggle → memory: allowed (store/retrieve competition context) ──────────
  {
    fromScope: 'kaggle',
    toScope: 'memory',
    allowed: true,
    requiresA2A: true,
    maxDelegationDepth: 1,
    auditLevel: 'none',
  },

  // ── kaggle → browser: allowed (for dataset download, leaderboard scraping) ─
  {
    fromScope: 'kaggle',
    toScope: 'browser',
    allowed: true,
    requiresA2A: true,
    maxDelegationDepth: 1,
    auditLevel: 'log',
  },

  // ── code → memory: allowed (lookup docs, store outputs) ───────────────────
  {
    fromScope: 'code',
    toScope: 'memory',
    allowed: true,
    requiresA2A: true,
    maxDelegationDepth: 1,
    auditLevel: 'none',
  },

  // ── browser → analytics: allowed (send scraped data for analysis) ──────────
  {
    fromScope: 'browser',
    toScope: 'analytics',
    allowed: true,
    requiresA2A: true,
    maxDelegationDepth: 1,
    auditLevel: 'log',
  },

  // ── memory → *: memory is read-mostly, accessing other scopes is blocked ───
  // Memory agents should not spontaneously call out to other scopes.
  // They answer queries and return results.
  {
    fromScope: 'memory',
    toScope: '*',
    allowed: false,
    auditLevel: 'log',
  },

  // ── voice → system: allowed (voice needs supervisor to route the request) ──
  {
    fromScope: 'voice',
    toScope: 'system',
    allowed: true,
    requiresA2A: false,  // voice→system is the normal entry point for voice messages
    maxDelegationDepth: 1,
    auditLevel: 'none',
  },
] as const;

/**
 * Returns the agentic scope for a given skill ID.
 *
 * This is the canonical mapping used when seeding the database.
 * All skill IDs match the ones in the A2A Skills Taxonomy (packages/skills/src/a2a-skill-catalog.ts).
 */
export const SKILL_SCOPE_MAP: Readonly<Record<string, string>> = {
  // system scope
  'general-chat':            'system',
  'supervisor-orchestration': 'system',
  'ensemble-reasoning':      'system',
  'workflow-orchestration':  'system',

  // analytics scope
  'data-pipeline':           'analytics',
  'research-synthesis':      'analytics',
  'document-intelligence':   'analytics',
  'image-analysis':          'analytics',
  'hypothesis-validation':   'analytics',

  // code scope
  'code-execution':          'code',
  'code-review':             'code',

  // browser scope
  'browser-automation':      'browser',
  'computer-use':            'browser',

  // voice scope
  'voice-interaction':       'voice',

  // memory scope
  'memory-retrieval':        'memory',

  // image-generation: no dedicated scope (infrastructure-dependent)
  'image-generation':        'system',
};

/**
 * Returns the scope name for a given skill ID.
 * Falls back to 'system' (most permissive) if the skill is not in the map.
 */
export function getScopeForSkill(skillId: string): string {
  return SKILL_SCOPE_MAP[skillId] ?? 'system';
}
