/**
 * Typed access to build-time (public) configuration. Every value is
 * optional: the app must run with an empty env, exactly like the web client.
 * With no OAuth client IDs the sign-in buttons render disabled ("not
 * configured") and load no SDK; with no Stripe key the payment flows show a
 * configuration notice. See .env.example for the full list.
 *
 * Only EXPO_PUBLIC_* vars are inlined into the bundle at build time.
 */

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** API origin. Defaults to the local dev API. */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Stripe publishable key (pk_...); null disables PaymentSheet. */
export const STRIPE_PUBLISHABLE_KEY = optional(process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY);

/** Apple merchant identifier for Apple Pay in PaymentSheet (optional). */
export const STRIPE_MERCHANT_ID = optional(process.env.EXPO_PUBLIC_STRIPE_MERCHANT_ID);

/** Google OAuth client IDs (native ID-token flow). Any absent = degraded. */
export const GOOGLE_IOS_CLIENT_ID = optional(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID);
export const GOOGLE_ANDROID_CLIENT_ID = optional(process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID);
export const GOOGLE_WEB_CLIENT_ID = optional(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID);

/** Sign in with Apple services ID (used for the web audience / Android). */
export const APPLE_CLIENT_ID = optional(process.env.EXPO_PUBLIC_APPLE_CLIENT_ID);
