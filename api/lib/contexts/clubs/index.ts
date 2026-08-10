// Clubs bounded context (Club70 app package D): member-created social clubs.
// Owns Club, ClubMember, ClubInvitation, ClubInviteLink. Owner vs member is
// enforced in the service (single-owner model); invitations require
// acceptance (plan OPEN decision 4). Bookings expands club-chip invites
// through its ClubRosterPort, implemented here by ClubRosterAdapter; cover
// images ride the media context's ManagedMediaAsset pipeline.

export {
  type ClubRole,
  type ClubAction,
  type ClubInvitationStatus,
  type ClubInvitationResponse,
  type ClubMembershipView,
  type InviteLinkVerdict,
  type InviteLinkFailure,
  canPerform,
  applyInvitationResponse,
  evaluateInviteLink,
  ClubValidationError,
  ClubNotFoundError,
  ClubPermissionError,
  ClubMemberNotFoundError,
  OwnerMustTransferFirstError,
  ClubMustHaveOwnerError,
  CannotRemoveClubOwnerError,
  ClubInvitationNotFoundError,
  InvalidInvitationStateError,
  ClubInviteeNotFoundError,
  InviteLinkInvalidError,
} from './domain';
export {
  ClubService,
  type ClubActor,
  type ClubSummary,
  type MyClubItem,
  type ClubDetail,
  type ClubPermissionFlags,
  type RosterEntry,
  type PendingInvitationItem,
  type InviteLinkResult,
  type JoinResult,
  type AccountDeletionClubsSummary,
} from './application';
export {
  ClubRepository,
  ClubRosterAdapter,
  type ClubRecord,
  type ClubMemberRecord,
  type ClubInvitationRecord,
  type ClubInviteLinkRecord,
} from './infrastructure';
