import { applyParticipantResponse, canManageInvites } from './reservation';
import { InvalidParticipantTransitionError, OrganizerCannotRespondError } from './errors';

describe('applyParticipantResponse', () => {
  it('accepts a pending invite', () => {
    expect(applyParticipantResponse({ role: 'guest', status: 'pending' }, 'accept')).toBe('confirmed');
  });

  it('declines a pending invite (row is kept)', () => {
    expect(applyParticipantResponse({ role: 'guest', status: 'pending' }, 'decline')).toBe('declined');
  });

  it('withdraws after accept', () => {
    expect(applyParticipantResponse({ role: 'guest', status: 'confirmed' }, 'decline')).toBe('withdrawn');
  });

  it('is idempotent on repeats', () => {
    expect(applyParticipantResponse({ role: 'guest', status: 'confirmed' }, 'accept')).toBe('confirmed');
    expect(applyParticipantResponse({ role: 'guest', status: 'declined' }, 'decline')).toBe('declined');
    expect(applyParticipantResponse({ role: 'guest', status: 'withdrawn' }, 'decline')).toBe('withdrawn');
  });

  it('cannot accept after declining or withdrawing without a re-invite', () => {
    expect(() => applyParticipantResponse({ role: 'guest', status: 'declined' }, 'accept')).toThrow(
      InvalidParticipantTransitionError,
    );
    expect(() => applyParticipantResponse({ role: 'guest', status: 'withdrawn' }, 'accept')).toThrow(
      InvalidParticipantTransitionError,
    );
  });

  it('rejects the organizer responding to their own reservation', () => {
    expect(() => applyParticipantResponse({ role: 'organizer', status: 'confirmed' }, 'decline')).toThrow(
      OrganizerCannotRespondError,
    );
  });
});

describe('canManageInvites (decision 6: organizer + confirmed participants)', () => {
  it('allows the organizer', () => {
    expect(canManageInvites({ role: 'organizer', status: 'confirmed' })).toBe(true);
  });

  it('allows confirmed guests', () => {
    expect(canManageInvites({ role: 'guest', status: 'confirmed' })).toBe(true);
  });

  it('denies pending, declined and withdrawn guests', () => {
    expect(canManageInvites({ role: 'guest', status: 'pending' })).toBe(false);
    expect(canManageInvites({ role: 'guest', status: 'declined' })).toBe(false);
    expect(canManageInvites({ role: 'guest', status: 'withdrawn' })).toBe(false);
  });

  it('denies non-participants', () => {
    expect(canManageInvites(null)).toBe(false);
  });
});
