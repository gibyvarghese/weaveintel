/**
 * social-sign-in-buttons.tsx — OAuth provider buttons for the sign-in screen.
 *
 * Renders one outlined button per *server-configured* provider. Styling is
 * entirely theme-token driven (no hardcoded hex), so it re-skins with any
 * per-tenant brand override. Icons go through the single {@link Icon}
 * chokepoint — grey outline lucide glyphs — honoring the project icon rules.
 * All flow logic lives in the `useOAuthSignIn` hook; this component is presentational.
 */
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useTheme } from '../providers/theme-provider';
import { Icon, type IconName } from './icon';
import { oauthProviderLabel, type OAuthProviderId } from '../../lib';

const PROVIDER_ICON: Record<OAuthProviderId, IconName> = {
  google: 'oauthGoogle',
  github: 'oauthGithub',
  microsoft: 'oauthMicrosoft',
  apple: 'oauthApple',
  facebook: 'oauthFacebook',
};

export interface SocialSignInButtonsProps {
  providers: OAuthProviderId[];
  onSelect: (provider: OAuthProviderId) => void;
  /** The provider whose flow is in-flight (shows a spinner), or null. */
  pending?: OAuthProviderId | null;
  /** Disable all buttons (e.g. while a password sign-in is running). */
  disabled?: boolean;
}

export function SocialSignInButtons({ providers, onSelect, pending = null, disabled = false }: SocialSignInButtonsProps) {
  const { theme } = useTheme();
  if (providers.length === 0) return null;

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, marginVertical: theme.spacing.xs }}>
        <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.surfaceElevated }} />
        <Text style={{ color: theme.colors.textMuted, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.bodySmall.fontSize }}>
          or
        </Text>
        <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.surfaceElevated }} />
      </View>

      {providers.map((provider) => {
        const busy = pending === provider;
        const isDisabled = disabled || pending !== null;
        return (
          <Pressable
            key={provider}
            onPress={() => onSelect(provider)}
            disabled={isDisabled}
            accessibilityRole="button"
            accessibilityLabel={oauthProviderLabel(provider)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: theme.spacing.sm,
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.surfaceElevated,
              borderWidth: 1,
              borderRadius: theme.radii.md,
              paddingVertical: theme.spacing.md,
              opacity: isDisabled && !busy ? 0.6 : 1,
            }}
          >
            {busy ? (
              <ActivityIndicator color={theme.colors.textSecondary} />
            ) : (
              <Icon name={PROVIDER_ICON[provider]} tone="inactive" />
            )}
            <Text style={{ color: theme.colors.text, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.headline.fontSize, fontWeight: '600' }}>
              {oauthProviderLabel(provider)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
