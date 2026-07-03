/**
 * Tests — RBAC surface parity (canAccessArea / NAV_AREA_PERMISSION). Positive / negative / stress / security.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_RBAC_POLICY, NAV_AREA_PERMISSION, canAccessArea } from './rbac.js';

describe('canAccessArea — admin surfaces gated', () => {
  it('POSITIVE — a tenant_admin can access Builder + Admin', () => {
    expect(canAccessArea(DEFAULT_RBAC_POLICY, 'tenant_admin', 'builder')).toBe(true);
    expect(canAccessArea(DEFAULT_RBAC_POLICY, 'tenant_admin', 'admin')).toBe(true);
  });
  it('POSITIVE — a platform_admin can access everything gated', () => {
    for (const area of Object.keys(NAV_AREA_PERMISSION)) {
      expect(canAccessArea(DEFAULT_RBAC_POLICY, 'platform_admin', area)).toBe(true);
    }
  });
  it('NEGATIVE — a tenant_user (standard member) is DENIED Builder + Admin (the surface gap)', () => {
    expect(canAccessArea(DEFAULT_RBAC_POLICY, 'tenant_user', 'builder')).toBe(false);
    expect(canAccessArea(DEFAULT_RBAC_POLICY, 'tenant_user', 'admin')).toBe(false);
  });
});

describe('canAccessArea — member-visible + always-visible areas', () => {
  it('a tenant_user can see the dashboard (dashboard:read) + chat/notes (always)', () => {
    expect(canAccessArea(DEFAULT_RBAC_POLICY, 'tenant_user', 'dashboard')).toBe(true);
    expect(canAccessArea(DEFAULT_RBAC_POLICY, 'tenant_user', 'chat')).toBe(true);
    expect(canAccessArea(DEFAULT_RBAC_POLICY, 'tenant_user', 'notes')).toBe(true);
  });
  it('an unknown / null-permission area is visible to everyone (fail-open for non-privileged surfaces)', () => {
    expect(canAccessArea(DEFAULT_RBAC_POLICY, 'tenant_user', 'some-future-area')).toBe(true);
    expect(canAccessArea(DEFAULT_RBAC_POLICY, 'tenant_user', 'home')).toBe(true);
  });
});

describe('SECURITY / robustness', () => {
  it('an unknown / empty / junk persona is DENIED every gated area (fail-closed)', () => {
    for (const persona of ['', 'root', 'superuser', 'admin', 'tenant_admin ', 'DROP TABLE users']) {
      expect(canAccessArea(DEFAULT_RBAC_POLICY, persona, 'builder')).toBe(false);
      expect(canAccessArea(DEFAULT_RBAC_POLICY, persona, 'admin')).toBe(false);
    }
  });
  it('an injection-y area string never throws + is treated as an unknown (visible) non-privileged area', () => {
    expect(canAccessArea(DEFAULT_RBAC_POLICY, 'tenant_user', '__proto__')).toBe(true);
    expect(canAccessArea(DEFAULT_RBAC_POLICY, 'tenant_user', 'constructor')).toBe(true);
    expect(canAccessArea(DEFAULT_RBAC_POLICY, 'tenant_user', 'builder";DROP')).toBe(true); // unknown → visible, but NOT 'builder'
  });
  it('a NON-admin can never reach a gated area even by a look-alike area name', () => {
    expect(canAccessArea(DEFAULT_RBAC_POLICY, 'tenant_user', 'Builder')).toBe(true); // case-sensitive: 'Builder' is unknown → visible, but it is NOT the real 'builder' route
    expect(canAccessArea(DEFAULT_RBAC_POLICY, 'tenant_user', 'builder')).toBe(false); // the real one stays denied
  });
});

describe('STRESS', () => {
  it('100k access checks resolve quickly', () => {
    const t = Date.now();
    let allow = 0;
    for (let i = 0; i < 100_000; i++) if (canAccessArea(DEFAULT_RBAC_POLICY, i % 2 ? 'tenant_admin' : 'tenant_user', 'builder')) allow++;
    expect(Date.now() - t).toBeLessThan(1500);
    expect(allow).toBe(50_000); // only the tenant_admin half
  });
});
