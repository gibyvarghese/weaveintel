#!/usr/bin/env node
// scripts/e2e-m3-mobile-auth.ts
//
// M3 (geneweave-mobile) — live-server end-to-end proof that the mobile auth
// CONTROLLER (the pure brain in clients/mobile/src/lib) drives the real
// geneWeave server exactly as the app will on a device. There is no simulator
// here, so the "device" pieces are faked at their narrow interfaces
// (KeyValueStore = in-memory map, BiometricAuthenticator = scripted) while the
// host probe and GeneweaveClient talk to the actual running server.
//
//   0. seed a principal (cookie register)
//   1. initialize with no host         → needs-host
//   2. setHost(wrong)                  → friendly, non-technical rejection
//   3. setHost(BASE)                   → reachable, persisted → signed-out
//   4. signIn                          → authenticated (tokens persisted)
//   5. cold-start rehydration          → a FRESH controller on the same store
//                                        comes back authenticated WITHOUT re-login
//   6. biometric gate                  → fresh gate-on controller cold-starts
//                                        LOCKED; unlock() → authenticated
//   7. sign-out                        → clears the session; a fresh controller
//                                        on the same store is signed-out
//   8. per-tenant isolation            → two tenants, ONE device store, isolated
//                                        sessions (tenant-a in, tenant-b out)
//
// Run with tsx so the .ts logic layer can be imported directly:
//   zsh> set +H && BASE_URL=http://localhost:3500 npx tsx scripts/e2e-m3-mobile-auth.ts
import { BASE, makeOk, jfetch } from './e2e-helpers.mjs';
import { createGeneweaveClient, type KeyValueStore, type TokenStore } from '../clients/api-client/dist/index.js';
import {
  createAuthStore,
  createAuthController,
  createCatalogHostProbe,
  createTenantTokenStore,
  type AuthControllerOptions,
  type BiometricAuthenticator,
  type ClientFactory,
} from '../clients/mobile/src/lib/index.js';

const ok = makeOk();
const ts = Date.now();
const password = 'P@ssw0rd123';
const email = `e2e_m3_${ts}@example.com`;

/** A process-local KeyValueStore standing in for expo-secure-store. */
function memoryKv(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

const makeClient: ClientFactory = ({ host, tokenStore }) =>
  createGeneweaveClient({ host, tokenStore: tokenStore as TokenStore });

function scriptedBiometric(result: { value: boolean }, enrolled = true): BiometricAuthenticator {
  return { isEnrolled: async () => enrolled, authenticate: async () => result.value };
}

function baseOpts(kv: KeyValueStore, store = createAuthStore()): { store: typeof store; opts: AuthControllerOptions } {
  const opts: AuthControllerOptions = {
    store,
    kv,
    makeClient,
    biometric: scriptedBiometric({ value: true }),
    hostProbe: createCatalogHostProbe(makeClient),
    env: { biometricEnabledByDefault: false },
  };
  return { store, opts };
}

console.log(`\n=== M3 mobile auth-controller E2E — ${BASE} ===\n`);

// 0. Seed a principal so credentials exist on the server.
console.log('0. Seed a principal');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'm3' } });
ok(reg.status === 201, `register status=${reg.status}`);

// 1. initialize with no host → needs-host
console.log('\n1. initialize() with no host → needs-host');
const kv = memoryKv();
const { store, opts } = baseOpts(kv);
const controller = createAuthController(opts);
await controller.initialize();
ok(store.getState().status === 'needs-host', 'no host configured surfaces needs-host');

// 2. setHost(wrong) → friendly rejection
console.log('\n2. setHost(unreachable) → friendly, non-technical rejection');
const bad = await controller.setHost('http://127.0.0.1:59999');
ok(bad.ok === false, 'unreachable host rejected');
ok(bad.ok === false && /reach that server/i.test(bad.reason), `friendly reason: "${bad.ok === false ? bad.reason : ''}"`);
ok(store.getState().status === 'needs-host', 'state unchanged after a bad host');

// 3. setHost(BASE) → reachable + persisted → signed-out
console.log('\n3. setHost(BASE) probes the real catalog → signed-out');
const good = await controller.setHost(BASE);
ok(good.ok === true, `reachable host accepted (surfaceId=${good.ok ? good.surfaceId : ''})`);
ok(store.getState().status === 'signed-out', 'reachable host transitions to signed-out');
ok(controller.getClient() !== null, 'a client is built for the active host');

// 4. signIn → authenticated, tokens persisted
console.log('\n4. signIn() authenticates and persists the session');
await controller.signIn(email, password);
const authed = store.getState();
ok(authed.status === 'authenticated', 'signIn transitions to authenticated');
ok(authed.status === 'authenticated' && authed.user.email === email, 'authenticated as the seeded principal');
const persisted = await createTenantTokenStore(kv, BASE).get();
ok(persisted?.token.split('.').length === 3, 'a real JWT was persisted to the device store');

// 5. cold-start rehydration — a FRESH controller on the SAME store, no re-login
console.log('\n5. Cold-start: a fresh controller on the same store rehydrates WITHOUT re-login');
const { store: store2 } = baseOpts(kv);
const controller2 = createAuthController({ ...baseOpts(kv, store2).opts, env: { defaultHost: BASE, biometricEnabledByDefault: false } });
await controller2.initialize();
const rehydrated = store2.getState();
ok(rehydrated.status === 'authenticated', 'rehydrated straight to authenticated from stored tokens');
ok(rehydrated.status === 'authenticated' && rehydrated.user.email === email, 'rehydrated as the same principal');

// 6. biometric gate — fresh gate-on controller cold-starts LOCKED, then unlocks
console.log('\n6. Biometric gate: cold-start LOCKED → unlock() → authenticated');
const bioResult = { value: true };
const store3 = createAuthStore();
const controller3 = createAuthController({
  store: store3,
  kv,
  makeClient,
  biometric: scriptedBiometric(bioResult, /* enrolled */ true),
  hostProbe: createCatalogHostProbe(makeClient),
  env: { defaultHost: BASE, biometricEnabledByDefault: true },
});
await controller3.initialize();
ok(store3.getState().status === 'locked', 'gate-on cold start lands on locked');
bioResult.value = false;
const denied = await controller3.unlock();
ok(denied === false && store3.getState().status === 'locked', 'a failed biometric keeps the app locked');
bioResult.value = true;
const granted = await controller3.unlock();
ok(granted === true && store3.getState().status === 'authenticated', 'a successful biometric unlocks');

// 7. sign-out clears the session
console.log('\n7. signOut() clears the device session');
await controller3.signOut();
ok(store3.getState().status === 'signed-out', 'signOut transitions to signed-out');
const { store: store4 } = baseOpts(kv);
const controller4 = createAuthController({ ...baseOpts(kv, store4).opts, env: { defaultHost: BASE, biometricEnabledByDefault: false } });
await controller4.initialize();
ok(store4.getState().status === 'signed-out', 'a fresh controller finds no session after sign-out');

// 8. per-tenant isolation on ONE device store
console.log('\n8. Per-tenant isolation: two tenants share one device, isolated sessions');
const sharedKv = memoryKv();
// Seed a second principal for tenant-b so both can authenticate independently.
const emailB = `e2e_m3b_${ts}@example.com`;
const regB = await jfetch('POST', '/api/auth/register', { body: { email: emailB, password, name: 'm3b' } });
ok(regB.status === 201, `second principal registered status=${regB.status}`);

const storeA = createAuthStore();
const controllerA = createAuthController({
  store: storeA, kv: sharedKv, makeClient,
  biometric: scriptedBiometric({ value: true }),
  hostProbe: createCatalogHostProbe(makeClient),
  env: { defaultHost: BASE, tenantId: 'tenant-a', biometricEnabledByDefault: false },
});
const storeB = createAuthStore();
const controllerB = createAuthController({
  store: storeB, kv: sharedKv, makeClient,
  biometric: scriptedBiometric({ value: true }),
  hostProbe: createCatalogHostProbe(makeClient),
  env: { defaultHost: BASE, tenantId: 'tenant-b', biometricEnabledByDefault: false },
});
await controllerA.initialize();
await controllerB.initialize();
await controllerA.signIn(email, password);
ok(storeA.getState().status === 'authenticated', 'tenant-a signs in');
ok(storeB.getState().status === 'signed-out', 'tenant-b is unaffected by tenant-a sign-in');
const tokA = await createTenantTokenStore(sharedKv, BASE, 'tenant-a').get();
const tokB = await createTenantTokenStore(sharedKv, BASE, 'tenant-b').get();
ok(tokA !== null && tokB === null, 'only tenant-a has a persisted session on the shared device');

console.log(`\n=== M3 mobile auth-controller E2E PASSED — ${ok.count()} assertions ===\n`);
