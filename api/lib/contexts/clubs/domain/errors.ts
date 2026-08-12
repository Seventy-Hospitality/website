export class ClubValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClubValidationError';
  }
}

/**
 * The one answer outsiders get. A club a caller is not a member of answers
 * exactly like a club that does not exist, so club ids cannot be probed.
 */
export class ClubNotFoundError extends Error {
  constructor(id: string) {
    super(`Club not found: ${id}`);
    this.name = 'ClubNotFoundError';
  }
}

/** A club member attempting an owner-only action (the club itself is visible). */
export class ClubPermissionError extends Error {
  constructor(message = 'Only the club owner can do this') {
    super(message);
    this.name = 'ClubPermissionError';
  }
}

export class ClubMemberNotFoundError extends Error {
  constructor() {
    super('This member is not in the club');
    this.name = 'ClubMemberNotFoundError';
  }
}

export class OwnerMustTransferFirstError extends Error {
  constructor() {
    super('Transfer ownership before leaving the club');
    this.name = 'OwnerMustTransferFirstError';
  }
}

export class ClubMustHaveOwnerError extends Error {
  constructor() {
    super('A club always needs an owner; transfer ownership instead');
    this.name = 'ClubMustHaveOwnerError';
  }
}

export class CannotRemoveClubOwnerError extends Error {
  constructor() {
    super('The owner cannot be removed from the club; transfer ownership first');
    this.name = 'CannotRemoveClubOwnerError';
  }
}

export class ClubInvitationNotFoundError extends Error {
  constructor(id: string) {
    super(`Club invitation not found: ${id}`);
    this.name = 'ClubInvitationNotFoundError';
  }
}

export class InvalidInvitationStateError extends Error {
  constructor(current: string, response: string) {
    super(`Cannot ${response} an invitation that is ${current}`);
    this.name = 'InvalidInvitationStateError';
  }
}

export class ClubInviteeNotFoundError extends Error {
  constructor(ids: string[]) {
    super(`Member not found: ${ids.join(', ')}`);
    this.name = 'ClubInviteeNotFoundError';
  }
}

export type InviteLinkFailure = 'invalid' | 'revoked' | 'expired' | 'exhausted';

const INVITE_LINK_MESSAGES: Record<InviteLinkFailure, string> = {
  invalid: 'This invite link is not valid',
  revoked: 'This invite link has been revoked',
  expired: 'This invite link has expired',
  exhausted: 'This invite link has reached its usage limit',
};

/** An unusable share link/QR: unknown, revoked, expired or used up. */
export class InviteLinkInvalidError extends Error {
  constructor(public readonly reason: InviteLinkFailure) {
    super(INVITE_LINK_MESSAGES[reason]);
    this.name = 'InviteLinkInvalidError';
  }
}
