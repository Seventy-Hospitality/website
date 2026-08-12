/**
 * Public surface of the account feature (M6). The Account tab renders
 * AccountScreen; the route files under app/account/** render the billing,
 * preferences, payment-method, change-membership, delete, and sign-in-methods
 * screens. The auth screens (sign in/up, magic-link callback, forgot password)
 * from M0/M1 also live in this directory and are imported directly by their
 * routes. Data definitions + pure helpers are exported for tests and
 * cross-feature cache work.
 */
export { AccountScreen } from './AccountScreen';
export { BillingScreen } from './BillingScreen';
export { PreferencesScreen } from './PreferencesScreen';
export { PaymentMethodScreen } from './PaymentMethodScreen';
export { ChangeMembershipScreen } from './ChangeMembershipScreen';
export { DeleteAccountScreen } from './DeleteAccountScreen';
export { SignInMethodsScreen } from './SignInMethodsScreen';

export {
  profileQuery,
  billingQuery,
  preferencesQuery,
  authIdentitiesQuery,
  billingTransactionsQuery,
  invalidateBillingState,
} from './account-data';

export * from './account-lib';
