import {
  CannotRemoveClubOwnerError,
  ClubMustHaveOwnerError,
  ClubPermissionError,
  ClubValidationError,
  InvalidInvitationStateError,
  OwnerMustTransferFirstError,
} from './errors';

// ── Types ──

/**
 * Single-owner model: every club has EXACTLY one owner at all times. The
 * pure rules below preserve that invariant; the service holds a per-club
 * advisory lock while applying them.
 */
export type ClubRole = 'owner' | 'member';

export type ClubInvitationStatus = 'pending' | 'accepted' | 'declined' | 'revoked';
export type ClubInvitationResponse = 'accept' | 'decline';

export interface ClubMembershipView {
  memberId: string;
  role: ClubRole;
  joinedAt: Date;
}

// ── Invariants ──

export const MAX_CLUB_NAME_LENGTH = 80;
export const MAX_CLUB_DESCRIPTION_LENGTH = 500;

export const clubInvariants = {
  validateName(name: string): void {
    if (!name.trim()) throw new ClubValidationError('Club name is required');
    if (name.trim().length > MAX_CLUB_NAME_LENGTH) {
      throw new ClubValidationError(`Club name must be ${MAX_CLUB_NAME_LENGTH} characters or less`);
    }
  },

  validateDescription(description: string | null | undefined): void {
    if (description != null && description.length > MAX_CLUB_DESCRIPTION_LENGTH) {
      throw new ClubValidationError(
        `Club description must be ${MAX_CLUB_DESCRIPTION_LENGTH} characters or less`,
      );
    }
  },
};

// ── Who can do what ──

export type ClubAction =
  | 'view' // detail, roster, activity
  | 'invite' // send invitations (the invite modal is open to members)
  | 'createInviteLink' // mint a share link / QR
  | 'leave'
  | 'edit' // name / description / cover
  | 'delete'
  | 'removeMember'
  | 'changeRole' // includes ownership transfer
  | 'rotateInviteLink'; // mint AND revoke the previous links

const MEMBER_ACTIONS: ReadonlySet<ClubAction> = new Set([
  'view',
  'invite',
  'createInviteLink',
  'leave',
]);

/**
 * The single permission matrix. `null` role = not a club member: nothing is
 * allowed (and the service answers 404-shaped, never 403, so outsiders
 * cannot distinguish "exists" from "not yours").
 */
export function canPerform(role: ClubRole | null | undefined, action: ClubAction): boolean {
  if (!role) return false;
  if (role === 'owner') return true;
  return MEMBER_ACTIONS.has(action);
}

/** Leaving: any member may leave; the owner must transfer (or delete) first. */
export function assertCanLeave(role: ClubRole): void {
  if (role === 'owner') throw new OwnerMustTransferFirstError();
}

/** Removal: owner-only, and the owner themselves can never be the target. */
export function assertRemovable(
  actor: ClubMembershipView,
  target: ClubMembershipView,
): void {
  if (actor.role !== 'owner') throw new ClubPermissionError('Only the club owner can remove members');
  if (target.memberId === actor.memberId || target.role === 'owner') {
    throw new CannotRemoveClubOwnerError();
  }
}

export interface RoleChange {
  memberId: string;
  role: ClubRole;
}

/**
 * Role change / ownership transfer, as a pure diff:
 *
 * - promote someone else to owner -> TRANSFER: they become owner, the acting
 *   owner is demoted to member in the same transaction (single-owner model).
 * - promote yourself (already owner) -> no-op.
 * - demote yourself to member -> rejected: the club would have no owner.
 *   Transfer by promoting someone else instead.
 * - demote a plain member to member -> no-op.
 *
 * Only the owner may change roles.
 */
export function applyRoleChange(
  actor: ClubMembershipView,
  target: ClubMembershipView,
  newRole: ClubRole,
): RoleChange[] {
  if (actor.role !== 'owner') throw new ClubPermissionError('Only the club owner can change roles');

  if (newRole === 'owner') {
    if (target.memberId === actor.memberId) return [];
    return [
      { memberId: target.memberId, role: 'owner' },
      { memberId: actor.memberId, role: 'member' },
    ];
  }

  if (target.memberId === actor.memberId) throw new ClubMustHaveOwnerError();
  return []; // single-owner model: any other target is already a plain member
}

/**
 * Successor when the owner's account is deleted (package E seam): the
 * longest-tenured remaining member; ties break on member id so concurrent
 * runs pick deterministically. Null = the owner was the last member.
 */
export function pickSuccessor(
  remaining: ClubMembershipView[],
): ClubMembershipView | null {
  if (remaining.length === 0) return null;
  return [...remaining].sort(
    (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.memberId.localeCompare(b.memberId),
  )[0];
}

// ── Invitation state machine ──

/**
 * Invitations REQUIRE acceptance (plan OPEN decision 4): a row is pending
 * until the invitee responds, matching the invite-link and
 * reservation-invite semantics. Direct-add does not exist.
 *
 * - pending  + accept  -> accepted (membership row is created alongside)
 * - pending  + decline -> declined (history row is kept; re-invite = new row)
 * - accepted + accept, declined + decline -> idempotent
 * - accepted + decline -> invalid (leave the club instead)
 * - declined + accept, revoked + anything -> invalid; ask for a re-invite
 */
export function applyInvitationResponse(
  current: ClubInvitationStatus,
  response: ClubInvitationResponse,
): ClubInvitationStatus {
  if (response === 'accept') {
    if (current === 'pending' || current === 'accepted') return 'accepted';
    throw new InvalidInvitationStateError(current, response);
  }

  if (current === 'pending' || current === 'declined') return 'declined';
  throw new InvalidInvitationStateError(current, response);
}
