/**
 * (auth)/sign-in.tsx — email + password and social (OAuth) sign-in.
 *
 * Password sign-in delegates to the pure controller's `signIn`. Social sign-in
 * delegates to the `useOAuthSignIn` hook, which runs the provider flow in an
 * in-app browser and persists the server-minted session. Only providers the
 * server reports as configured are rendered. On success the route gate
 * navigates into `(tabs)` automatically.
 */
import { useEffect, useState } from 'react';
import { useAuth } from '../../src/native/providers';
import { Screen, Heading, Body, Field, PrimaryButton, ErrorText } from '../../src/native/ui/primitives';
import { SocialSignInButtons } from '../../src/native/ui/social-sign-in-buttons';
import { useOAuthSignIn } from '../../src/native/auth/use-oauth-sign-in';
import { parseAuthProviders, type OAuthProviderId } from '../../src/lib';

export default function SignInScreen() {
  const { controller, client, state } = useAuth();
  const host = state.status === 'signed-out' ? state.host : undefined;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<OAuthProviderId[]>([]);
  const { signInWith, pending: oauthPending } = useOAuthSignIn();

  // Discover which social providers the server has configured.
  useEffect(() => {
    let active = true;
    if (!client) return;
    void client
      .getAuthProviders()
      .then((raw) => {
        if (active) setProviders(parseAuthProviders(raw));
      })
      .catch(() => {
        if (active) setProviders([]);
      });
    return () => {
      active = false;
    };
  }, [client]);

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

  async function onSocial(provider: OAuthProviderId) {
    setError(null);
    const result = await signInWith(provider);
    if (!result.ok && result.error) {
      setError('Social sign-in failed. Please try again.');
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
      <SocialSignInButtons
        providers={providers}
        onSelect={onSocial}
        pending={oauthPending}
        disabled={busy}
      />
    </Screen>
  );
}
