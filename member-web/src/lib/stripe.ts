/**
 * Stripe.js loading and the member-theme Elements appearance. The provider
 * component lives in StripeProvider.tsx.
 */
import { loadStripe, type Appearance, type Stripe } from '@stripe/stripe-js';
import { STRIPE_PUBLISHABLE_KEY } from './env';
import { colors, fonts, radius } from '../theme/tokens';

let stripePromise: Promise<Stripe | null> | null = null;

/** Lazily loaded Stripe.js handle; null when no publishable key is set. */
export function getStripe(): Promise<Stripe | null> | null {
  if (!STRIPE_PUBLISHABLE_KEY) return null;
  stripePromise ??= loadStripe(STRIPE_PUBLISHABLE_KEY);
  return stripePromise;
}

/** Payment Element appearance derived from the member design tokens. */
export const stripeAppearance: Appearance = {
  theme: 'night',
  variables: {
    colorPrimary: colors.accent,
    colorBackground: colors.bgElevated,
    colorText: colors.text,
    colorTextSecondary: colors.textMuted,
    colorTextPlaceholder: colors.textSubtle,
    colorDanger: colors.danger,
    fontFamily: fonts.body,
    borderRadius: `${radius.md}px`,
  },
  rules: {
    '.Input': {
      border: `1px solid ${colors.border}`,
      boxShadow: 'none',
    },
    '.Input:focus': {
      border: `1px solid ${colors.borderActive}`,
      boxShadow: 'none',
    },
    '.Label': {
      color: colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: '0.125rem',
      fontSize: '0.75rem',
    },
  },
};
