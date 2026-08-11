/**
 * Stripe Elements provider for the member theme. Flow packages (W1
 * checkout, W3 booking payment, W6 payment methods) wrap their payment UI
 * in <StripeProvider clientSecret={...}> and use the Payment Element.
 *
 * With no VITE_STRIPE_PUBLISHABLE_KEY the provider renders a clear
 * "payments not configured" notice instead of its children, so the app
 * always runs in unconfigured environments.
 */
import type { ReactNode } from 'react';
import { Elements } from '@stripe/react-stripe-js';
import { getStripe, stripeAppearance } from './stripe';
import { EmptyState } from '../components/EmptyState';

export function StripeProvider({
  clientSecret,
  children,
}: {
  clientSecret: string;
  children: ReactNode;
}) {
  const stripe = getStripe();

  if (!stripe) {
    return (
      <EmptyState
        title="Payments are not configured"
        description="Set VITE_STRIPE_PUBLISHABLE_KEY to enable checkout in this environment."
      />
    );
  }

  return (
    <Elements stripe={stripe} options={{ clientSecret, appearance: stripeAppearance }}>
      {children}
    </Elements>
  );
}
