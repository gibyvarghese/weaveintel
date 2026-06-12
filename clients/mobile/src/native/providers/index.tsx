/**
 * providers/index.tsx — the composed provider tree for the app root.
 *
 * Order matters: SafeArea (insets) → Query (server state) → Auth (session +
 * controller) → Theme (depends on nothing but is innermost so screens can read
 * it). The root layout wraps the navigator in `<AppProviders>` once.
 */
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { TenantThemeOverride } from '@geneweave/tokens';
import { QueryProvider } from './query-provider';
import { AuthProvider } from './auth-provider';
import { ThemeProvider } from './theme-provider';
import type { ThemePreference } from '../../lib';

export interface AppProvidersProps {
  children: ReactNode;
  themePreference?: ThemePreference;
  tenantTheme?: TenantThemeOverride;
}

export function AppProviders({ children, themePreference, tenantTheme }: AppProvidersProps) {
  return (
    <SafeAreaProvider>
      <QueryProvider>
        <AuthProvider>
          <ThemeProvider preference={themePreference} tenantTheme={tenantTheme}>
            {children}
          </ThemeProvider>
        </AuthProvider>
      </QueryProvider>
    </SafeAreaProvider>
  );
}

export { useTheme } from './theme-provider';
export { useAuth, useClient } from './auth-provider';
