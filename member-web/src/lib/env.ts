/**
 * Typed access to build-time configuration. Every value is optional: the app
 * must run with an empty .env (same-origin API, OAuth buttons in their
 * "not configured" state, Stripe flows showing a configuration notice).
 */

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** API origin; empty string means same-origin (dev proxy / prod serving). */
export const API_URL = optional(import.meta.env.VITE_API_URL) ?? '';

/** Google Identity Services web client ID. */
export const GOOGLE_CLIENT_ID = optional(import.meta.env.VITE_GOOGLE_CLIENT_ID);

/** Sign in with Apple services ID (the web audience). */
export const APPLE_CLIENT_ID = optional(import.meta.env.VITE_APPLE_CLIENT_ID);

/** Stripe publishable key. */
export const STRIPE_PUBLISHABLE_KEY = optional(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);
