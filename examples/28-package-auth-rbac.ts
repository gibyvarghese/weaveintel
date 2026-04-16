/**
 * Example 28: Package-level auth and RBAC (no app server required)
 *
 * Run:
 *   npx tsx examples/28-package-auth-rbac.ts
 *
 * Demonstrates package-level primitives only:
 *   - Runtime identity creation
 *   - Persona extension and permission resolution
 *   - Access evaluation with rules
 *   - Deny-by-default behavior for unknown personas / unmatched permissions
 */

import {
  createIdentity,
  createIdentityContext,
  DEFAULT_RBAC_POLICY,
  resolvePersonaPermissions,
  hasPersonaPermission,
  extendIdentityWithPersona,
  evaluateAccess,
  evaluateAccessBatch,
} from '@weaveintel/identity';
import type { AccessRule } from '@weaveintel/identity';

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, details?: string): void {
  if (condition) {
    pass += 1;
    console.log(`  PASS ${name}${details ? ` - ${details}` : ''}`);
    return;
  }
  fail += 1;
  console.log(`  FAIL ${name}${details ? ` - ${details}` : ''}`);
}

async function main(): Promise<void> {
  console.log('\n=== Package-level Identity + RBAC ===');

  const baseUser = createIdentity({
    type: 'user',
    id: 'user-001',
    name: 'Demo User',
    tenantId: 'tenant-a',
  });

  const tenantUserIdentity = extendIdentityWithPersona(baseUser, DEFAULT_RBAC_POLICY, 'tenant_user');
  const tenantUserPermissions = resolvePersonaPermissions(DEFAULT_RBAC_POLICY, 'tenant_user');

  check('tenant_user gets tools:search', hasPersonaPermission(DEFAULT_RBAC_POLICY, 'tenant_user', 'tools:search'));
  check('tenant_user denied admin:platform:write', !hasPersonaPermission(DEFAULT_RBAC_POLICY, 'tenant_user', 'admin:platform:write'));
  check('unknown persona has no permissions', resolvePersonaPermissions(DEFAULT_RBAC_POLICY, 'unknown_persona').length === 0);

  const identityCtx = createIdentityContext(tenantUserIdentity, {
    permissions: tenantUserPermissions,
  });

  const rules: AccessRule[] = [
    {
      id: 'allow-tools-search',
      name: 'Allow search tool usage',
      resource: 'tools:search',
      action: 'execute',
      scopes: ['tools:search'],
      result: 'allow',
      enabled: true,
    },
    {
      id: 'allow-dashboard-read',
      name: 'Allow dashboard read',
      resource: 'dashboard',
      action: 'read',
      scopes: ['dashboard:read'],
      result: 'allow',
      enabled: true,
    },
  ];

  const searchDecision = evaluateAccess(
    identityCtx,
    { resource: 'tools:search', action: 'execute' },
    rules,
  );
  const adminDecision = evaluateAccess(
    identityCtx,
    { resource: 'admin:platform', action: 'write' },
    rules,
  );

  check('evaluateAccess allows tools:search execution', searchDecision.result === 'allow', searchDecision.reason);
  check('evaluateAccess denies admin write by default', adminDecision.result === 'deny', adminDecision.reason);

  const batch = evaluateAccessBatch(
    identityCtx,
    [
      { resource: 'tools:search', action: 'execute' },
      { resource: 'dashboard', action: 'read' },
      { resource: 'admin:platform', action: 'write' },
    ],
    rules,
  );

  check('batch[0] allow', batch[0]?.result === 'allow');
  check('batch[1] allow', batch[1]?.result === 'allow');
  check('batch[2] deny', batch[2]?.result === 'deny');

  console.log('\n=== Summary ===');
  console.log(`  Passed: ${pass}`);
  console.log(`  Failed: ${fail}`);

  if (fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
