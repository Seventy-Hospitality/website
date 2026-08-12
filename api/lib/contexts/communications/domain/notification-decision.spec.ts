import {
  CHANNEL_POLICIES,
  decideNotifications,
  planChannels,
  type OutboxEventLike,
} from './notification-decision';
import { DEFAULT_NOTIFICATION_PREFERENCES } from './preferences';

function event(overrides: Partial<OutboxEventLike>): OutboxEventLike {
  return {
    seq: 1,
    streamType: 'reservation',
    streamId: 'rsv_1',
    eventType: 'reservation.created',
    data: {},
    actorId: 'mem_actor',
    ...overrides,
  };
}

describe('decideNotifications (event -> recipient matrix)', () => {
  it('routes a booking invite to the invited member', () => {
    const decisions = decideNotifications(
      event({ eventType: 'reservation.participant_invited', data: { memberId: 'mem_2', invitedById: 'mem_1' } }),
    );
    expect(decisions).toEqual([
      { kind: 'booking_invite', recipient: { kind: 'member', memberId: 'mem_2' } },
    ]);
  });

  it('routes invite accept/decline/withdraw to the reservation organizer', () => {
    for (const [eventType, kind] of [
      ['reservation.invite_accepted', 'booking_invite_accepted'],
      ['reservation.invite_declined', 'booking_invite_declined'],
      ['reservation.participant_withdrawn', 'booking_participant_withdrawn'],
    ] as const) {
      expect(decideNotifications(event({ eventType, data: { memberId: 'mem_2' } }))).toEqual([
        { kind, recipient: { kind: 'reservation_organizer', reservationId: 'rsv_1' } },
      ]);
    }
  });

  it('routes a reschedule to exactly the guests whose confirmation was reset', () => {
    const decisions = decideNotifications(
      event({
        eventType: 'reservation.rescheduled',
        data: { resetParticipants: ['mem_2', 'mem_3'], deltaCents: 0 },
      }),
    );
    expect(decisions).toEqual([
      { kind: 'booking_rescheduled', recipient: { kind: 'members', memberIds: ['mem_2', 'mem_3'] } },
    ]);
  });

  it('a reschedule that reset nobody notifies nobody', () => {
    expect(
      decideNotifications(event({ eventType: 'reservation.rescheduled', data: { resetParticipants: [] } })),
    ).toEqual([]);
  });

  it('routes the booking confirmation to the organizer', () => {
    expect(decideNotifications(event({ eventType: 'reservation.confirmed', data: { reference: 'BK-1' } }))).toEqual([
      { kind: 'booking_confirmed', recipient: { kind: 'reservation_organizer', reservationId: 'rsv_1' } },
    ]);
  });

  it('routes a cancellation to the remaining participants', () => {
    expect(decideNotifications(event({ eventType: 'reservation.cancelled', data: { refundCents: 0 } }))).toEqual([
      { kind: 'booking_cancelled', recipient: { kind: 'reservation_participants', reservationId: 'rsv_1' } },
    ]);
  });

  it('a series-materialized creation notifies the organizer; a member checkout creation does not', () => {
    expect(
      decideNotifications(event({ eventType: 'reservation.created', data: { seriesId: 'ser_1' } })),
    ).toEqual([
      { kind: 'series_booked', recipient: { kind: 'reservation_organizer', reservationId: 'rsv_1' } },
    ]);
    expect(
      decideNotifications(event({ eventType: 'reservation.created', data: { seriesId: null } })),
    ).toEqual([]);
  });

  it('routes a skipped series occurrence to the series organizer', () => {
    expect(
      decideNotifications(
        event({
          streamType: 'reservation_series',
          streamId: 'ser_1',
          eventType: 'reservation_series.occurrence_skipped',
          data: { organizerId: 'mem_1', localDate: '2026-09-01', reason: 'slot_unavailable' },
        }),
      ),
    ).toEqual([
      { kind: 'series_occurrence_skipped', recipient: { kind: 'member', memberId: 'mem_1' } },
    ]);
  });

  it('routes a club invitation to the invitee and its acceptance to the inviter', () => {
    expect(
      decideNotifications(
        event({
          streamType: 'club',
          streamId: 'club_1',
          eventType: 'club.invitation_sent',
          data: { invitationId: 'inv_1', inviteeMemberId: 'mem_2', inviterId: 'mem_1' },
        }),
      ),
    ).toEqual([{ kind: 'club_invite', recipient: { kind: 'member', memberId: 'mem_2' } }]);

    expect(
      decideNotifications(
        event({
          streamType: 'club',
          streamId: 'club_1',
          eventType: 'club.invitation_accepted',
          data: { invitationId: 'inv_1', inviteeMemberId: 'mem_2' },
        }),
      ),
    ).toEqual([
      { kind: 'club_invite_accepted', recipient: { kind: 'club_invitation_inviter', invitationId: 'inv_1' } },
    ]);
  });

  it('routes id-verification decisions to the member (streamId)', () => {
    expect(
      decideNotifications(
        event({ streamType: 'id_verification', streamId: 'mem_9', eventType: 'id_verification.approved' }),
      ),
    ).toEqual([
      { kind: 'id_verification_approved', recipient: { kind: 'member', memberId: 'mem_9' } },
    ]);
    expect(
      decideNotifications(
        event({ streamType: 'id_verification', streamId: 'mem_9', eventType: 'id_verification.rejected', data: { note: 'blurry' } }),
      ),
    ).toEqual([
      { kind: 'id_verification_rejected', recipient: { kind: 'member', memberId: 'mem_9' } },
    ]);
  });

  it('routes a failed membership payment to the member', () => {
    expect(
      decideNotifications(
        event({ streamType: 'billing', streamId: 'mem_5', eventType: 'billing.payment_failed', data: { memberId: 'mem_5' } }),
      ),
    ).toEqual([{ kind: 'payment_failed', recipient: { kind: 'member', memberId: 'mem_5' } }]);
  });

  it('routes disputes, failed refunds and blocked deletions to staff', () => {
    expect(
      decideNotifications(event({ streamType: 'billing', streamId: 'ch_1', eventType: 'billing.dispute_opened' })),
    ).toEqual([{ kind: 'staff_dispute_opened', recipient: { kind: 'staff' } }]);
    expect(
      decideNotifications(event({ eventType: 'reservation.refund_failed', data: { amountCents: 500 } })),
    ).toEqual([{ kind: 'staff_refund_failed', recipient: { kind: 'staff' } }]);
    expect(
      decideNotifications(
        event({ streamType: 'account_deletion', streamId: 'usr_1', eventType: 'account.deletion_blocked' }),
      ),
    ).toEqual([{ kind: 'staff_deletion_blocked', recipient: { kind: 'staff' } }]);
  });

  it('decides nothing for audit-only events', () => {
    for (const eventType of [
      'reservation.payment_captured',
      'reservation.expired',
      'reservation.change_requested',
      'reservation.dispute_opened', // staff alert rides billing.dispute_opened instead
      'reservation.participant_removed', // deliberate silence, recorded decision
      'club.member_left',
      'club.updated',
      'account.deleted',
      'UserSignedUp',
      'EmailVerified',
    ]) {
      expect(decideNotifications(event({ eventType }))).toEqual([]);
    }
  });

  it('fails silent (no decisions) on malformed payloads instead of throwing', () => {
    expect(decideNotifications(event({ eventType: 'reservation.participant_invited', data: null }))).toEqual([]);
    expect(decideNotifications(event({ eventType: 'reservation.participant_invited', data: { memberId: 7 } }))).toEqual([]);
    expect(decideNotifications(event({ eventType: 'club.invitation_sent', data: 'oops' }))).toEqual([]);
    expect(decideNotifications(event({ eventType: 'reservation.rescheduled', data: { resetParticipants: 'mem_2' } }))).toEqual([]);
  });
});

describe('planChannels (preference + device gating)', () => {
  const allOn = DEFAULT_NOTIFICATION_PREFERENCES;

  it('sends push and email when the kind allows both and everything is on', () => {
    expect(planChannels('booking_invite', allOn, true)).toEqual({ push: true, email: true });
  });

  it('pushes only to members with a registered device', () => {
    expect(planChannels('booking_invite', allOn, false)).toEqual({ push: false, email: true });
  });

  it('honors the push and email toggles independently', () => {
    expect(planChannels('booking_invite', { ...allOn, pushNotifications: false }, true)).toEqual({
      push: false,
      email: true,
    });
    expect(planChannels('booking_invite', { ...allOn, emailNotifications: false }, true)).toEqual({
      push: true,
      email: false,
    });
    expect(
      planChannels('booking_invite', { ...allOn, pushNotifications: false, emailNotifications: false }, true),
    ).toEqual({ push: false, email: false });
  });

  it('keeps push-only kinds off email and email-only kinds off push', () => {
    expect(planChannels('booking_invite_accepted', allOn, true)).toEqual({ push: true, email: false });
    expect(planChannels('booking_confirmed', allOn, true)).toEqual({ push: false, email: true });
    expect(planChannels('payment_failed', allOn, true)).toEqual({ push: false, email: true });
  });

  it('gates reminders on the independent bookingReminders toggle', () => {
    expect(planChannels('booking_reminder', allOn, true)).toEqual({ push: true, email: true });
    expect(planChannels('booking_reminder', { ...allOn, bookingReminders: false }, true)).toEqual({
      push: false,
      email: false,
    });
    // The channel toggles still pick channels inside the opted-in category.
    expect(planChannels('booking_reminder', { ...allOn, emailNotifications: false }, true)).toEqual({
      push: true,
      email: false,
    });
    expect(planChannels('booking_reminder', { ...allOn, pushNotifications: false }, true)).toEqual({
      push: false,
      email: true,
    });
  });

  it('staff alerts are email-only and ignore member preferences', () => {
    expect(
      planChannels(
        'staff_dispute_opened',
        { pushNotifications: false, emailNotifications: false, bookingReminders: false },
        false,
      ),
    ).toEqual({ push: false, email: true });
  });

  it('suppresses the actor on social kinds but never on receipts', () => {
    expect(CHANNEL_POLICIES.booking_invite.suppressActor).toBe(true);
    expect(CHANNEL_POLICIES.booking_cancelled.suppressActor).toBe(true);
    expect(CHANNEL_POLICIES.booking_confirmed.suppressActor).toBe(false);
    expect(CHANNEL_POLICIES.booking_reminder.suppressActor).toBe(false);
  });
});
