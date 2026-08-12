/**
 * Public surface of the clubs feature (M5). The Clubs tab renders ClubsScreen;
 * the club route files under app/clubs/** render the create wizard, detail,
 * members, and join screens. Data definitions + pure helpers are exported for
 * cross-feature cache work and tests.
 */
export { ClubsScreen } from './ClubsScreen';
export { CreateClubScreen } from './CreateClubScreen';
export { ClubDetailScreen } from './ClubDetailScreen';
export { ClubMembersScreen } from './ClubMembersScreen';
export { JoinClubScreen } from './JoinClubScreen';
export { InviteToClubSheet } from './InviteToClubSheet';
export { EditClubSheet } from './EditClubSheet';
export { ClubMemberPicker } from './ClubMemberPicker';

export {
  clubQuery,
  clubMembersQuery,
  clubActivityQuery,
  clubInvitationsQuery,
  clubInvitePreviewQuery,
  clubDirectoryQuery,
  myClubsQuery,
  useClubInviteLink,
} from './clubs-data';

export * from './clubs-lib';
