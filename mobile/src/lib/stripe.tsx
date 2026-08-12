/**
 * Stripe PaymentSheet plumbing for the mobile app (SAQ-A: no raw card data
 * ever touches our code; the sheet collects and tokenizes cards natively).
 *
 * StripeAppProvider mounts @stripe/stripe-react-native's StripeProvider with
 * the publishable key from EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY. With no key it
 * still renders its children (the app must run unconfigured) but exposes
 * `configured: false`, and usePaymentSheet() short-circuits with an
 * `unconfigured` result so flow packages can show a "payments not configured"
 * notice instead of crashing.
 *
 * The onboarding / booking / account flows call the hook returned by
 * usePaymentSheet() with a client secret (and, for a customer-scoped sheet,
 * the ephemeral key + customer id the billing API mints).
 */
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { StripeProvider, useStripe } from '@stripe/stripe-react-native';
import { STRIPE_MERCHANT_ID, STRIPE_PUBLISHABLE_KEY } from './env';

interface PaymentsContextValue {
  configured: boolean;
}

const PaymentsContext = createContext<PaymentsContextValue>({ configured: false });

export function StripeAppProvider({ children }: { children: ReactNode }) {
  if (!STRIPE_PUBLISHABLE_KEY) {
    return (
      <PaymentsContext.Provider value={{ configured: false }}>{children}</PaymentsContext.Provider>
    );
  }

  return (
    <StripeProvider
      publishableKey={STRIPE_PUBLISHABLE_KEY}
      merchantIdentifier={STRIPE_MERCHANT_ID ?? undefined}
    >
      <PaymentsContext.Provider value={{ configured: true }}>{children}</PaymentsContext.Provider>
    </StripeProvider>
  );
}

/** Whether Stripe is configured (drives the "payments not configured" notice). */
export function usePaymentsConfigured(): boolean {
  return useContext(PaymentsContext).configured;
}

export interface PresentPaymentParams {
  /** PaymentIntent (or SetupIntent) client secret from the billing API. */
  clientSecret: string;
  /** 'setup' for a card-on-file sheet (setup-intent); default 'payment'. */
  intent?: 'payment' | 'setup';
  /** Stripe customer id + ephemeral key for a saved-cards sheet. */
  customerId?: string;
  ephemeralKeySecret?: string;
  merchantDisplayName?: string;
  /** Prefilled billing name shown on the sheet. */
  billingName?: string;
}

export type PresentPaymentResult =
  | { status: 'completed' }
  | { status: 'canceled' }
  | { status: 'unconfigured' }
  | { status: 'failed'; message: string };

/**
 * Returns a stable async function that initializes and presents the
 * PaymentSheet for a given client secret. Mirrors the web hold/confirm
 * posture: the caller confirms/settles server-side after `completed`.
 */
export function usePaymentSheet() {
  const { configured } = useContext(PaymentsContext);
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  return useCallback(
    async (params: PresentPaymentParams): Promise<PresentPaymentResult> => {
      if (!configured) return { status: 'unconfigured' };

      const common = {
        merchantDisplayName: params.merchantDisplayName ?? 'Club70',
        customerId: params.customerId,
        customerEphemeralKeySecret: params.ephemeralKeySecret,
        defaultBillingDetails: params.billingName ? { name: params.billingName } : undefined,
      };

      const initResult =
        params.intent === 'setup'
          ? await initPaymentSheet({ ...common, setupIntentClientSecret: params.clientSecret })
          : await initPaymentSheet({ ...common, paymentIntentClientSecret: params.clientSecret });

      if (initResult.error) {
        return { status: 'failed', message: initResult.error.message };
      }

      const presentResult = await presentPaymentSheet();
      if (presentResult.error) {
        if (presentResult.error.code === 'Canceled') return { status: 'canceled' };
        return { status: 'failed', message: presentResult.error.message };
      }

      return { status: 'completed' };
    },
    [configured, initPaymentSheet, presentPaymentSheet],
  );
}

// ── Save-a-card (SetupIntent) flow for the account payment-method screen (M6) ──

export interface SetupPaymentParams {
  /** SetupIntent client secret from POST /api/me/payment-methods/setup-intent. */
  clientSecret: string;
  /** Stripe customer id + ephemeral key so the sheet can attach the card. */
  customerId?: string;
  ephemeralKeySecret?: string;
  merchantDisplayName?: string;
  billingName?: string;
}

/**
 * Outcome of saving a card. `completed` carries the saved payment-method id so
 * the caller can POST it to /payment-methods/:id/default; `processing` means an
 * async method is still clearing (park in a hold and poll); the rest mirror the
 * PaymentSheet result union.
 */
export type SetupPaymentResult =
  | { status: 'completed'; paymentMethodId: string }
  | { status: 'processing' }
  | { status: 'canceled' }
  | { status: 'unconfigured' }
  | { status: 'failed'; message: string };

/**
 * Present the PaymentSheet in setup mode to save a card, then read the
 * SetupIntent back to recover the payment-method id and its clearing status.
 *
 * The web version returns from a redirect and calls `stripe.retrieveSetupIntent`
 * to promote the card to default; the native version does the same read after
 * the sheet dismisses. `poll` re-reads the intent for the "Check again" hold on
 * a still-processing card, without re-presenting the sheet.
 */
export function useSetupPaymentMethod() {
  const { configured } = useContext(PaymentsContext);
  const { initPaymentSheet, presentPaymentSheet, retrieveSetupIntent } = useStripe();

  const readIntent = useCallback(
    async (clientSecret: string): Promise<SetupPaymentResult> => {
      const { setupIntent, error } = await retrieveSetupIntent(clientSecret);
      if (error || !setupIntent) {
        return { status: 'failed', message: error?.message ?? 'We could not confirm your card.' };
      }
      const paymentMethodId = setupIntent.paymentMethod?.id ?? setupIntent.paymentMethodId ?? null;
      const status = String(setupIntent.status);
      if (status === 'Succeeded') {
        if (!paymentMethodId) {
          return { status: 'failed', message: 'Your card was saved but could not be identified.' };
        }
        return { status: 'completed', paymentMethodId };
      }
      if (status === 'Processing') return { status: 'processing' };
      return { status: 'failed', message: 'Your card could not be saved. Please try again.' };
    },
    [retrieveSetupIntent],
  );

  const present = useCallback(
    async (params: SetupPaymentParams): Promise<SetupPaymentResult> => {
      if (!configured) return { status: 'unconfigured' };

      const init = await initPaymentSheet({
        merchantDisplayName: params.merchantDisplayName ?? 'Club70',
        customerId: params.customerId,
        customerEphemeralKeySecret: params.ephemeralKeySecret,
        setupIntentClientSecret: params.clientSecret,
        defaultBillingDetails: params.billingName ? { name: params.billingName } : undefined,
      });
      if (init.error) return { status: 'failed', message: init.error.message };

      const presentResult = await presentPaymentSheet();
      if (presentResult.error) {
        if (presentResult.error.code === 'Canceled') return { status: 'canceled' };
        return { status: 'failed', message: presentResult.error.message };
      }

      return readIntent(params.clientSecret);
    },
    [configured, initPaymentSheet, presentPaymentSheet, readIntent],
  );

  const poll = useCallback(
    async (clientSecret: string): Promise<SetupPaymentResult> => {
      if (!configured) return { status: 'unconfigured' };
      return readIntent(clientSecret);
    },
    [configured, readIntent],
  );

  return { configured, present, poll };
}
