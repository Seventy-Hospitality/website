import type { ClubActivityItem } from '../../../lib/api';
import {
  activityDayLabel,
  canContinueClubDetails,
  clubJoinUrl,
  coverImageError,
  isLinkableActivity,
  isUpcomingActivity,
  memberCountLabel,
  playersCountLabel,
  roleLabel,
  CLUB_NAME_MAX,
} from '../clubs-lib';

describe('clubs-lib labels', () => {
  it('labels the role', () => {
    expect(roleLabel('owner')).toBe('Owner');
    expect(roleLabel('member')).toBe('Member');
  });

  it('pluralizes member and player counts', () => {
    expect(memberCountLabel(1)).toBe('1 Member');
    expect(memberCountLabel(6)).toBe('6 Members');
    expect(playersCountLabel(1)).toBe('1 player');
    expect(playersCountLabel(5)).toBe('5 players');
  });

  it('formats the activity day from a local date, timezone-stable', () => {
    // 2026-06-27 is a Saturday.
    expect(activityDayLabel('2026-06-27')).toBe('SAT 6/27');
    // 2026-06-29 is a Monday.
    expect(activityDayLabel('2026-06-29')).toBe('MON 6/29');
  });
});

describe('canContinueClubDetails (create/edit gate)', () => {
  it('requires a non-empty name within the length limit', () => {
    expect(canContinueClubDetails('')).toBe(false);
    expect(canContinueClubDetails('   ')).toBe(false);
    expect(canContinueClubDetails('Baddies')).toBe(true);
    expect(canContinueClubDetails('a'.repeat(CLUB_NAME_MAX))).toBe(true);
    expect(canContinueClubDetails('a'.repeat(CLUB_NAME_MAX + 1))).toBe(false);
  });
});

describe('coverImageError', () => {
  it('accepts a valid image', () => {
    expect(coverImageError({ type: 'image/png', size: 1024 })).toBeNull();
    expect(coverImageError({ type: 'image/jpeg', size: null })).toBeNull();
  });

  it('rejects an unsupported type', () => {
    expect(coverImageError({ type: 'image/heic', size: 1024 })).toBe(
      'Cover photos must be JPG, PNG, WebP, or GIF files.',
    );
  });

  it('rejects an oversized image', () => {
    expect(coverImageError({ type: 'image/png', size: 6 * 1024 * 1024 })).toBe(
      'Cover photos must be 5 MB or smaller.',
    );
  });
});

describe('clubJoinUrl', () => {
  it('builds the browser join URL with an encoded token', () => {
    expect(clubJoinUrl('abc123', 'https://app.example.com')).toBe(
      'https://app.example.com/clubs/join?token=abc123',
    );
  });

  it('trims a trailing slash on the origin and encodes special chars', () => {
    expect(clubJoinUrl('a b/c', 'https://app.example.com/')).toBe(
      'https://app.example.com/clubs/join?token=a%20b%2Fc',
    );
  });
});

function activity(overrides: Partial<ClubActivityItem>): ClubActivityItem {
  return {
    id: 'r1',
    reference: 'BK-1',
    typeCode: 'badminton_court',
    typeName: 'Badminton Court',
    resource: { id: 'c1', name: 'Court 1' },
    date: '2026-06-27',
    startTime: '09:00',
    endTime: '11:30',
    startsAt: '2026-06-27T16:00:00.000Z',
    endsAt: '2026-06-27T18:30:00.000Z',
    durationMinutes: 150,
    status: 'confirmed',
    clubId: 'club1',
    seriesId: null,
    organizer: null,
    confirmedCount: 5,
    myParticipation: null,
    ...overrides,
  };
}

describe('activity badges + linkability', () => {
  const now = Date.parse('2026-06-27T12:00:00.000Z');

  it('is Upcoming when confirmed and in the future', () => {
    expect(isUpcomingActivity(activity({ status: 'confirmed' }), now)).toBe(true);
  });

  it('is not Upcoming when confirmed but already started', () => {
    expect(
      isUpcomingActivity(activity({ status: 'confirmed', startsAt: '2026-06-27T10:00:00.000Z' }), now),
    ).toBe(false);
  });

  it('is not Upcoming when cancelled', () => {
    expect(isUpcomingActivity(activity({ status: 'cancelled' }), now)).toBe(false);
  });

  it('only links a row the viewer participates in', () => {
    expect(isLinkableActivity(activity({ myParticipation: null }))).toBe(false);
    expect(
      isLinkableActivity(
        activity({ myParticipation: { role: 'guest', status: 'confirmed', invitedByName: null } }),
      ),
    ).toBe(true);
  });
});
