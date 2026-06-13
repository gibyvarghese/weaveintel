/**
 * providers/index.tsx — the composed provider tree for the app root.
 *
 * Order matters: SafeArea (insets) → Query (server state) → Auth (session +
 * controller) → TenantThemeGate (fetches the per-tenant brand override, then
 * renders the pure ThemeProvider innermost so screens can read the theme). The
 * root layout wraps the navigator in `<AppProviders>` once.
 */
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { TenantThemeOverride } from '@geneweave/tokens';
import { QueryProvider } from './query-provider';
import { AuthProvider } from './auth-provider';
import { TenantThemeGate } from './tenant-theme-gate';
import type { ThemePreference } from '../../lib';

export interface AppProvidersProps {
  children: ReactNode;
  themePreference?: ThemePreference;
  /**
   * Static tenant override (tests / storybook). In normal operation the override
   * is fetched per tenant from `GET /api/me/theme` by {@link TenantThemeGate};
   * when provided here it wins for deterministic rendering.
   */
  tenantTheme?: TenantThemeOverride;
}

export function AppProviders({ children, themePreference, tenantTheme }: AppProvidersProps) {
  return (
    <SafeAreaProvider>
      <QueryProvider>
        <AuthProvider>
          <TenantThemeGate
            preference={themePreference}
            {...(tenantTheme !== undefined ? { tenantTheme } : {})}
          >
            {children}
          </TenantThemeGate>
        </AuthProvider>
      </QueryProvider>
    </SafeAreaProvider>
  );
}

export { useTheme } from './theme-provider';
export { useAuth, useClient } from './auth-provider';
