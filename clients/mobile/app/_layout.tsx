/**
 * Root layout for the geneWeave mobile app (Expo Router).
 *
 * M0 scaffold: a single Stack. M3 replaces this with the `(auth)` / `(tabs)`
 * group navigation, theme provider over @geneweave/tokens, font loading, and
 * the GeneweaveClient + TanStack Query providers.
 *
 * NOTE: `expo-router` / `react` resolve once the Expo dependency tree is
 * installed in M3 (see README.md). This file is intentionally not part of the
 * monorepo `tsc -b` graph during M0.
 */
import { Stack } from 'expo-router';

export default function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
