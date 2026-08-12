/**
 * Pure helpers for the clubs flow (package W5): labels, the create-wizard
 * gating, cover-file validation, invite-link URLs, and the activity feed's
 * upcoming test. Kept pure so the wizard and feed logic are unit-testable.
 */
import type { ClubActivityItem, ClubRole } from '../../lib/api';
import { dateKeyToDate } from '../../lib/booking';

// ── Labels ──

export function roleLabel(role: ClubRole): string {
  return role === 'owner' ? 'Owner' : 'Member';
}

/** "6 Members" / "1 Member", per the Figma club cards. */
export function memberCountLabel(count: number): string {
  return count === 1 ? '1 Member' : `${count} Members`;
}

/** "5 players" for the activity rows. */
export function playersCountLabel(count: number): string {
  return count === 1 ? '1 player' : `${count} players`;
}

/** "MON 6/27", the activity row's day label. */
export function activityDayLabel(dateKey: string): string {
  const date = dateKeyToDate(dateKey);
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  return `${weekday} ${date.getMonth() + 1}/${date.getDate()}`;
}

// ── Activity ──

/** Upcoming = still confirmed and not started yet (drives the badge). */
export function isUpcomingActivity(
  item: Pick<ClubActivityItem, 'status' | 'startsAt'>,
  now: Date = new Date(),
): boolean {
  return item.status === 'confirmed' && Date.parse(item.startsAt) > now.getTime();
}

// ── Create wizard ──

export const CLUB_NAME_MAX = 80;
export const CLUB_DESCRIPTION_MAX = 500;

/** Step 1's Continue gate: GROUP NAME is required, description optional. */
export function canContinueClubDetails(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= CLUB_NAME_MAX;
}

// ── Cover photo (mirrors the backend's event-image media spec) ──

export const COVER_MAX_BYTES = 5 * 1024 * 1024;
export const COVER_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';

const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Client-side pre-check; the backend re-validates on upload. */
export function coverFileError(file: Pick<File, 'type' | 'size'>): string | null {
  if (!COVER_TYPES.has(file.type)) {
    return 'Cover photos must be JPG, PNG, WebP, or GIF files.';
  }
  if (file.size > COVER_MAX_BYTES) {
    return 'Cover photos must be 5 MB or smaller.';
  }
  return null;
}

// ── Invite links ──

/** The join URL a share link/QR encodes; /clubs/join resolves the token. */
export function clubJoinUrl(token: string, origin: string): string {
  return `${origin}/clubs/join?${new URLSearchParams({ token })}`;
}
