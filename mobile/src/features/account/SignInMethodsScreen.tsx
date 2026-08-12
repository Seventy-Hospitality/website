/**
 * Sign-in methods (M6): the password state plus linked Google/Apple providers,
 * with link (via the M0 OAuth port) and unlink (guarded server-side against
 * removing the last credential). There is no member-web equivalent screen; this
 * is the mobile surface for GET/POST/DELETE /api/me/auth-identities. Link
 * buttons degrade to disabled when a provider is not configured in this build.
 */
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { ApiError, api } from '../../lib/api';
import { useSession } from '../../lib/session';
import {
  OAuthCancelledError,
  OAuthNotConfiguredError,
  appleAdapter,
  authenticateWithProvider,
  googleAdapter,
  type OAuthProvider,
} from '../../lib/oauth';
import { PrimaryButton, Skeleton, useToast } from '../../components';
import { colors, fonts, radius, spacing, typography } from '../../theme/tokens';
import { AccountFrame } from './AccountFrame';
import { authIdentitiesQuery } from './account-data';

const PROVIDER_META: Record<
  OAuthProvider,
  { label: string; icon: keyof typeof Ionicons.glyphMap }
> = {
  google: { label: 'Google', icon: 'logo-google' },
  apple: { label: 'Apple', icon: 'logo-apple' },
};

export function SignInMethodsScreen() {
  const identities = useQuery(authIdentitiesQuery);

  return (
    <AccountFrame title="Sign-in methods" backLabel="Back to preferences" backTo="/account/preferences">
      {identities.isPending ? (
        <View accessibilityLabel="Loading sign-in methods" style={styles.loading}>
          <Skeleton height={64} borderRadius={radius.lg} />
          <Skeleton height={80} borderRadius={radius.lg} />
        </View>
      ) : identities.isError ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>We could not load your sign-in methods.</Text>
          <PrimaryButton label="Try again" variant="secondary" onPress={() => void identities.refetch()} />
        </View>
      ) : (
        <SignInMethodsView
          hasPassword={identities.data.hasPassword}
          identities={identities.data.identities}
        />
      )}
    </AccountFrame>
  );
}

function SignInMethodsView({
  hasPassword,
  identities,
}: {
  hasPassword: boolean;
  identities: { provider: 'google' | 'apple'; email: string | null; linkedAt: string }[];
}) {
  const queryClient = useQueryClient();
  const { toast, oauth } = useSessionToast();

  const link = useMutation({
    mutationFn: async (provider: OAuthProvider) => {
      const adapter = provider === 'google' ? googleAdapter : appleAdapter;
      const result = await authenticateWithProvider(adapter, api.oauthNonce);
      return api.linkAuthIdentity(provider, { idToken: result.idToken, nonce: result.rawNonce });
    },
    onSuccess: (_data, provider) => {
      void queryClient.invalidateQueries({ queryKey: authIdentitiesQuery.queryKey });
      toast({ variant: 'success', message: `${PROVIDER_META[provider].label} linked.` });
    },
    onError: (error, provider) => {
      if (error instanceof OAuthCancelledError) return;
      if (error instanceof OAuthNotConfiguredError) {
        toast({
          variant: 'error',
          message: `${PROVIDER_META[provider].label} sign-in is not configured in this app.`,
        });
        return;
      }
      const message =
        error instanceof ApiError && error.code === 'LINK_REJECTED'
          ? error.message
          : `We could not link ${PROVIDER_META[provider].label}. Please try again.`;
      toast({ variant: 'error', message });
    },
  });

  const unlink = useMutation({
    mutationFn: (provider: OAuthProvider) => api.unlinkAuthIdentity(provider),
    onSuccess: (_data, provider) => {
      void queryClient.invalidateQueries({ queryKey: authIdentitiesQuery.queryKey });
      toast({ variant: 'success', message: `${PROVIDER_META[provider].label} unlinked.` });
    },
    onError: (error, provider) => {
      const message =
        error instanceof ApiError && error.code === 'LINK_REJECTED'
          ? 'You need at least one way to sign in. Add a password or another provider before unlinking this one.'
          : `We could not unlink ${PROVIDER_META[provider].label}. Please try again.`;
      toast({ variant: 'error', message });
    },
  });

  const confirmUnlink = (provider: OAuthProvider) => {
    Alert.alert(
      `Unlink ${PROVIDER_META[provider].label}?`,
      `You will no longer be able to sign in with ${PROVIDER_META[provider].label}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unlink', style: 'destructive', onPress: () => unlink.mutate(provider) },
      ],
    );
  };

  const busyProvider =
    link.isPending ? link.variables : unlink.isPending ? unlink.variables : null;

  const providers: OAuthProvider[] = ['google', 'apple'];

  return (
    <>
      <View style={styles.passwordCard}>
        <Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} />
        <Text style={styles.passwordText}>
          {hasPassword ? 'Password is set.' : 'No password set. Add one from the sign-in screen.'}
        </Text>
      </View>

      <View style={styles.providers}>
        {providers.map((provider) => {
          const linked = identities.find((identity) => identity.provider === provider) ?? null;
          const configured = provider === 'google' ? oauth.googleConfigured : oauth.appleConfigured;
          const meta = PROVIDER_META[provider];
          const busy = busyProvider === provider;

          return (
            <View key={provider} style={styles.providerRow}>
              <Ionicons name={meta.icon} size={22} color={colors.text} />
              <View style={styles.providerText}>
                <Text style={styles.providerName}>{meta.label}</Text>
                <Text style={styles.providerStatus}>
                  {linked ? (linked.email ? `Linked · ${linked.email}` : 'Linked') : 'Not linked'}
                </Text>
              </View>
              {linked ? (
                <ActionButton
                  label="Unlink"
                  destructive
                  loading={busy}
                  onPress={() => confirmUnlink(provider)}
                />
              ) : configured ? (
                <ActionButton label="Link" loading={busy} onPress={() => link.mutate(provider)} />
              ) : (
                <Text style={styles.notConfigured}>Not configured</Text>
              )}
            </View>
          );
        })}
      </View>
    </>
  );
}

/** useSession + useToast, bundled so the view reads one hook. */
function useSessionToast() {
  const { oauth } = useSession();
  const { toast } = useToast();
  return { oauth, toast };
}

function ActionButton({
  label,
  onPress,
  loading,
  destructive,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: Boolean(loading) }}
      disabled={loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionButton,
        destructive ? styles.actionDestructive : styles.actionDefault,
        pressed ? styles.actionPressed : null,
      ]}
    >
      <Text style={[styles.actionLabel, destructive ? styles.actionLabelDestructive : null]}>
        {loading ? '…' : label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  loading: {
    gap: spacing.md,
  },
  errorBox: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  errorText: {
    ...typography.body,
    color: colors.text,
  },
  passwordCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  passwordText: {
    ...typography.body,
    color: colors.textMuted,
    flex: 1,
  },
  providers: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    overflow: 'hidden',
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  providerText: {
    flex: 1,
    gap: 2,
  },
  providerName: {
    color: colors.text,
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
  },
  providerStatus: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  notConfigured: {
    color: colors.textSubtle,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  actionButton: {
    minWidth: 76,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
  },
  actionDefault: {
    borderColor: colors.borderActive,
    backgroundColor: 'transparent',
  },
  actionDestructive: {
    borderColor: colors.danger,
    backgroundColor: 'transparent',
  },
  actionPressed: {
    opacity: 0.7,
  },
  actionLabel: {
    color: colors.accent,
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
  },
  actionLabelDestructive: {
    color: colors.danger,
  },
});
