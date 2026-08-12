/**
 * Public surface of the home feature (M2). The Home tab route renders
 * HomeScreen; the query definition + club-invitation respond hook are exported
 * for cross-feature cache work.
 */
export { HomeScreen } from './HomeScreen';
export { homeQuery, deviceTimeZone, useRespondToClubInvitation, isClubInviteConflict } from './home-data';
export { homeLayout, greetingEyebrow, playerCountLabel, type HomeLayout } from './home-sections';
