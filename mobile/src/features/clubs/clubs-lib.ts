/**
 * Pure presentation + validation helpers for the mobile clubs surface (M5).
 * Ported 1:1 from member-web's clubs-lib.ts so the two clients label and gate
 * clubs identically. Kept framework-free so the wizard gating, the invite-URL
 * builder, and the activity/role labels are unit-tested in isolation.
 */
import type { ClubActivityItem, ClubRole } from '../../lib/api';

// Re-export the member name/number formatters (shared with M3's invite step)
// so club components import them from one place.
export { memberDisplayName, memberNumberLabel } from '../reserve/invites';

/** Club name/description limits (mirror the backend Zod schema). */
export const CLUB_NAME_MAX = 80;
export const CLUB_DESCRIPTION_MAX = 500;

/** Cover-image constraints (mirror the backend multipart validation). */
export const COVER_MAX_BYTES = 5 * 1024 * 1024;
export const COVER_ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/** "Owner" / "Member" for a role badge or meta line. */
export function roleLabel(role: ClubRole): string {
  return role === 'owner' ? 'Owner' : 'Member';
}

/** "1 Member" / "6 Members" for the club meta line. */
export function memberCountLabel(count: number): string {
  return count === 1 ? '1 Member' : `${count} Members`;
}

/** "1 player" / "5 players" for an activity row. */
export function playersCountLabel(count: number): string {
  return count === 1 ? '1 player' : `${count} players`;
}

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

/**
 * "MON 6/27" from an activity's local `date` ("YYYY-MM-DD"). Parsed in UTC so
 * the weekday never drifts by the device timezone (the date is already the
 * venue's local day).
 */
export function activityDayLabel(date: string): string {
  const [year, month, day] = date.split('-').map((part) => Number(part));
  if (!year || !month || !day) return '';
  const at = new Date(Date.UTC(year, month - 1, day));
  return `${WEEKDAYS[at.getUTCDay()]} ${month}/${day}`;
}

/**
 * A confirmed reservation whose start is still in the future gets the green
 * "Upcoming" badge; a cancelled one gets the "Cancelled" badge; everything
 * else is unbadged. `now` is injectable for deterministic tests.
 */
export function isUpcomingActivity(item: ClubActivityItem, now: number = Date.now()): boolean {
  return item.status === 'confirmed' && Date.parse(item.startsAt) > now;
}

/** Only a participant's row deep-links to the (participation-scoped) detail. */
export function isLinkableActivity(item: ClubActivityItem): boolean {
  return item.myParticipation !== null;
}

/**
 * The create/edit "Continue" gate: a non-empty club name within the length
 * limit. Description and cover are optional and never gate.
 */
export function canContinueClubDetails(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= CLUB_NAME_MAX;
}

/**
 * Validate a picked cover image against the backend's accepted types and size
 * before uploading, so the member gets an inline message instead of a 413/422.
 * Returns the error string, or null when the image is acceptable.
 */
export function coverImageError(image: { type: string; size?: number | null }): string | null {
  if (!(COVER_ACCEPTED_TYPES as readonly string[]).includes(image.type)) {
    return 'Cover photos must be JPG, PNG, WebP, or GIF files.';
  }
  if (image.size != null && image.size > COVER_MAX_BYTES) {
    return 'Cover photos must be 5 MB or smaller.';
  }
  return null;
}

/**
 * The shareable join URL for an invite-link token, resolving in a browser at
 * the member-web join page. Matches member-web's clubJoinUrl exactly so a link
 * minted on either client is interchangeable.
 */
export function clubJoinUrl(token: string, origin: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/clubs/join?token=${encodeURIComponent(token)}`;
}
