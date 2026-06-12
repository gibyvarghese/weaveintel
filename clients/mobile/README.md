# geneweave-mobile

React Native + Expo client for geneWeave (Expo Router, new architecture enabled).

## Status: M3 — navigation, theming, auth

M3 adds the full auth + navigation + theming foundation on top of the M0
scaffold. It is split into two layers so the logic is testable and typecheckable
in plain Node, while the device-only view layer stays isolated:

```
src/lib/        pure logic — NO react / react-native / expo imports.
                vitest-tested + typechecked in CI on every push.
src/native/     view layer — expo-secure-store / biometrics adapters,
                React context providers, themed UI primitives.
app/            Expo Router screens (auth stack + tabs).
```

The pure-logic layer (`src/lib/**`) is the contract. It owns host validation,
the auth state machine, the biometric relock gate, per-tenant secure-token
namespacing, deep-link parsing, and tenant theme resolution. The native layer
and screens are thin consumers that wire those pieces to real Expo APIs and
React. Only `src/lib/**` is in the `tsc` / `vitest` graph in this headless
repo; `src/native/**` and `app/**` typecheck on a dev machine after the Expo/RN
tree is installed.

### What M3 delivers

- **Server picker → sign-in → unlock** auth flow with a friendly,
  non-technical host-validation message and a real catalog reachability probe
  (a `401` from the server counts as reachable — the user simply is not signed
  in yet).
- **Cold-start rehydration**: a returning user lands straight on the
  authenticated app from the device's secure token store, with no re-login.
- **Biometric relock gate**: configurable per device, relocks after a
  background window (`BIOMETRIC_RELOCK_MS`), and cold-starts into a `locked`
  state when enabled.
- **Per-tenant token isolation**: tokens are namespaced per `tenant@host`, so
  multiple tenants can share one physical device with fully isolated sessions.
- **Tenant theming** with AA-contrast enforcement — a failing override degrades
  to the base theme rather than shipping unreadable colors.

## Install the Expo/RN tree and run (dev machine)

The heavy React Native / Expo dependency tree is listed in `package.json` but is
**not installed** in this repo so the monorepo install and `turbo build` stay
fast. On a dev machine:

```bash
cd clients/mobile
# Pin to the latest stable Expo SDK; --fix aligns transitive RN versions.
npx expo install expo expo-router react react-native react-dom react-native-web \
  expo-constants expo-linking expo-status-bar expo-font expo-secure-store \
  expo-local-authentication react-native-safe-area-context react-native-screens \
  @tanstack/react-query \
  @expo-google-fonts/fraunces @expo-google-fonts/plus-jakarta-sans \
  @expo-google-fonts/dm-mono
npx expo install --fix

# Run on a device / simulator
npm run ios       # iPhone target
npm run android   # Android target
```

## Test & typecheck (CI, no device required)

```bash
# Pure-logic unit tests (vitest, Node environment)
npm test                      # vitest run --config vitest.config.ts

# Typecheck the pure-logic layer
npm run typecheck:lib         # tsc -p src/lib/tsconfig.json
```

The wired auth flow is verified end-to-end against a running server by
`scripts/e2e-m3-mobile-auth.ts` (from the repo root):

```bash
BASE_URL=http://localhost:3500 npx tsx scripts/e2e-m3-mobile-auth.ts
```

## Device-gated acceptance criteria

These are validated on a simulator/device after the Expo install (not in CI):

- Cold start to first interactive frame under ~2.5s on a mid-tier device.
- Deep links (`geneweave://…`) route to the correct screen.
- Biometric prompt appears on the unlock screen and on foreground relock.
- Tenant theme overrides apply, with AA degradation when contrast fails.

## Workspace dependencies

The app consumes the workspace TypeScript packages:

- `@geneweave/tokens` — brand design tokens (M1)
- `@geneweave/api-client` — typed `/api/me` client (M2)
