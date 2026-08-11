import { NotificationDispatchService, type DispatchableEvent } from './notification-dispatch.service';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../domain';
import type { ReservationNotificationView } from './ports';

/**
 * In-memory delivered-notifications ledger with the REAL claim semantics:
 * first claim inserts pending; re-claim of pending succeeds (attempt bump);
 * claim of sent refuses. Mirrors DeliveredNotificationRepository.
 */
function fakeLedger() {
  const rows = new Map<string, { status: 'pending' | 'sent'; attempts: number; lastError: string | null }>();
  const key = (seq: number, recipient: string, channel: string) => `${seq}:${recipient}:${channel}`;
  return {
    rows,
    key,
    claim: vi.fn(async (seq: number, recipient: string, channel: string) => {
      const existing = rows.get(key(seq, recipient, channel));
      if (!existing) {
        rows.set(key(seq, recipient, channel), { status: 'pending', attempts: 1, lastError: null });
        return 'claimed' as const;
      }
      if (existing.status === 'sent') return 'already_sent' as const;
      existing.attempts += 1;
      return 'claimed' as const;
    }),
    markSent: vi.fn(async (seq: number, recipient: string, channel: string) => {
      const row = rows.get(key(seq, recipient, channel));
      if (row) {
        row.status = 'sent';
        row.lastError = null;
      }
    }),
    recordFailure: vi.fn(async (seq: number, recipient: string, channel: string, message: string) => {
      const row = rows.get(key(seq, recipient, channel));
      if (row && row.status === 'pending') row.lastError = message;
    }),
  };
}

function reservationView(overrides: Partial<ReservationNotificationView> = {}): ReservationNotificationView {
  return {
    id: 'rsv_1',
    reference: 'BK-000123',
    typeName: 'Badminton Court',
    resourceName: 'Court 2',
    localDate: '2026-09-01',
    // 18:00-19:00 America/New_York
    startsAt: new Date('2026-09-01T22:00:00.000Z'),
    endsAt: new Date('2026-09-01T23:00:00.000Z'),
    organizerId: 'mem_org',
    seriesId: null,
    participants: [
      { memberId: 'mem_org', role: 'organizer', status: 'confirmed' },
      { memberId: 'mem_guest', role: 'guest', status: 'pending' },
    ],
    ...overrides,
  };
}

function event(overrides: Partial<DispatchableEvent>): DispatchableEvent {
  return {
    id: 'evt_1',
    seq: 11,
    streamType: 'reservation',
    streamId: 'rsv_1',
    eventType: 'reservation.participant_invited',
    data: { memberId: 'mem_guest', invitedById: 'mem_org' },
    actorId: 'mem_org',
    ...overrides,
  };
}

function build(options: { staffAlertEmail?: string | null } = {}) {
  const ledger = fakeLedger();
  const contacts = new Map([
    ['mem_org', { memberId: 'mem_org', email: 'org@example.com', firstName: 'Olivia' }],
    ['mem_guest', { memberId: 'mem_guest', email: 'guest@example.com', firstName: 'Gary' }],
    ['mem_other', { memberId: 'mem_other', email: 'other@example.com', firstName: 'Omar' }],
  ]);
  const prefs = new Map<string, typeof DEFAULT_NOTIFICATION_PREFERENCES>();
  const devices = new Map<string, Array<{ token: string }>>([
    ['mem_guest', [{ token: 'tok-guest' }]],
    ['mem_org', [{ token: 'tok-org-1' }, { token: 'tok-org-2' }]],
  ]);
  const reservations = new Map<string, ReservationNotificationView>([['rsv_1', reservationView()]]);

  const emailSender = { send: vi.fn().mockResolvedValue(undefined) };
  const pushSender = { send: vi.fn().mockResolvedValue(undefined) };
  const preferenceRepo = {
    getForMember: vi.fn(async (memberId: string) => prefs.get(memberId) ?? null),
  };
  const deviceRepo = {
    listForMember: vi.fn(async (memberId: string) => devices.get(memberId) ?? []),
  };
  const recipientDirectory = {
    getContact: vi.fn(async (memberId: string) => contacts.get(memberId) ?? null),
  };
  const reservationDirectory = {
    getNotificationView: vi.fn(async (id: string) => reservations.get(id) ?? null),
  };
  const clubDirectory = {
    getClubName: vi.fn(async () => 'Smashers'),
    getInvitationView: vi.fn(async (invitationId: string) => ({
      invitationId,
      clubId: 'club_1',
      clubName: 'Smashers',
      inviterMemberId: 'mem_org',
      inviteeMemberId: 'mem_guest',
    })),
  };

  const service = new NotificationDispatchService(
    ledger as never,
    preferenceRepo as never,
    deviceRepo as never,
    emailSender,
    pushSender,
    recipientDirectory,
    reservationDirectory,
    clubDirectory,
    {
      timezone: 'America/New_York',
      staffAlertEmail: options.staffAlertEmail !== undefined ? options.staffAlertEmail : 'staff@seventy.club',
    },
  );

  return {
    service,
    ledger,
    contacts,
    prefs,
    devices,
    reservations,
    emailSender,
    pushSender,
    preferenceRepo,
    deviceRepo,
    recipientDirectory,
    reservationDirectory,
    clubDirectory,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NotificationDispatchService: recipients + channels', () => {
  it('sends a booking invite to the invitee over push and email with rendered context', async () => {
    const { service, emailSender, pushSender } = build();

    const result = await service.deliver([event({})]);

    expect(result.failedEventIds).toEqual([]);
    expect(emailSender.send).toHaveBeenCalledTimes(1);
    expect(emailSender.send).toHaveBeenCalledWith({
      type: 'booking-invite',
      to: 'guest@example.com',
      inviterFirstName: 'Olivia',
      typeName: 'Badminton Court',
      date: '2026-09-01',
      timeRange: '18:00 to 19:00',
      reference: 'BK-000123',
    });
    expect(pushSender.send).toHaveBeenCalledTimes(1);
    expect(pushSender.send).toHaveBeenCalledWith([
      expect.objectContaining({ token: 'tok-guest', title: 'Booking invitation' }),
    ]);
  });

  it('respects the email toggle and the push toggle independently', async () => {
    const { service, emailSender, pushSender, prefs } = build();
    prefs.set('mem_guest', { ...DEFAULT_NOTIFICATION_PREFERENCES, emailNotifications: false });

    await service.deliver([event({})]);
    expect(emailSender.send).not.toHaveBeenCalled();
    expect(pushSender.send).toHaveBeenCalledTimes(1);

    emailSender.send.mockClear();
    pushSender.send.mockClear();
    prefs.set('mem_guest', { ...DEFAULT_NOTIFICATION_PREFERENCES, pushNotifications: false });

    await service.deliver([event({ id: 'evt_2', seq: 12 })]);
    expect(pushSender.send).not.toHaveBeenCalled();
    expect(emailSender.send).toHaveBeenCalledTimes(1);
  });

  it('pushes only to members with registered devices', async () => {
    const { service, pushSender, emailSender, devices } = build();
    devices.delete('mem_guest');

    const result = await service.deliver([event({})]);

    expect(result.failedEventIds).toEqual([]);
    expect(pushSender.send).not.toHaveBeenCalled();
    expect(emailSender.send).toHaveBeenCalledTimes(1); // email unaffected
  });

  it('sends push to every registered device of the recipient', async () => {
    const { service, pushSender } = build();

    await service.deliver([
      event({ eventType: 'reservation.invite_accepted', data: { memberId: 'mem_guest' }, actorId: 'mem_guest' }),
    ]);

    // Organizer has two devices; accepted ping is push-only.
    expect(pushSender.send).toHaveBeenCalledWith([
      expect.objectContaining({ token: 'tok-org-1' }),
      expect.objectContaining({ token: 'tok-org-2' }),
    ]);
  });

  it('resolves the organizer for accept pings and never echoes the actor', async () => {
    const { service, pushSender, emailSender } = build();

    await service.deliver([
      event({ eventType: 'reservation.invite_accepted', data: { memberId: 'mem_guest' }, actorId: 'mem_guest' }),
    ]);

    expect(emailSender.send).not.toHaveBeenCalled(); // push-only kind
    expect(pushSender.send).toHaveBeenCalledTimes(1);
    const messages = pushSender.send.mock.calls[0][0];
    expect(messages.every((m: { token: string }) => m.token.startsWith('tok-org'))).toBe(true);
    expect(messages[0].body).toContain('Gary accepted');
  });

  it('notifies remaining confirmed+pending participants on cancellation, minus the actor', async () => {
    const { service, emailSender, reservations } = build();
    reservations.set(
      'rsv_1',
      reservationView({
        participants: [
          { memberId: 'mem_org', role: 'organizer', status: 'confirmed' },
          { memberId: 'mem_guest', role: 'guest', status: 'confirmed' },
          { memberId: 'mem_other', role: 'guest', status: 'declined' },
        ],
      }),
    );

    await service.deliver([
      event({ eventType: 'reservation.cancelled', data: { refundCents: 0 }, actorId: 'mem_org' }),
    ]);

    // Organizer is the actor (suppressed); declined guest opted out.
    const recipients = emailSender.send.mock.calls.map((call) => call[0].to);
    expect(recipients).toEqual(['guest@example.com']);
  });

  it('emails the booking confirmation receipt to the organizer even though they acted', async () => {
    const { service, emailSender } = build();

    await service.deliver([
      event({ eventType: 'reservation.confirmed', data: { reference: 'BK-000123' }, actorId: 'mem_org' }),
    ]);

    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'booking-confirmed', to: 'org@example.com', firstName: 'Olivia' }),
    );
  });

  it('skips deleted/unknown recipients without failing the event', async () => {
    const { service, emailSender, contacts } = build();
    contacts.delete('mem_guest');

    const result = await service.deliver([event({})]);

    expect(result.failedEventIds).toEqual([]);
    expect(emailSender.send).not.toHaveBeenCalled();
  });

  it('a reservation that no longer exists means nothing to say (event still dispatches)', async () => {
    const { service, emailSender, reservations } = build();
    reservations.delete('rsv_1');

    const result = await service.deliver([event({})]);

    expect(result.failedEventIds).toEqual([]);
    expect(emailSender.send).not.toHaveBeenCalled();
  });

  it('audit-only events send nothing', async () => {
    const { service, emailSender, pushSender } = build();

    const result = await service.deliver([
      event({ eventType: 'reservation.payment_captured', data: { amountCents: 2000 } }),
      event({ id: 'evt_9', seq: 19, eventType: 'club.member_left', streamType: 'club', streamId: 'club_1' }),
    ]);

    expect(result.failedEventIds).toEqual([]);
    expect(emailSender.send).not.toHaveBeenCalled();
    expect(pushSender.send).not.toHaveBeenCalled();
  });
});

describe('NotificationDispatchService: idempotency ledger', () => {
  it('redelivering an already-delivered event sends nothing the second time', async () => {
    const { service, emailSender, pushSender } = build();

    await service.deliver([event({})]);
    expect(emailSender.send).toHaveBeenCalledTimes(1);
    expect(pushSender.send).toHaveBeenCalledTimes(1);

    await service.deliver([event({})]); // outbox redelivery of the same row

    expect(emailSender.send).toHaveBeenCalledTimes(1);
    expect(pushSender.send).toHaveBeenCalledTimes(1);
  });

  it('a failed email send reports the event failed, keeps the claim pending, and the retry re-sends', async () => {
    const { service, emailSender, ledger } = build();
    emailSender.send.mockRejectedValueOnce(new Error('resend 503'));

    const first = await service.deliver([event({})]);
    expect(first.failedEventIds).toEqual(['evt_1']);
    expect(ledger.rows.get(ledger.key(11, 'mem_guest', 'email'))).toMatchObject({
      status: 'pending',
      lastError: 'resend 503',
    });

    const second = await service.deliver([event({})]);
    expect(second.failedEventIds).toEqual([]);
    expect(emailSender.send).toHaveBeenCalledTimes(2);
    expect(ledger.rows.get(ledger.key(11, 'mem_guest', 'email'))).toMatchObject({ status: 'sent' });
  });

  it('a partial failure retries ONLY the failed channel', async () => {
    const { service, emailSender, pushSender } = build();
    // Email goes out, push fails on the first pass.
    pushSender.send.mockRejectedValueOnce(new Error('expo down'));

    const first = await service.deliver([event({})]);
    expect(first.failedEventIds).toEqual(['evt_1']);
    expect(emailSender.send).toHaveBeenCalledTimes(1);

    const second = await service.deliver([event({})]);
    expect(second.failedEventIds).toEqual([]);
    expect(emailSender.send).toHaveBeenCalledTimes(1); // not re-sent
    expect(pushSender.send).toHaveBeenCalledTimes(2); // retried
  });

  it('one poisoned event does not block the rest of the batch', async () => {
    const { service, emailSender } = build();
    emailSender.send.mockRejectedValueOnce(new Error('boom'));

    const result = await service.deliver([
      event({}),
      event({
        id: 'evt_2',
        seq: 12,
        eventType: 'id_verification.approved',
        streamType: 'id_verification',
        streamId: 'mem_other',
        data: {},
        actorId: 'adm_1',
      }),
    ]);

    expect(result.failedEventIds).toEqual(['evt_1']);
    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'id-approved', to: 'other@example.com' }),
    );
  });

  it('a concurrent claim marked sent by another dispatcher is skipped', async () => {
    const { service, emailSender, pushSender, ledger } = build();
    // Simulate another dispatcher having delivered the email already.
    ledger.rows.set(ledger.key(11, 'mem_guest', 'email'), { status: 'sent', attempts: 1, lastError: null });

    await service.deliver([event({})]);

    expect(emailSender.send).not.toHaveBeenCalled();
    expect(pushSender.send).toHaveBeenCalledTimes(1); // push still owed
  });
});

describe('NotificationDispatchService: club, id-verification, billing, staff', () => {
  it('delivers a club invitation with club name and inviter first name', async () => {
    const { service, emailSender } = build();

    await service.deliver([
      event({
        eventType: 'club.invitation_sent',
        streamType: 'club',
        streamId: 'club_1',
        data: { invitationId: 'inv_1', inviteeMemberId: 'mem_guest', inviterId: 'mem_org' },
      }),
    ]);

    expect(emailSender.send).toHaveBeenCalledWith({
      type: 'club-invite',
      to: 'guest@example.com',
      inviterFirstName: 'Olivia',
      clubName: 'Smashers',
    });
  });

  it('pings the inviter when their club invitation is accepted', async () => {
    const { service, pushSender, clubDirectory } = build();

    await service.deliver([
      event({
        eventType: 'club.invitation_accepted',
        streamType: 'club',
        streamId: 'club_1',
        data: { invitationId: 'inv_1', inviteeMemberId: 'mem_guest' },
        actorId: 'mem_guest',
      }),
    ]);

    expect(clubDirectory.getInvitationView).toHaveBeenCalledWith('inv_1');
    expect(pushSender.send).toHaveBeenCalledWith([
      expect.objectContaining({ token: 'tok-org-1', body: 'Gary joined Smashers' }),
      expect.objectContaining({ token: 'tok-org-2' }),
    ]);
  });

  it('delivers id-verification decisions to the member with the rejection note', async () => {
    const { service, emailSender } = build();

    await service.deliver([
      event({
        eventType: 'id_verification.rejected',
        streamType: 'id_verification',
        streamId: 'mem_guest',
        data: { note: 'photo too blurry' },
        actorId: 'adm_1',
      }),
    ]);

    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'id-rejected', to: 'guest@example.com', note: 'photo too blurry' }),
    );
  });

  it('emails the dunning notice for billing.payment_failed', async () => {
    const { service, emailSender } = build();

    await service.deliver([
      event({
        eventType: 'billing.payment_failed',
        streamType: 'billing',
        streamId: 'mem_guest',
        data: { memberId: 'mem_guest', stripeSubscriptionId: 'sub_1' },
        actorId: null,
      }),
    ]);

    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment-failed', to: 'guest@example.com' }),
    );
  });

  it('sends staff alerts to the configured address, idempotently', async () => {
    const { service, emailSender } = build();
    const dispute = event({
      eventType: 'billing.dispute_opened',
      streamType: 'billing',
      streamId: 'ch_1',
      data: { chargeId: 'ch_1', reservationIds: ['rsv_1'] },
      actorId: null,
    });

    await service.deliver([dispute]);
    await service.deliver([dispute]);

    expect(emailSender.send).toHaveBeenCalledTimes(1);
    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'staff-alert',
        to: 'staff@seventy.club',
        subject: 'Payment dispute opened',
        detail: expect.stringContaining('rsv_1'),
      }),
    );
  });

  it('drops staff alerts (event still dispatches) when no staff address is configured', async () => {
    const { service, emailSender } = build({ staffAlertEmail: null });

    const result = await service.deliver([
      event({
        eventType: 'reservation.refund_failed',
        data: { amountCents: 500, stripePaymentIntentId: 'pi_1' },
      }),
    ]);

    expect(result.failedEventIds).toEqual([]);
    expect(emailSender.send).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});
