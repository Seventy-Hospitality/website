import { describe, expect, it } from 'vitest';
import {
  activityDayLabel,
  canContinueClubDetails,
  clubJoinUrl,
  coverFileError,
  isUpcomingActivity,
  memberCountLabel,
  playersCountLabel,
  roleLabel,
} from './clubs-lib';

describe('labels', () => {
  it('renders roles and counts per the Figma cards', () => {
    expect(roleLabel('owner')).toBe('Owner');
    expect(roleLabel('member')).toBe('Member');
    expect(memberCountLabel(1)).toBe('1 Member');
    expect(memberCountLabel(6)).toBe('6 Members');
    expect(playersCountLabel(1)).toBe('1 player');
    expect(playersCountLabel(5)).toBe('5 players');
  });

  it('formats the activity day label as WEEKDAY M/D', () => {
    // 2026-06-27 is a Saturday.
    expect(activityDayLabel('2026-06-27')).toBe('SAT 6/27');
    expect(activityDayLabel('2026-12-07')).toBe('MON 12/7');
  });
});

describe('isUpcomingActivity', () => {
  const now = new Date('2026-06-20T12:00:00Z');

  it('is upcoming only while confirmed and in the future', () => {
    expect(
      isUpcomingActivity({ status: 'confirmed', startsAt: '2026-06-27T13:00:00Z' }, now),
    ).toBe(true);
    expect(
      isUpcomingActivity({ status: 'confirmed', startsAt: '2026-06-13T13:00:00Z' }, now),
    ).toBe(false);
    expect(
      isUpcomingActivity({ status: 'cancelled', startsAt: '2026-06-27T13:00:00Z' }, now),
    ).toBe(false);
  });
});

describe('create wizard gating', () => {
  it('requires a non-blank group name within the limit', () => {
    expect(canContinueClubDetails('')).toBe(false);
    expect(canContinueClubDetails('   ')).toBe(false);
    expect(canContinueClubDetails('baddies')).toBe(true);
    expect(canContinueClubDetails(' baddies ')).toBe(true);
    expect(canContinueClubDetails('x'.repeat(81))).toBe(false);
    expect(canContinueClubDetails('x'.repeat(80))).toBe(true);
  });
});

describe('coverFileError', () => {
  it('accepts the backend image types up to 5 MB', () => {
    expect(coverFileError({ type: 'image/jpeg', size: 1024 })).toBeNull();
    expect(coverFileError({ type: 'image/png', size: 5 * 1024 * 1024 })).toBeNull();
    expect(coverFileError({ type: 'image/webp', size: 1 })).toBeNull();
    expect(coverFileError({ type: 'image/gif', size: 1 })).toBeNull();
  });

  it('rejects other types and oversized files', () => {
    expect(coverFileError({ type: 'application/pdf', size: 1 })).toMatch(/JPG, PNG, WebP/);
    expect(coverFileError({ type: 'image/svg+xml', size: 1 })).toMatch(/JPG, PNG, WebP/);
    expect(coverFileError({ type: 'image/jpeg', size: 5 * 1024 * 1024 + 1 })).toMatch(/5 MB/);
  });
});

describe('clubJoinUrl', () => {
  it('builds the /clubs/join landing URL with the token escaped', () => {
    expect(clubJoinUrl('abc123', 'https://club70.com')).toBe(
      'https://club70.com/clubs/join?token=abc123',
    );
    expect(clubJoinUrl('a+b/c', 'https://club70.com')).toBe(
      'https://club70.com/clubs/join?token=a%2Bb%2Fc',
    );
  });
});
