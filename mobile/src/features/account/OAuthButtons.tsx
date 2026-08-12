import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSession } from '../../lib/session';
import { OAuthCancelledError } from '../../lib/oauth';
import { useToast } from '../../components/toast-context';
import { colors, fonts, radius, spacing } from '../../theme/tokens';

/**
 * "Continue with Google / Apple". Each button is disabled with a "not
 * configured" note when its client ID is absent (no SDK is touched), exactly
 * like the web client. On success the session is established and the auth
 * guard redirects into the app.
 */
export function OAuthButtons() {
  const { oauth, signInWithGoogle, signInWithApple } = useSession();
  const { toast } = useToast();
  const [pending, setPending] = useState<'google' | 'apple' | null>(null);

  const run = async (provider: 'google' | 'apple', fn: () => Promise<unknown>) => {
    setPending(provider);
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof OAuthCancelledError)) {
        toast({
          variant: 'error',
          message: `${provider === 'google' ? 'Google' : 'Apple'} sign-in failed. Please try again.`,
        });
      }
    } finally {
      setPending(null);
    }
  };

  const unavailable = [
    !oauth.googleConfigured && 'Google',
    !oauth.appleConfigured && 'Apple',
  ].filter(Boolean) as string[];

  return (
    <View style={styles.stack}>
      <ProviderButton
        icon="logo-google"
        label="Continue with Google"
        disabled={!oauth.googleConfigured}
        loading={pending === 'google'}
        onPress={() => run('google', signInWithGoogle)}
      />
      <ProviderButton
        icon="logo-apple"
        label="Continue with Apple"
        disabled={!oauth.appleConfigured}
        loading={pending === 'apple'}
        onPress={() => run('apple', signInWithApple)}
      />
      {unavailable.length > 0 ? (
        <Text style={styles.note}>
          {unavailable.join(' and ')} sign-in {unavailable.length > 1 ? 'are' : 'is'} not configured
          in this environment.
        </Text>
      ) : null}
    </View>
  );
}

function ProviderButton({
  icon,
  label,
  disabled,
  loading,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  disabled: boolean;
  loading: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [styles.button, disabled ? styles.buttonDisabled : null, pressed ? styles.pressed : null]}
    >
      <Ionicons name={icon} size={18} color={disabled ? colors.textSubtle : colors.text} />
      <Text style={[styles.label, disabled ? styles.labelDisabled : null]}>
        {loading ? 'Please wait...' : label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: spacing.sm,
  },
  button: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  pressed: {
    opacity: 0.9,
  },
  label: {
    color: colors.text,
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
  },
  labelDisabled: {
    color: colors.textSubtle,
  },
  note: {
    color: colors.textSubtle,
    fontFamily: fonts.body,
    fontSize: 12,
    textAlign: 'center',
  },
});
