/**
 * Delete account (M6), native. Mirrors member-web's DeleteAccountPage: the
 * consequences card, a step-up gate selected by whether the account has a
 * password (current password) or not (an emailed re-auth code), a focus-trapped
 * final confirm, and the blocked state (open dispute / refund in flight). The
 * password/code is never logged. Any 202 response means the deletion saga is
 * running server-side, so we sign out locally and leave.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { ApiError, api, type DeleteAccountProof } from '../../lib/api';
import { useSession } from '../../lib/session';
import { FormField, Input, PasswordInput, PrimaryButton, Sheet, Skeleton, useToast } from '../../components';
import { colors, fonts, radius, spacing, typography } from '../../theme/tokens';
import { AccountFrame } from './AccountFrame';
import { authIdentitiesQuery } from './account-data';
import { formatReasons } from './account-lib';

const CONSEQUENCES = [
  'Cancels your membership immediately, with no refund for the current period.',
  'Cancels upcoming reservations (refunded per the standard cancellation policy).',
  'Removes you from clubs and withdraws invitations you sent.',
  'Anonymizes your profile and retires your member number.',
  'Signs you out everywhere and permanently disables sign-in.',
];

export function DeleteAccountScreen() {
  const identities = useQuery(authIdentitiesQuery);

  return (
    <AccountFrame title="Delete account" backLabel="Back to preferences" backTo="/account/preferences">
      <View style={styles.consequences}>
        <Text style={styles.consequencesTitle}>Deleting your account:</Text>
        {CONSEQUENCES.map((line) => (
          <View key={line} style={styles.bulletRow}>
            <Ionicons name="ellipse" size={5} color={colors.textMuted} style={styles.bullet} />
            <Text style={styles.bulletText}>{line}</Text>
          </View>
        ))}
        <Text style={styles.cannotUndo}>This cannot be undone.</Text>
      </View>

      {identities.isPending ? (
        <Skeleton height={160} borderRadius={radius.lg} />
      ) : identities.isError ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>We could not load your confirmation options.</Text>
          <PrimaryButton label="Try again" variant="secondary" onPress={() => void identities.refetch()} />
        </View>
      ) : (
        <DeleteAccountFlow hasPassword={identities.data.hasPassword} />
      )}
    </AccountFrame>
  );
}

function DeleteAccountFlow({ hasPassword }: { hasPassword: boolean }) {
  const router = useRouter();
  const { principal, signOut } = useSession();
  const { toast } = useToast();

  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [blockedReasons, setBlockedReasons] = useState<string[] | null>(null);

  const proofValue = hasPassword ? password : code;
  const proofReady = proofValue.trim().length > 0;
  const proof: DeleteAccountProof = hasPassword
    ? { password }
    : { reauthToken: code.trim() };

  const sendCode = useMutation({
    mutationFn: api.requestReauthEmail,
    onSuccess: () => {
      setCodeSent(true);
      setStepUpError(null);
    },
    onError: (error) => {
      setStepUpError(
        error instanceof ApiError && error.status === 429
          ? 'Too many codes requested. Please wait 15 minutes and try again.'
          : 'We could not send the code. Please try again.',
      );
    },
  });

  const del = useMutation({
    mutationFn: (input: DeleteAccountProof) => api.deleteAccount(input),
    onSuccess: async () => {
      setConfirmOpen(false);
      toast({ variant: 'success', message: 'Your account has been deleted.' });
      try {
        await signOut();
      } finally {
        router.replace('/auth/sign-in');
      }
    },
    onError: (error) => {
      setConfirmOpen(false);
      if (error instanceof ApiError) {
        if (error.code === 'DELETION_BLOCKED') {
          const details = error.details as { reasons?: string[] } | undefined;
          setBlockedReasons(details?.reasons ?? []);
          return;
        }
        if (error.code === 'STEP_UP_FAILED' || error.code === 'STEP_UP_REQUIRED') {
          setStepUpError(
            hasPassword
              ? 'That password is incorrect.'
              : 'That code was not accepted. It may have expired; send yourself a new one.',
          );
          return;
        }
        if (error.status === 429) {
          setStepUpError('Too many attempts. Please wait 15 minutes and try again.');
          return;
        }
      }
      setStepUpError('Something went wrong. Please try again.');
    },
  });

  // ── Blocked state (dispute / refund in flight): replaces the form. ──
  if (blockedReasons !== null) {
    return (
      <View style={styles.blockedBox} accessibilityRole="alert">
        <Text style={styles.blockedTitle}>We cannot delete your account right now.</Text>
        {blockedReasons.length > 0 ? (
          <Text style={styles.blockedBody}>
            Deletion is blocked by {formatReasons(blockedReasons)}. Once that is resolved you can try
            again.
          </Text>
        ) : (
          <Text style={styles.blockedBody}>
            Deletion is blocked by a pending billing item. Once it resolves you can try again.
          </Text>
        )}
        <Text style={styles.blockedBody}>Contact the club if you need help resolving this.</Text>
        <PrimaryButton
          label="Back to preferences"
          variant="secondary"
          onPress={() => router.replace('/account/preferences')}
        />
      </View>
    );
  }

  const submit = () => {
    if (!proofReady || del.isPending) return;
    setConfirmOpen(true);
  };

  return (
    <View style={styles.form}>
      {hasPassword ? (
        <FormField
          label="Current password"
          error={stepUpError ?? undefined}
          hint="Confirm it is really you before we delete anything."
        >
          <PasswordInput
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              if (stepUpError) setStepUpError(null);
            }}
            autoComplete="current-password"
            textContentType="password"
            placeholder="Your password"
            hasError={Boolean(stepUpError)}
            accessibilityLabel="Current password"
          />
        </FormField>
      ) : (
        <View style={styles.codeBlock}>
          <Text style={styles.codeIntro}>
            {codeSent
              ? `We emailed a confirmation code to ${principal?.email ?? 'your address'}. It expires in 10 minutes.`
              : 'Your account has no password, so we confirm it is really you with an emailed code.'}
          </Text>
          <PrimaryButton
            label={codeSent ? 'Send a new code' : 'Email me a code'}
            variant="secondary"
            loading={sendCode.isPending}
            onPress={() => sendCode.mutate()}
          />
          {codeSent ? (
            <FormField label="Confirmation code" error={stepUpError ?? undefined}>
              <Input
                value={code}
                onChangeText={(text) => {
                  setCode(text);
                  if (stepUpError) setStepUpError(null);
                }}
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                autoCapitalize="none"
                placeholder="Enter the code"
                hasError={Boolean(stepUpError)}
                accessibilityLabel="Confirmation code"
              />
            </FormField>
          ) : stepUpError ? (
            <Text style={styles.errorText} accessibilityRole="alert">
              {stepUpError}
            </Text>
          ) : null}
        </View>
      )}

      <View style={styles.actions}>
        <PrimaryButton
          label="Delete my account"
          variant="danger"
          disabled={!proofReady}
          loading={del.isPending}
          onPress={submit}
        />
        <PrimaryButton
          label="Keep my account"
          variant="ghost"
          disabled={del.isPending}
          onPress={() => router.replace('/account/preferences')}
        />
      </View>

      <Sheet
        open={confirmOpen}
        onClose={() => {
          if (!del.isPending) setConfirmOpen(false);
        }}
        title="Delete account"
      >
        <View style={styles.dialog}>
          <View style={styles.dialogHeader}>
            <Ionicons name="warning" size={22} color={colors.danger} />
            <Text style={styles.dialogTitle}>
              This permanently deletes your account, membership, and reservations.
            </Text>
          </View>
          <Text style={styles.dialogHint}>
            There is no undo and no recovery period. Your member number is retired and your profile is
            anonymized.
          </Text>
          <View style={styles.dialogActions}>
            <PrimaryButton
              label="Permanently delete my account"
              variant="danger"
              loading={del.isPending}
              onPress={() => del.mutate(proof)}
            />
            <PrimaryButton
              label="Go back"
              variant="ghost"
              disabled={del.isPending}
              onPress={() => setConfirmOpen(false)}
            />
          </View>
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  consequences: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  consequencesTitle: {
    ...typography.bodyStrong,
    color: colors.text,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  bullet: {
    marginTop: 7,
  },
  bulletText: {
    flex: 1,
    ...typography.body,
    color: colors.textMuted,
  },
  cannotUndo: {
    ...typography.bodyStrong,
    color: colors.text,
    marginTop: spacing.xs,
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
    color: colors.danger,
  },
  form: {
    gap: spacing.lg,
  },
  codeBlock: {
    gap: spacing.md,
  },
  codeIntro: {
    ...typography.body,
    color: colors.textMuted,
  },
  actions: {
    gap: spacing.sm,
  },
  blockedBox: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.bgElevated,
  },
  blockedTitle: {
    ...typography.h3,
    color: colors.text,
  },
  blockedBody: {
    ...typography.body,
    color: colors.textMuted,
  },
  dialog: {
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  dialogHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  dialogTitle: {
    flex: 1,
    ...typography.bodyStrong,
    color: colors.text,
  },
  dialogHint: {
    ...typography.body,
    color: colors.textMuted,
  },
  dialogActions: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
});
