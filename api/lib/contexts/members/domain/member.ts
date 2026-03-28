import { z } from 'zod';

// ── State ──

export interface Member {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  stripeCustomerId: string | null;
  createdAt: Date;
  updatedAt: Date;
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
