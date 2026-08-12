/**
 * Payment method screen (M6): save/replace the card on file. Mirrors
 * member-web's PaymentMethodPage translated to the native PaymentSheet — POST
 * /payment-methods/setup-intent, present the sheet in setup mode with the
 * customer + ephemeral key, read the saved payment-method id back, then POST it
 * to /payment-methods/:id/default. An async card that has not cleared parks in
 * a "confirming" hold with a manual re-check (no double-save). Card data never
 * touches our code (PCI SAQ A).
 */
import { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../lib/api';
import { useSetupPaymentMethod } from '../../lib/stripe';
import { EmptyStateView, PrimaryButton, Skeleton } from '../../components';
import { colors, fonts, radius, spacing, typography } from '../../theme/tokens';
import { AccountFrame } from './AccountFrame';
import { billingQuery, invalidateBillingState } from './account-data';
import { paymentMethodLabel } from './account-lib';

type Phase = 'idle' | 'saving' | 'processing';

export function PaymentMethodScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const sheet = useSetupPaymentMethod();
  const billing = useQuery(billingQuery);

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [processingSecret, setProcessingSecret] = useState<string | null>(null);
  const [savedPmId, setSavedPmId] = useState<string | null>(null);

  const setDefault = useMutation({
    mutationFn: (paymentMethodId: string) => api.setDefaultPaymentMethod(paymentMethodId),
    onSuccess: () => {
      invalidateBillingState(queryClient);
      done();
    },
    onError: () => {
      setError('Your card was saved, but we could not make it your default. Try again; you will not be charged.');
      setPhase('idle');
    },
  });

  const done = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/account/billing');
  }, [router]);

  const promote = useCallback(
    (paymentMethodId: string) => {
      setSavedPmId(paymentMethodId);
      setError(null);
      setDefault.mutate(paymentMethodId);
    },
    [setDefault],
  );

  const save = useCallback(async () => {
    if (phase === 'saving') return;
    setError(null);
    setNote(null);
    if (!sheet.configured) {
      setError('Payments are not configured in this environment.');
      return;
    }

    setPhase('saving');
    let intent;
    try {
      intent = await api.createSetupIntent();
    } catch {
      setError('We could not start the card update. Please try again.');
      setPhase('idle');
      return;
    }

    const result = await sheet.present({
      clientSecret: intent.clientSecret,
      customerId: intent.customerId,
      ephemeralKeySecret: intent.ephemeralKeySecret,
    });

    if (result.status === 'canceled') {
      setPhase('idle');
      return;
    }
    if (result.status === 'unconfigured') {
      setError('Payments are not configured in this environment.');
      setPhase('idle');
      return;
    }
    if (result.status === 'failed') {
      setError(result.message || 'Your card could not be saved. Please try again.');
      setPhase('idle');
      return;
    }
    if (result.status === 'processing') {
      setProcessingSecret(intent.clientSecret);
      setPhase('processing');
      return;
    }
    // completed
    promote(result.paymentMethodId);
  }, [phase, sheet, promote]);

  const checkProcessing = useCallback(async () => {
    if (!processingSecret) return;
    setNote(null);
    const result = await sheet.poll(processingSecret);
    if (result.status === 'completed') {
      setProcessingSecret(null);
      promote(result.paymentMethodId);
      return;
    }
    if (result.status === 'processing') {
      setNote('Still confirming. Give it a moment and check again.');
      return;
    }
    // failed / unconfigured
    setProcessingSecret(null);
    setPhase('idle');
    setError('Your card could not be saved. Please try again.');
  }, [processingSecret, sheet, promote]);

  const currentCard = billing.data?.defaultPaymentMethod ?? null;
  const busy = phase === 'saving' || setDefault.isPending;

  return (
    <AccountFrame title="Payment method" backLabel="Back to billing" backTo="/account/billing">
      {!sheet.configured ? (
        <EmptyStateView
          title="Payments are not configured"
          description="Set EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY to update your card in this environment."
        />
      ) : phase === 'processing' ? (
        <View style={styles.panel} accessibilityRole="progressbar">
          <Text style={styles.panelTitle}>Your payment method is being confirmed</Text>
          <Text style={styles.panelBody}>
            Your previous payment method stays the default until this one clears. Check again to finish
            the switch.
          </Text>
          {note ? <Text style={styles.note}>{note}</Text> : null}
          {setDefault.isError ? (
            <Text style={styles.errorText} accessibilityRole="alert">
              Your payment method cleared, but we could not make it your default. Check again to retry.
            </Text>
          ) : null}
          <PrimaryButton
            label="Check again"
            loading={setDefault.isPending}
            onPress={() => void checkProcessing()}
          />
          <PrimaryButton label="Back to billing" variant="ghost" onPress={done} />
        </View>
      ) : (
        <>
          {billing.isPending ? (
            <Skeleton height={64} borderRadius={radius.lg} />
          ) : currentCard ? (
            <View style={styles.currentCard}>
              <Text style={styles.currentLabel}>Current card</Text>
              <View style={styles.currentRow}>
                <View style={styles.brandChip}>
                  <Text style={styles.brandChipText}>{currentCard.brand.toUpperCase()}</Text>
                </View>
                <Text style={styles.currentText}>{paymentMethodLabel(currentCard)}</Text>
              </View>
            </View>
          ) : (
            <Text style={styles.body}>Add a card to pay for your membership and bookings.</Text>
          )}

          <View style={styles.secureRow}>
            <Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} />
            <Text style={styles.secureText}>Card details are entered securely in the next step.</Text>
          </View>

          {setDefault.isError && savedPmId ? (
            <View style={styles.retryBox} accessibilityRole="alert">
              <Text style={styles.errorText}>{error}</Text>
              <PrimaryButton
                label="Try again"
                variant="secondary"
                loading={setDefault.isPending}
                onPress={() => promote(savedPmId)}
              />
            </View>
          ) : error ? (
            <Text style={styles.errorText} accessibilityRole="alert">
              {error}
            </Text>
          ) : null}

          <PrimaryButton
            label={currentCard ? 'Update card' : 'Add card'}
            loading={busy}
            onPress={() => void save()}
          />
        </>
      )}
    </AccountFrame>
  );
}

const styles = StyleSheet.create({
  body: {
    ...typography.body,
    color: colors.textMuted,
  },
  currentCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  currentLabel: {
    ...typography.label,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  currentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  brandChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceOverlay,
  },
  brandChipText: {
    color: colors.text,
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  currentText: {
    color: colors.text,
    fontFamily: fonts.bodyMedium,
    fontSize: 15,
  },
  secureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  secureText: {
    ...typography.body,
    color: colors.textMuted,
    flex: 1,
  },
  panel: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  panelTitle: {
    ...typography.h3,
    color: colors.text,
  },
  panelBody: {
    ...typography.body,
    color: colors.textMuted,
  },
  note: {
    ...typography.body,
    color: colors.textMuted,
  },
  errorText: {
    ...typography.body,
    color: colors.danger,
  },
  retryBox: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
});
