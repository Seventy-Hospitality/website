import { z } from 'zod';

// ── State ──

export interface Member {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  memberNumber: string;
  displayName: string | null;
  avatarUrl: string | null;
  deletedAt: Date | null;
  stripeCustomerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ── Member number ──
// The stable human-facing member id shown as "#A12345": one uppercase letter
// (I and O excluded — too close to 1 and 0) followed by five digits. Random,
// not sequential (a public identifier must not leak member count or join
// order); uniqueness is the DB's unique index, callers retry on collision.
// Retired forever on account deletion: the anonymized row keeps its number.

const MEMBER_NUMBER_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export const MEMBER_NUMBER_PATTERN = /^[A-HJ-NP-Z][0-9]{5}$/;

export function generateMemberNumber(random: () => number = Math.random): string {
  const letter = MEMBER_NUMBER_LETTERS[Math.floor(random() * MEMBER_NUMBER_LETTERS.length)];
  const digits = String(Math.floor(random() * 100000)).padStart(5, '0');
  return `${letter}${digits}`;
}

/**
 * Presentation name: the member-chosen display name when set, else the
 * legal first/last pair.
 */
export function memberDisplayName(member: Pick<Member, 'firstName' | 'lastName' | 'displayName'>): string {
  return member.displayName?.trim() || `${member.firstName} ${member.lastName}`.trim();
}

// ── Validation (domain rules, not HTTP validation) ──

export const memberInvariants = {
  /** Members must have a valid email */
  validateEmail(email: string): void {
    if (!z.string().email().safeParse(email).success) {
      throw new MemberValidationError('Invalid email address');
    }
  },

  /** Members must have non-empty names */
  validateName(firstName: string, lastName: string): void {
    if (!firstName.trim() || !lastName.trim()) {
      throw new MemberValidationError('First and last name are required');
    }
  },

  /** Display names are optional but never blank or unbounded when present */
  validateDisplayName(displayName: string | null): void {
    if (displayName === null) return;
    if (!displayName.trim()) {
      throw new MemberValidationError('Display name cannot be blank');
    }
    if (displayName.length > 60) {
      throw new MemberValidationError('Display name must be 60 characters or less');
    }
  },

  /** Cannot delete a member with an active subscription */
  canDelete(hasActiveMembership: boolean): void {
    if (hasActiveMembership) {
      throw new MemberValidationError('Cannot delete a member with an active membership. Cancel the subscription first.');
    }
  },
};

// ── Note validation ──

export const noteInvariants = {
  validateContent(content: string): void {
    if (!content.trim()) {
      throw new MemberValidationError('Note content cannot be empty');
    }
    if (content.length > 5000) {
      throw new MemberValidationError('Note content must be 5000 characters or less');
    }
  },
};

// ── Errors ──

export class MemberValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberValidationError';
  }
}

export class MemberNotFoundError extends Error {
  constructor(id: string) {
    super(`Member not found: ${id}`);
    this.name = 'MemberNotFoundError';
  }
}

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`A member with email ${email} already exists`);
    this.name = 'DuplicateEmailError';
  }
}
