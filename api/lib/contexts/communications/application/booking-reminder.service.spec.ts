import { BookingReminderService } from './booking-reminder.service';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../domain';
import type { ReservationNotificationView } from './ports';

const NOW = new Date('2026-09-01T12:00:00.000Z');

function reservation(overrides: Partial<ReservationNotificationView> = {}): ReservationNotificationView {
  return {
    id: 'rsv_1',
    reference: 'BK-000123',
    typeName: 'Badminton Court',
    resourceName: 'Court 2',
    localDate: '2026-09-01',
    // 18:00-19:00 America/New_York = 22:00-23:00Z (inside the 24h window)
    startsAt: new Date('2026-09-01T22:00:00.000Z'),
    endsAt: new Date('2026-09-01T23:00:00.000Z'),
    organizerId: 'mem_org',
    seriesId: null,
    status: 'confirmed',
    participants: [
      { memberId: 'mem_org', role: 'organizer', status: 'confirmed' },
      { memberId: 'mem_guest', role: 'guest', status: 'confirmed' },
      { memberId: 'mem_pending', role: 'guest', status: 'pending' },
    ],
    ...overrides,
  };
}

function fakeMarkers() {
  const rows = new Map<string, { status: 'pending' | 'sent'; lastError: string | null }>();
  const key = (reservationId: string, memberId: string) => `${reservationId}:${memberId}`;
  return {
    rows,
    key,
    claim: vi.fn(async (reservationId: string, memberId: string) => {
      const existing = rows.get(key(reservationId, memberId));
      if (!existing) {
        rows.set(key(reservationId, memberId), { status: 'pending', lastError: null });
        return 'claimed' as const;
      }
      return existing.status === 'sent' ? ('already_sent' as const) : ('claimed' as const);
    }),
    markSent: vi.fn(async (reservationId: string, memberId: string) => {
      const row = rows.get(key(reservationId, memberId));
      if (row) row.status = 'sent';
    }),
    recordFailure: vi.fn(async (reservationId: string, memberId: string, message: string) => {
      const row = rows.get(key(reservationId, memberId));
      if (row && row.status === 'pending') row.lastError = message;
    }),
  };
}

function build(due: ReservationNotificationView[] = [reservation()]) {
  const markers = fakeMarkers();
  const prefs = new Map<string, typeof DEFAULT_NOTIFICATION_PREFERENCES>();
  const devices = new Map<string, Array<{ token: string }>>([
    ['mem_org', [{ token: 'tok-org' }]],
    ['mem_guest', [{ token: 'tok-guest' }]],
  ]);
  const contacts = new Map([
    ['mem_org', { memberId: 'mem_org', email: 'org@example.com', firstName: 'Olivia' }],
    ['mem_guest', { memberId: 'mem_guest', email: 'guest@example.com', firstName: 'Gary' }],
    ['mem_pending', { memberId: 'mem_pending', email: 'pending@example.com', firstName: 'Pat' }],
  ]);

  const source = { listConfirmedStartingBetween: vi.fn().mockResolvedValue(due) };
  const emailSender = { send: vi.fn().mockResolvedValue(undefined) };
  const pushSender = { send: vi.fn().mockResolvedValue(undefined) };

  const service = new BookingReminderService(
    source,
    markers as never,
    { getForMember: vi.fn(async (memberId: string) => prefs.get(memberId) ?? null) } as never,
    { listForMember: vi.fn(async (memberId: string) => devices.get(memberId) ?? []) } as never,
    emailSender,
    pushSender,
    { getContact: vi.fn(async (memberId: string) => contacts.get(memberId) ?? null) },
    { timezone: 'America/New_York' },
  );

  return { service, source, markers, prefs, devices, contacts, emailSender, pushSender };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BookingReminderService', () => {
  it('queries the 24h window from now and reminds confirmed participants only', async () => {
    const { service, source, emailSender } = build();

    const result = await service.sendDueReminders(NOW);

    expect(source.listConfirmedStartingBetween).toHaveBeenCalledWith(
      NOW,
      new Date('2026-09-02T12:00:00.000Z'),
    );
    const recipients = emailSender.send.mock.calls.map((call) => call[0].to).sort();
    expect(recipients).toEqual(['guest@example.com', 'org@example.com']); // never mem_pending
    expect(result).toMatchObject({ reservations: 1, remindersSent: 2, failed: 0 });
  });

  it('renders venue-local date and time range in the reminder', async () => {
    const { service, emailSender, pushSender } = build();

    await service.sendDueReminders(NOW);

    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'booking-reminder',
        date: '2026-09-01',
        timeRange: '18:00 to 19:00',
        resourceName: 'Court 2',
        reference: 'BK-000123',
      }),
    );
    expect(pushSender.send).toHaveBeenCalledWith([
      expect.objectContaining({ token: 'tok-org', body: expect.stringContaining('18:00 to 19:00') }),
    ]);
  });

  it('is idempotent: a second cron pass sends nothing new', async () => {
    const { service, emailSender, pushSender } = build();

    await service.sendDueReminders(NOW);
    const emails = emailSender.send.mock.calls.length;
    const pushes = pushSender.send.mock.calls.length;

    const second = await service.sendDueReminders(NOW);

    expect(emailSender.send.mock.calls.length).toBe(emails);
    expect(pushSender.send.mock.calls.length).toBe(pushes);
    expect(second.remindersSent).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it('honors the independent bookingReminders toggle without burning the marker', async () => {
    const { service, prefs, markers, emailSender } = build();
    prefs.set('mem_guest', { ...DEFAULT_NOTIFICATION_PREFERENCES, bookingReminders: false });

    await service.sendDueReminders(NOW);

    expect(emailSender.send.mock.calls.map((call) => call[0].to)).toEqual(['org@example.com']);
    // No marker for the opted-out member: re-enabling inside the window
    // still gets them their one reminder.
    expect(markers.rows.has(markers.key('rsv_1', 'mem_guest'))).toBe(false);
  });

  it('pushes only to registered devices; email-only members still get email', async () => {
    const { service, devices, pushSender, emailSender } = build();
    devices.delete('mem_guest');

    await service.sendDueReminders(NOW);

    const pushTokens = pushSender.send.mock.calls.flatMap((call) => call[0].map((m: { token: string }) => m.token));
    expect(pushTokens).toEqual(['tok-org']);
    expect(emailSender.send.mock.calls.map((call) => call[0].to).sort()).toEqual([
      'guest@example.com',
      'org@example.com',
    ]);
  });

  it('a member whose every channel failed keeps a pending marker and is retried', async () => {
    const { service, emailSender, pushSender, markers } = build([
      reservation({ participants: [{ memberId: 'mem_guest', role: 'guest', status: 'confirmed' }] }),
    ]);
    emailSender.send.mockRejectedValueOnce(new Error('resend down'));
    pushSender.send.mockRejectedValueOnce(new Error('expo down'));

    const first = await service.sendDueReminders(NOW);
    expect(first).toMatchObject({ remindersSent: 0, failed: 1 });
    expect(markers.rows.get(markers.key('rsv_1', 'mem_guest'))).toMatchObject({ status: 'pending' });

    const second = await service.sendDueReminders(NOW);
    expect(second).toMatchObject({ remindersSent: 1, failed: 0 });
    expect(markers.rows.get(markers.key('rsv_1', 'mem_guest'))).toMatchObject({ status: 'sent' });
  });

  it('a partial channel failure still marks sent (no double-send on the next pass)', async () => {
    const { service, pushSender, emailSender, markers } = build([
      reservation({ participants: [{ memberId: 'mem_guest', role: 'guest', status: 'confirmed' }] }),
    ]);
    pushSender.send.mockRejectedValueOnce(new Error('expo down'));

    const first = await service.sendDueReminders(NOW);
    expect(first).toMatchObject({ remindersSent: 1, failed: 0 });
    expect(markers.rows.get(markers.key('rsv_1', 'mem_guest'))).toMatchObject({ status: 'sent' });

    await service.sendDueReminders(NOW);
    expect(emailSender.send).toHaveBeenCalledTimes(1); // not re-sent
  });

  it('skips deleted members without failing the run', async () => {
    const { service, contacts } = build([
      reservation({ participants: [{ memberId: 'mem_gone', role: 'guest', status: 'confirmed' }] }),
    ]);
    contacts.delete('mem_gone');

    const result = await service.sendDueReminders(NOW);

    expect(result).toMatchObject({ remindersSent: 0, skipped: 1, failed: 0 });
  });
});
