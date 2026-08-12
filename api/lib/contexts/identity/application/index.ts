export { AuthenticationService, type SignUpInput } from './authentication.service';
export { SessionService, toPrincipal, type IssuedSession, type SessionMeta } from './session.service';
export {
  AccountLinkingService,
  type GoogleSignInInput,
  type AppleSignInInput,
  type LinkProviderInput,
  type LinkedCredentials,
} from './account-linking.service';
export { MemberClaimService, splitFullName } from './member-claiming';
export {
  StepUpService,
  StepUpRequiredError,
  StepUpFailedError,
  type StepUpMethod,
  type StepUpProof,
} from './step-up.service';
export { AccountErasureService, type AppleRevokeOutcome } from './account-erasure.service';
export type {
  PasswordHasher,
  FederatedIdTokenVerifier,
  AppleAuthGateway,
  SecretCipher,
  AuditLog,
  MemberDirectory,
} from './ports';
