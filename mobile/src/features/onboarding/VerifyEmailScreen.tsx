/**
 * Onboarding step 0 (the 'verify-email' resume step): a claim-pending signup
 * (email matched a staff-created member row) has no member profile until the
 * email is verified. This is the prompt the resume gate routes such an account
 * to; M0 shipped no standalone verify-email surface, so onboarding owns it.
 *
 * The member verifies from the email we sent, then taps "I've verified" to
 * re-read the Principal; the gate resolves the next step from the fresh read.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSession } from '../../lib/session';
import { useToast } from '../../components/toast-context';
import { AppScreen } from '../../components/AppScreen';
import { PrimaryButton } from '../../components/PrimaryButton';
import { colors, spacing, typography } from '../../theme/tokens';

export function VerifyEmailScreen() {
  const { user, refresh, resendVerification, signOut } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [resent, setResent] = useState(false);

  const refreshMutation = useMutation({
    mutationFn: async () => {
      await queryClient.invalidateQueries({ queryKey: ['onboarding'] });
      return refresh();
    },
    onSuccess: (principal) => {
      // Still unverified: nudge; the gate keeps them here otherwise.
      if (principal && !principal.emailVerified) {
        toast({ variant: 'info', message: 'Still waiting on verification. Check your inbox.' });
      }
    },
  });

  const resend = useMutation({
    mutationFn: resendVerification,
    onSuccess: () => {
      setResent(true);
      toast({ variant: 'success', message: 'Verification email sent.' });
    },
    onError: () => toast({ variant: 'error', message: 'Could not resend right now.' }),
  });

  const signOutMutation = useMutation({ mutationFn: signOut });

  return (
    <AppScreen contentStyle={styles.content}>
      <View style={styles.icon}>
        <Ionicons name="mail-outline" size={32} color={colors.accent} />
      </View>
      <Text style={styles.title}>Verify your email</Text>
      <Text style={styles.body}>
        We sent a verification link to {user?.email ?? 'your email'}. Open it to activate your
        membership, then come back here.
      </Text>

      <View style={styles.actions}>
        <PrimaryButton
          label="I've verified my email"
          loading={refreshMutation.isPending}
          onPress={() => refreshMutation.mutate()}
        />
        <PrimaryButton
          label={resent ? 'Resend again' : 'Resend email'}
          variant="ghost"
          loading={resend.isPending}
          onPress={() => resend.mutate()}
        />
        <PrimaryButton
          label="Sign out"
          variant="ghost"
          loading={signOutMutation.isPending}
          onPress={() => signOutMutation.mutate()}
        />
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.md,
    marginTop: spacing.xl,
  },
  icon: {
    width: 64,
    height: 64,
    borderRadius: 999,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    ...typography.display,
    color: colors.text,
  },
  body: {
    ...typography.body,
    color: colors.textMuted,
  },
  actions: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
});
