import type { CapabilityPack } from './manifest.js';

export interface PackValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface PackValidationResult {
  ok: boolean;
  issues: PackValidationIssue[];
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const KEY_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

/**
 * Static structural validation of a `CapabilityPack`. Does NOT run install
 * preconditions against a live target — that happens inside `installPack`.
 *
 * Checks performed:
 *  - manifestVersion === '1'
 *  - key matches `lower.dotted.snake_case`
 *  - version is semver
 *  - name and description present
 *  - contents is a Record of arrays
 *  - every row has a stable id (string), so the ledger can track it
 *  - no duplicate ids within a content kind
 */
export function validateManifest(pack: CapabilityPack): PackValidationResult {
  const issues: PackValidationIssue[] = [];
  const err = (path: string, message: string) => issues.push({ severity: 'error', path, message });

  if (pack.manifestVersion !== '1') {
    err('manifestVersion', `unsupported manifest version: ${String(pack.manifestVersion)}`);
  }
  if (!pack.key || !KEY_RE.test(pack.key)) {
    err('key', `invalid pack key: ${JSON.stringify(pack.key)} (expected lower.dotted.snake_case)`);
  }
  if (!pack.version || !SEMVER_RE.test(pack.version)) {
    err('version', `invalid semver: ${JSON.stringify(pack.version)}`);
  }
  if (!pack.name || pack.name.trim().length === 0) {
    err('name', 'name is required');
  }
  if (!pack.description || pack.description.trim().length === 0) {
    err('description', 'description is required');
  }

  if (!pack.contents || typeof pack.contents !== 'object' || Array.isArray(pack.contents)) {
    err('contents', 'contents must be an object of {kind: row[]} buckets');
    return { ok: false, issues };
  }

  for (const [kind, rows] of Object.entries(pack.contents)) {
    if (!Array.isArray(rows)) {
      err(`contents.${kind}`, 'bucket must be an array');
      continue;
    }
    const seenIds = new Set<string>();
    rows.forEach((row, idx) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        err(`contents.${kind}[${idx}]`, 'row must be an object');
        return;
      }
      const id = (row as Record<string, unknown>)['id'];
      if (typeof id !== 'string' || id.length === 0) {
        err(`contents.${kind}[${idx}].id`, 'row must have a string id');
        return;
      }
      if (seenIds.has(id)) {
        err(`contents.${kind}[${idx}].id`, `duplicate id within bucket: ${id}`);
      }
      seenIds.add(id);
    });
  }

  if (pack.dependencies) {
    pack.dependencies.forEach((dep, idx) => {
      if (!dep.packKey || !KEY_RE.test(dep.packKey)) {
        err(`dependencies[${idx}].packKey`, `invalid dependency packKey: ${dep.packKey}`);
      }
      if (!dep.versionRange) {
        err(`dependencies[${idx}].versionRange`, 'versionRange is required');
      }
    });
  }

  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}

export class PackValidationError extends Error {
  readonly issues: PackValidationIssue[];
  constructor(issues: PackValidationIssue[]) {
    super(`capability pack validation failed: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'PackValidationError';
    this.issues = issues;
  }
}
