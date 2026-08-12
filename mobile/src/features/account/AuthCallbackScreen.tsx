import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../lib/session';
import { AppScreen } from '../../components/AppScreen';
import { colors, spacing, typography } from '../../theme/tokens';

function getSingleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Magic-link deep-link landing. The backend redirects here with the full
 * bearer pair as query params (token + refreshToken + expiresAt), or an error
 * code. We persist all three via completeMagicLink and enter the app.
 */
export function AuthCallbackScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    token?: string;
    refreshToken?: string;
    expiresAt?: string;
    error?: string;
  }>();
  const { completeMagicLink } = useSession();
  const [message, setMessage] = useState('Completing sign in...');

  const token = getSingleParam(params.token);
  const refreshToken = getSingleParam(params.refreshToken);
  const expiresAt = getSingleParam(params.expiresAt);
  const error = getSingleParam(params.error);

  useEffect(() => {
    let mounted = true;

    (async () => {
      if (error) {
        if (mounted) setMessage(`Sign-in failed: ${error.replace(/_/g, ' ')}`);
        return;
      }
      if (!token || !refreshToken) {
        if (mounted) setMessage('This sign-in link is missing its session tokens.');
        return;
      }

      try {
        await completeMagicLink({
          accessToken: token,
          refreshToken,
          accessTokenExpiresAt: expiresAt ?? '',
        });
        router.replace('/(tabs)');
      } catch {
        if (mounted) setMessage('Unable to establish a session from this link.');
      }
    })();

    return () => {
      mounted = false;
    };
  }, [completeMagicLink, error, expiresAt, refreshToken, router, token]);

  return (
    <AppScreen scroll={false}>
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.message}>{message}</Text>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  message: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
