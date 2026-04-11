/**
 * @weaveintel/devtools — Migration helpers
 *
 * Helpers for upgrading between weaveIntel versions.
 */

export interface MigrationStep {
  version: string;
  description: string;
  breaking: boolean;
  before: string;
  after: string;
}

export interface MigrationPlan {
  from: string;
  to: string;
  steps: MigrationStep[];
  breakingChanges: number;
  totalSteps: number;
}

/**
 * Generate a migration plan between two semantic versions.
 */
export function planMigration(from: string, to: string): MigrationPlan {
  const applicable = MIGRATIONS.filter(
    (m) => compareVersions(m.version, from) > 0 && compareVersions(m.version, to) <= 0,
  );

  return {
    from,
    to,
    steps: applicable,
    breakingChanges: applicable.filter((s) => s.breaking).length,
    totalSteps: applicable.length,
  };
}

/**
 * Format a migration plan as human-readable text.
 */
export function formatMigrationPlan(plan: MigrationPlan): string {
  const lines: string[] = [];
  lines.push(`Migration plan: ${plan.from} → ${plan.to}`);
  lines.push(`${plan.totalSteps} step(s), ${plan.breakingChanges} breaking change(s)`);
  lines.push('');

  for (const step of plan.steps) {
    const flag = step.breaking ? '[BREAKING] ' : '';
    lines.push(`${flag}v${step.version}: ${step.description}`);
    lines.push(`  Before: ${step.before}`);
    lines.push(`  After:  ${step.after}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Simple semver comparison ────────────────────────────────

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

// ─── Known migrations ────────────────────────────────────────

const MIGRATIONS: MigrationStep[] = [
  {
    version: '0.1.0',
    description: 'Initial release — no migration needed',
    breaking: false,
    before: 'N/A',
    after: 'N/A',
  },
  {
    version: '0.2.0',
    description: 'Renamed weaveModel() to the Models package entry',
    breaking: true,
    before: "import { weaveModel } from '@weaveintel/core'",
    after: "import { weaveModelRouter } from '@weaveintel/models'",
  },
  {
    version: '0.3.0',
    description: 'Added verbatimModuleSyntax — use import type for type-only imports',
    breaking: true,
    before: "import { Agent } from '@weaveintel/core'",
    after: "import type { Agent } from '@weaveintel/core'",
  },
];
