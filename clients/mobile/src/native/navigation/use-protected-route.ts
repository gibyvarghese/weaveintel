/**
 * use-protected-route.ts — redirects between the `(auth)` and `(tabs)` groups
 * based on the observable auth state.
 *
 * Device-gated (uses `expo-router` hooks). The state machine it switches on is
 * produced entirely by the pure controller in `src/lib`, so the redirect
 * targets are a thin, declarative projection of already-tested states:
 *
 *   initializing → (hold splash, no navigation)
 *   needs-host   → /(auth)/server
 *   signed-out   → /(auth)/sign-in
 *   locked       → /(auth)/unlock
 *   authenticated→ /(tabs)
 */
import { useEffect } from 'react';
import { useRouter, useSegments } from 'expo-router';
import type { AuthState } from '../../lib';

export function useProtectedRoute(state: AuthState): void {
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (state.status === 'initializing') return;
    const inTabsGroup = segments[0] === '(tabs)';

    switch (state.status) {
      case 'needs-host':
        router.replace('/(auth)/server');
        break;
      case 'signed-out':
        router.replace('/(auth)/sign-in');
        break;
      case 'locked':
        router.replace('/(auth)/unlock');
        break;
      case 'authenticated':
        if (!inTabsGroup) router.replace('/(tabs)');
        break;
    }
  }, [state.status, segments, router]);
}
