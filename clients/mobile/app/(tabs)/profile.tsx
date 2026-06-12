/**
 * (tabs)/profile.tsx — account + security settings.
 *
 * Shows the signed-in user and the connected server, lets the user toggle the
 * biometric gate (persisted via the controller), and signs out. All actions
 * delegate to the pure auth controller.
 */
import { useState } from 'react';
import { Switch, View } from 'react-native';
import { useAuth, useTheme } from '../../src/native/providers';
import { Screen, Heading, Body, PrimaryButton } from '../../src/native/ui/primitives';

export default function ProfileScreen() {
  const { controller, state } = useAuth();
  const { theme } = useTheme();
  const user = state.status === 'authenticated' ? state.user : undefined;
  const host = state.status === 'authenticated' ? state.host : undefined;

  const biometricAvailable = controller.isBiometricAvailable();
  const [biometricOn, setBiometricOn] = useState(controller.isBiometricEnabled());

  async function onToggleBiometric(next: boolean) {
    setBiometricOn(next);
    await controller.setBiometricEnabled(next);
  }

  return (
    <Screen>
      <Heading>Profile</Heading>
      {user ? <Body>{user.name || user.email}</Body> : null}
      {user ? <Body muted>{user.email}</Body> : null}
      {host ? <Body muted>{host}</Body> : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: theme.spacing.lg }}>
        <Body>Require biometric unlock</Body>
        <Switch
          value={biometricOn}
          onValueChange={(v) => void onToggleBiometric(v)}
          disabled={!biometricAvailable}
          trackColor={{ true: theme.colors.accent, false: theme.colors.surfaceElevated }}
        />
      </View>
      {!biometricAvailable ? <Body muted>No biometrics enrolled on this device.</Body> : null}

      <PrimaryButton label="Sign out" onPress={() => void controller.signOut()} />
    </Screen>
  );
}
