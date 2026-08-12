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
