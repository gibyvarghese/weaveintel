# geneweave-mobile

React Native + Expo client for geneWeave (Expo Router, new architecture enabled).

## Status: M0 scaffold

M0 lays down the project **structure** (`app.json`, `tsconfig.json`,
`babel.config.js`, the Expo Router `app/` entry) and registers the package in
the workspace. The heavy React Native / Expo dependency tree is **not** installed
yet — that happens in **M3** so the rest of the monorepo install and the
`turbo build` for the TypeScript clients (`@geneweave/tokens`,
`@geneweave/api-client`) stay fast and stable.

Because the RN deps are deferred, the files under `app/` import `expo-router`,
`react`, and `react-native`, which resolve only after the M3 install. This
package is intentionally **excluded from the monorepo `tsc -b` build graph**
during M0.

## M3 — install the Expo/RN tree and run

```bash
cd clients/mobile
# Pin to the latest stable Expo SDK; --fix aligns transitive RN versions.
npx expo install expo expo-router react react-native react-dom react-native-web \
  expo-constants expo-linking expo-status-bar expo-font expo-secure-store \
  expo-local-authentication react-native-safe-area-context react-native-screens
npx expo install --fix

# Run on a device / simulator
npm run ios       # iPhone 12 target
npm run android   # Pixel 6a target
```

## Workspace dependencies

The app consumes the workspace TypeScript packages:

- `@geneweave/tokens` — brand design tokens (M1)
- `@geneweave/api-client` — typed `/api/me` client (M2)

These are added to `dependencies` during M3 once the RN tree is present.
