/**
 * (auth)/sign-in.tsx — email + password sign-in against the selected server.
 *
 * Delegates to the pure controller's `signIn`, which authenticates via the
 * GeneweaveClient, persists the per-tenant session, and transitions to
 * `authenticated` (or `locked` when the biometric gate is on). On success the
 * route gate navigates into `(tabs)` automatically.
 */
import { useState } from 'react';
import { useAuth } from '../../src/native/providers';
import { Screen, Heading, Body, Field, PrimaryButton, ErrorText } from '../../src/native/ui/primitives';

export default function SignInScreen() {
  const { controller, state } = useAuth();
  const host = state.status === 'signed-out' ? state.host : undefined;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSignIn() {
    setBusy(true);
    setError(null);
    try {
      await controller.signIn(email.trim(), password);
    } catch {
      setError('Sign-in failed. Check your email and password, then try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Heading>Sign in</Heading>
      {host ? <Body muted>{host}</Body> : null}
      <Field
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        inputMode="email"
        textContentType="username"
      />
      <Field
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        secureTextEntry
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={onSignIn}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <PrimaryButton
        label="Sign in"
        onPress={onSignIn}
        busy={busy}
        disabled={email.trim().length === 0 || password.length === 0}
      />
    </Screen>
  );
}
