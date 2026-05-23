/**
 * @weaveintel/encryption — alert evaluator (Phase 9).
 *
 * Pure functions over a `MetricsSnapshot` + a list of `AlertRule`s. Returns
 * which rules are firing right now. Hosts persist rules in their own table
 * (geneweave: `tenant_encryption_alert_config`) and call `evaluateAlerts`
 * on a schedule + on demand from the admin dashboard.
 *
 * Reusability: this module knows nothing about SQLite, geneweave, or HTTP.
 * It only consumes the package's metric snapshot shape.
 */

import type {
  MetricName,
  MetricSeriesSnapshot,
  MetricsSnapshot,
} from './metrics.js';

export type AlertRuleKind =
  | 'rotation_overdue'
  | 'kms_error_rate'
  | 'aead_error_rate'
  | 'decrypt_latency_p95'
  | 'cache_hit_rate';

export interface AlertRule {
  readonly id: string;
  readonly tenantId: string | null;
  readonly kind: AlertRuleKind;
  /** Numeric threshold. Units are kind-specific (see `evaluateAlerts`). */
  readonly threshold: number;
  /** Lookback window for rate-based rules (ms). */
  readonly windowMs?: number | null;
  readonly enabled: boolean;
  readonly description?: string | null;
}

export interface AlertFiring {
  readonly ruleId: string;
  readonly tenantId: string | null;
  readonly kind: AlertRuleKind;
  readonly threshold: number;
  readonly observed: number;
  readonly message: string;
  readonly at: number;
}

export interface RotationStatus {
  readonly tenantId: string;
  /** Epoch ms of last DEK rotation (or KEK creation if never rotated). */
  readonly lastRotationAt: number | null;
  /** Configured cadence in days, e.g. 90. */
  readonly cadenceDays: number;
}

export interface EvaluateAlertsInput {
  readonly rules: readonly AlertRule[];
  readonly snapshot: MetricsSnapshot;
  /** Per-tenant rotation status — feeds `rotation_overdue`. */
  readonly rotationStatus?: readonly RotationStatus[];
  readonly now?: number;
}

export function evaluateAlerts(input: EvaluateAlertsInput): AlertFiring[] {
  const now = input.now ?? Date.now();
  const out: AlertFiring[] = [];
  for (const rule of input.rules) {
    if (!rule.enabled) continue;
    const observed = computeObserved(rule, input.snapshot, input.rotationStatus, now);
    if (observed === null) continue;
    if (isFiring(rule.kind, observed, rule.threshold)) {
      out.push({
        ruleId: rule.id,
        tenantId: rule.tenantId,
        kind: rule.kind,
        threshold: rule.threshold,
        observed,
        message: messageFor(rule, observed),
        at: now,
      });
    }
  }
  return out;
}

function computeObserved(
  rule: AlertRule,
  snap: MetricsSnapshot,
  rotation: readonly RotationStatus[] | undefined,
  now: number,
): number | null {
  switch (rule.kind) {
    case 'rotation_overdue': {
      if (!rotation) return null;
      const candidates = rule.tenantId
        ? rotation.filter((r) => r.tenantId === rule.tenantId)
        : rotation;
      let worstAgeDays = -1;
      for (const r of candidates) {
        if (r.lastRotationAt === null) {
          // Never rotated since bootstrap → treat as ageDays = cadence + 1
          worstAgeDays = Math.max(worstAgeDays, r.cadenceDays + 1);
        } else {
          const ageDays = (now - r.lastRotationAt) / 86_400_000;
          worstAgeDays = Math.max(worstAgeDays, ageDays);
        }
      }
      return worstAgeDays < 0 ? null : Number(worstAgeDays.toFixed(2));
    }
    case 'kms_error_rate':
      return rateOverWindow(snap, 'encryption.kms.error', rule.tenantId, rule.windowMs ?? 5 * 60_000, now);
    case 'aead_error_rate':
      return rateOverWindow(snap, 'encryption.aead.error', rule.tenantId, rule.windowMs ?? 5 * 60_000, now);
    case 'decrypt_latency_p95':
      return histogramP95(snap, 'encryption.decrypt.duration_ms', rule.tenantId);
    case 'cache_hit_rate':
      return cacheHitRate(snap, rule.tenantId);
    default:
      return null;
  }
}

function isFiring(kind: AlertRuleKind, observed: number, threshold: number): boolean {
  // For cache_hit_rate, lower is worse — fire when below threshold.
  if (kind === 'cache_hit_rate') return observed < threshold;
  return observed >= threshold;
}

function messageFor(rule: AlertRule, observed: number): string {
  const tenant = rule.tenantId ? `tenant ${rule.tenantId}` : 'fleet-wide';
  switch (rule.kind) {
    case 'rotation_overdue':
      return `${tenant}: rotation overdue (${observed}d ≥ threshold ${rule.threshold}d)`;
    case 'kms_error_rate':
      return `${tenant}: KMS error rate ${observed}/min ≥ threshold ${rule.threshold}`;
    case 'aead_error_rate':
      return `${tenant}: AEAD decryption error rate ${observed}/min ≥ threshold ${rule.threshold}`;
    case 'decrypt_latency_p95':
      return `${tenant}: decrypt p95 ${observed}ms ≥ threshold ${rule.threshold}ms`;
    case 'cache_hit_rate':
      return `${tenant}: cache hit rate ${(observed * 100).toFixed(1)}% < threshold ${(rule.threshold * 100).toFixed(1)}%`;
    default:
      return `${tenant}: ${rule.kind} threshold breached`;
  }
}

function rateOverWindow(
  snap: MetricsSnapshot,
  name: MetricName,
  tenantId: string | null,
  windowMs: number,
  now: number,
): number | null {
  const matched = snap.series.filter(
    (s) => s.name === name && (tenantId == null || s.labels.tenantId === tenantId) && s.kind === 'counter',
  );
  if (matched.length === 0) return 0;
  let total = 0;
  for (const s of matched) {
    if (now - s.lastAt <= windowMs) {
      total += s.counter?.count ?? 0;
    }
  }
  // Convert to per-minute rate over the window.
  const minutes = Math.max(1 / 60, windowMs / 60_000);
  return Number((total / minutes).toFixed(2));
}

function histogramP95(snap: MetricsSnapshot, name: MetricName, tenantId: string | null): number | null {
  const matched = snap.series.filter(
    (s) => s.name === name && (tenantId == null || s.labels.tenantId === tenantId) && s.kind === 'histogram',
  );
  if (matched.length === 0) return null;
  // Worst-case p95 across matched series.
  let worst = 0;
  for (const s of matched) {
    const p = s.histogram?.p95 ?? 0;
    if (p > worst) worst = p;
  }
  return Number(worst.toFixed(2));
}

function cacheHitRate(snap: MetricsSnapshot, tenantId: string | null): number | null {
  const matchTenant = (s: MetricSeriesSnapshot) => tenantId == null || s.labels.tenantId === tenantId;
  let hits = 0;
  let misses = 0;
  for (const s of snap.series) {
    if (!matchTenant(s)) continue;
    if (s.name === 'encryption.cache.hit') hits += s.counter?.count ?? 0;
    if (s.name === 'encryption.cache.miss') misses += s.counter?.count ?? 0;
  }
  const total = hits + misses;
  if (total === 0) return null;
  return Number((hits / total).toFixed(4));
}

// ─── Default starter rules ──────────────────────────────────────────────────

/**
 * Reasonable defaults that ship with a new tenant. Operators tune via the
 * admin endpoint; these exist so the dashboard isn't empty out of the box.
 */
export const DEFAULT_ALERT_RULES: readonly Omit<AlertRule, 'id' | 'tenantId'>[] = [
  {
    kind: 'rotation_overdue',
    threshold: 100,
    windowMs: null,
    enabled: true,
    description: 'Active DEK older than 100 days (cadence 90d + 10d grace)',
  },
  {
    kind: 'kms_error_rate',
    threshold: 5,
    windowMs: 5 * 60_000,
    enabled: true,
    description: 'KMS errors > 5/min over 5min window',
  },
  {
    kind: 'aead_error_rate',
    threshold: 1,
    windowMs: 5 * 60_000,
    enabled: true,
    description: 'AEAD decrypt failures > 1/min over 5min — possible tampering or key drift',
  },
  {
    kind: 'decrypt_latency_p95',
    threshold: 50,
    windowMs: null,
    enabled: true,
    description: 'Decrypt p95 latency > 50ms — suggests cache pressure or KMS slow-path',
  },
  {
    kind: 'cache_hit_rate',
    threshold: 0.8,
    windowMs: null,
    enabled: false,
    description: 'Cache hit rate < 80% (disabled by default — noisy on bootstrap)',
  },
];
