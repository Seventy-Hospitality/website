import type { LinkRejectionReason } from './linking-policy';

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class InvalidTokenError extends AuthenticationError {
  constructor() {
    super('Invalid or expired token');
    this.name = 'InvalidTokenError';
  }
}

export class SessionExpiredError extends AuthenticationError {
  constructor() {
    super('Session has expired');
    this.name = 'SessionExpiredError';
  }
}

export class NotAuthorizedError extends AuthenticationError {
  constructor() {
    super('Not authorized');
    this.name = 'NotAuthorizedError';
  }
}

export class InvalidCredentialsError extends AuthenticationError {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

export class EmailInUseError extends Error {
  constructor() {
    super('An account with this email already exists');
    this.name = 'EmailInUseError';
  }
}

export class AccountUnavailableError extends AuthenticationError {
  constructor() {
    super('This account is not available');
    this.name = 'AccountUnavailableError';
  }
}

const LINK_REJECTION_MESSAGES: Record<LinkRejectionReason, string> = {
  account_unavailable: 'This account is not available',
  email_required: 'The identity provider did not share an email address',
  provider_email_unverified:
    'The identity provider could not verify this email; sign in with your password and link the provider from settings',
  linked_to_other_account: 'That provider account is already linked to another Club70 account',
  not_linked: 'That provider is not linked to this account',
  last_credential: 'Removing this would leave the account with no way to sign in',
};

export class LinkRejectedError extends AuthenticationError {
  constructor(readonly reason: LinkRejectionReason) {
    super(LINK_REJECTION_MESSAGES[reason]);
    this.name = 'LinkRejectedError';
  }
}

/** Thrown when an endpoint needing provider config is used without it. */
export class IdentityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityConfigError';
  }
}
