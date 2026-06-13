/**
 * Root layout for the geneWeave mobile app (Expo Router) — M3.
 *
 * Responsibilities:
 *  - Load the brand fonts (Fraunces / Plus Jakarta Sans / DM Mono) and hold the
 *    splash screen until they are ready.
 *  - Wrap the whole app in the composed provider tree (Query → Auth → Theme).
 *  - Render the two route groups — `(auth)` and `(tabs)` — and let
 *    `useProtectedRoute` switch between them based on the observable auth state.
 *
 * Device-gated: imports `expo-router` / `react-native` / `expo-font`. The
 * navigation decision logic is the pure controller state machine from
 * `src/lib`; this file is the thin native shell around it.
 */
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { Fraunces_400Regular } from '@expo-google-fonts/fraunces';
import { PlusJakartaSans_400Regular } from '@expo-google-fonts/plus-jakarta-sans';
import { DMMono_400Regular } from '@expo-google-fonts/dm-mono';
import { ActivityIndicator, View } from 'react-native';
import { AppProviders, AppearanceProvider, useAppearance, useAuth, useTheme } from '../src/native/providers';
import { useProtectedRoute } from '../src/native/navigation/use-protected-route';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  // Map each token font family name to its loaded face. Additional weights are
  // a later polish; the regular faces keep `fontFamily` references resolving.
  const [fontsLoaded] = useFonts({
    Fraunces: Fraunces_400Regular,
    'Plus Jakarta Sans': PlusJakartaSans_400Regular,
    'DM Mono': DMMono_400Regular,
  });

  useEffect(() => {
    if (fontsLoaded) void SplashScreen.hideAsync();
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <AppearanceProvider>
      <ThemedApp />
    </AppearanceProvider>
  );
}

/** Reads the local appearance preference and feeds it into the theme tree. */
function ThemedApp() {
  const { preference } = useAppearance();
  return (
    <AppProviders themePreference={preference}>
      <RootNavigator />
    </AppProviders>
  );
}

function RootNavigator() {
  const { state } = useAuth();
  const { theme } = useTheme();
  useProtectedRoute(state);

  if (state.status === 'initializing') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background }}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.background } }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      {/* Pushed account sub-screens (slide over the tabs). */}
      <Stack.Screen name="memory" />
      <Stack.Screen name="settings" />
      {/* Dev-only widget gallery (renders every render kind from fixtures). */}
      <Stack.Screen name="widget-gallery" options={{ presentation: 'modal' }} />
    </Stack>
  );
}
