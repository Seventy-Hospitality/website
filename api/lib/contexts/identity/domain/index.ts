export type { Client, StaffRole, AuthenticatedUser } from './principal';
export {
  type OneTimeTokenPurpose,
  type OneTimeToken,
  TOKEN_TTL_MINUTES,
  tokenExpiry,
  generateToken,
  hashToken,
} from './tokens';
export {
  type SessionPolicy,
  type SessionState,
  SESSION_POLICIES,
  ACCESS_TOKEN_TTL_MINUTES,
  REFRESH_ROTATION_GRACE_MS,
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  LEGACY_SESSION_COOKIE_NAME,
  isSessionActive,
  sessionExpiries,
  extendedIdleExpiry,
  isWithinRotationGrace,
} from './session-policy';
export {
  type Provider,
  type ProviderAssertion,
  type LinkContext,
  type LinkDecision,
  type LinkRejectionReason,
  type MemberClaimContext,
  type MemberClaimDecision,
  decideLink,
  decideMemberClaim,
} from './linking-policy';
export {
  AuthenticationError,
  InvalidTokenError,
  SessionExpiredError,
  NotAuthorizedError,
  InvalidCredentialsError,
  EmailInUseError,
  AccountUnavailableError,
  LinkRejectedError,
  IdentityConfigError,
} from './errors';
