import { ReservationService } from './reservation.service';
import type { AuditLog } from './ports';
import { wallTimeToUtc } from '@/lib/kernel';
import {
  ClubInviteNotAllowedError,
  HoldExpiredError,
  InvalidReservationStatusError,
  MaxReservationsExceededError,
  NotInvitePermittedError,
  CannotRemoveOrganizerError,
  PaymentNotCompletedError,
  ReservationAlreadyStartedError,
  ReservationChangedError,
  ReservationInPastError,
  ReservationNotFoundError,
  ReservationTooFarInAdvanceError,
  SlotUnavailableError,
  TierRequiredError,
  type BookingPaymentPort,
  type ClubRosterPort,
  type MembershipChecker,
  type ResourceType,
} from '../domain';
import type { ReservationRepository, ReservationDetailRecord } from '../infrastructure/reservation.repository';
import type { ResourceRepository, ResourceTypeRepository } from '../infrastructure/resource.repository';
import type { SlotClaimRepository } from '../infrastructure/slot-claim.repository';
import type { UnitOfWork } from '@/lib/kernel';

const NY = 'America/New_York';
// "Now": 2026-07-01 08:00 New York.
const NOW = wallTimeToUtc('2026-07-01', 8 * 60, NY);
const DATE = '2026-07-02';

const BADMINTON: ResourceType = {
  id: 'rt_badminton',
  code: 'badminton_court',
  name: 'Badminton Court',
  slotDurationMinutes: 30,
  opStartMinutes: 7 * 60,
  opEndMinutes: 22 * 60,
  hourlyRateCents: 2000,
  maxAdvanceDays: 7,
  maxReservationsPerMemberPerDay: 2,
  cancellationDeadlineMinutes: 60,
  minTier: 'member',
  active: true,
  displayOrder: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

const SHOWER: ResourceType = {
  ...BADMINTON,
  id: 'rt_shower',
  code: 'shower',
  name: 'Shower',
  minTier: 'pro',
  maxReservationsPerMemberPerDay: 1,
};

function resource(id: string, typeId = BADMINTON.id) {
  return { id, typeId, name: id, active: true, displayOrder: 0, createdAt: NOW, updatedAt: NOW };
}

function detailFixture(overrides: Partial<ReservationDetailRecord> = {}): ReservationDetailRecord {
  const startsAt = wallTimeToUtc(DATE, 18 * 60, NY);
  const endsAt = wallTimeToUtc(DATE, 19 * 60, NY);
  return {
    id: 'rsv_1',
    reference: 'BK-001000',
    resourceTypeId: BADMINTON.id,
    resourceId: 'r1',
    organizerId: 'mem_1',
    clubId: null,
    seriesId: null,
    startsAt,
    endsAt,
    localDate: DATE,
    status: 'pending_payment',
    hourlyRateCentsSnapshot: 2000,
    amountPaidCents: 0,
    cancelRefundPercent: null,
    createdByAdminId: null,
    createdAt: NOW,
    updatedAt: NOW,
    resourceType: BADMINTON,
    resource: { id: 'r1', name: 'r1' },
    participants: [
      {
        id: 'rp_org',
        reservationId: 'rsv_1',
        memberId: 'mem_1',
        role: 'organizer',
        status: 'confirmed',
        invitedById: null,
        viaClubId: null,
        invitedAt: NOW,
        respondedAt: null,
        member: { id: 'mem_1', firstName: 'Alice', lastName: 'Chen', email: 'alice@example.com' },
      },
    ],
    payments: [],
    claim: { id: 'clm_1', status: 'active', expiresAt: new Date(NOW.getTime() + 12 * 60_000) },
    pendingChange: null,
    ...overrides,
  };
}

function guest(memberId: string, status: 'pending' | 'confirmed' | 'declined' | 'withdrawn') {
  return {
    id: `rp_${memberId}`,
    reservationId: 'rsv_1',
    memberId,
    role: 'guest' as const,
    status,
    invitedById: 'mem_1',
    viaClubId: null,
    invitedAt: NOW,
    respondedAt: null,
    member: { id: memberId, firstName: 'Guest', lastName: memberId, email: `${memberId}@example.com` },
  };
}

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay_1',
    reservationId: 'rsv_1',
    kind: 'charge' as const,
    purpose: 'base' as const,
    amountCents: 2000,
    stripePaymentIntentId: 'pi_1',
    stripeRefundId: null,
    status: 'succeeded' as const,
    disputedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

/** A parked reschedule-grow (60 -> 90 min, +1000) awaiting its delta charge. */
function pendingChangeFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pc_1',
    reservationId: 'rsv_1',
    resourceId: 'r1',
    startsAt: wallTimeToUtc(DATE, 19 * 60, NY),
    endsAt: wallTimeToUtc(DATE, 20 * 60 + 30, NY),
    localDate: DATE,
    deltaCents: 1000,
    chargePaymentId: 'pay_2',
    expiresAt: new Date(NOW.getTime() + 12 * 60_000),
    createdAt: NOW,
    ...overrides,
  };
}

function deltaChargeRow(overrides: Record<string, unknown> = {}) {
  return paymentRow({
    id: 'pay_2',
    amountCents: 1000,
    stripePaymentIntentId: 'pi_2',
    status: 'pending' as const,
    createdAt: new Date(NOW.getTime() + 1000), // newer than the base charge
    ...overrides,
  });
}

function mockTypeRepo(types: ResourceType[] = [BADMINTON, SHOWER]): ResourceTypeRepository {
  return {
    listAll: vi.fn().mockResolvedValue(types),
    listActive: vi.fn().mockResolvedValue(types),
    getByCode: vi.fn(async (code: string) => types.find((type) => type.code === code) ?? null),
    getById: vi.fn(async (id: string) => types.find((type) => type.id === id) ?? null),
    create: vi.fn(),
    update: vi.fn(),
  } as unknown as ResourceTypeRepository;
}

function mockResourceRepo(resources = [resource('r1'), resource('r2')]): ResourceRepository {
  return {
    listAll: vi.fn().mockResolvedValue(resources),
    listActiveByType: vi.fn(async (typeId: string) => resources.filter((row) => row.typeId === typeId)),
    listByTypeIds: vi.fn().mockResolvedValue(resources),
    getById: vi.fn(async (id: string) => resources.find((row) => row.id === id) ?? null),
    listByIds: vi.fn().mockResolvedValue(resources),
    countActiveByType: vi.fn().mockResolvedValue(new Map([[BADMINTON.id, resources.length]])),
    create: vi.fn(),
    update: vi.fn(),
  } as unknown as ResourceRepository;
}

function mockClaimRepo(): SlotClaimRepository {
  return {
    listActiveInWindow: vi.fn().mockResolvedValue([]),
    listReservationConflicts: vi.fn().mockResolvedValue([]),
    listEventResources: vi.fn().mockResolvedValue(new Map()),
    deleteEventClaims: vi.fn(),
    insertEventClaims: vi.fn(),
  } as unknown as SlotClaimRepository;
}

function mockReservationRepo(): ReservationRepository {
  return {
    getDetail: vi.fn(),
    listForMember: vi.fn().mockResolvedValue([]),
    listAll: vi.fn().mockResolvedValue([]),
    countUpcomingForResources: vi.fn().mockResolvedValue(0),
    advisoryLockMember: vi.fn(),
    advisoryLockReservation: vi.fn(),
    countActiveOnDate: vi.fn().mockResolvedValue(0),
    forceReleaseExpiredHolds: vi.fn().mockResolvedValue([]),
    createWithClaim: vi.fn(),
    moveClaimAndReservation: vi.fn(),
    transitionStatus: vi.fn().mockResolvedValue(true),
    confirmFrom: vi.fn().mockResolvedValue(true),
    releaseClaim: vi.fn(),
    reactivateClaim: vi.fn().mockResolvedValue(true),
    adjustAmountPaid: vi.fn(),
    addPayment: vi.fn().mockResolvedValue(paymentRow()),
    setPaymentStatusIf: vi.fn().mockResolvedValue(true),
    completeRefund: vi.fn().mockResolvedValue(true),
    setCancelRefundPercent: vi.fn(),
    findPaymentByStripeRefundId: vi.fn().mockResolvedValue(null),
    getPaymentById: vi.fn().mockResolvedValue(null),
    adoptReservedRefund: vi.fn().mockResolvedValue(true),
    listStalePendingRefunds: vi.fn().mockResolvedValue([]),
    findChargeByPaymentIntent: vi.fn().mockResolvedValue(null),
    findReservationIdByPaymentIntent: vi.fn().mockResolvedValue(null),
    markChargeDisputed: vi.fn().mockResolvedValue([]),
    countBlockingFinancialState: vi.fn().mockResolvedValue({ pendingRefunds: 0, disputedCharges: 0 }),
    createPendingChange: vi.fn(),
    clearPendingChange: vi.fn().mockResolvedValue(true),
    setPendingChangeCharge: vi.fn().mockResolvedValue(true),
    listExpiredPendingChanges: vi.fn().mockResolvedValue([]),
    getParticipant: vi.fn(),
    upsertPendingInvite: vi.fn(),
    updateParticipantStatus: vi.fn(),
    deleteParticipant: vi.fn(),
    resetConfirmedGuestsToPending: vi.fn().mockResolvedValue([]),
    listExpiredHolds: vi.fn().mockResolvedValue([]),
    filterExistingMemberIds: vi.fn(async (ids: string[]) => new Set(ids)),
  } as unknown as ReservationRepository;
}

function mockChecker(tier: 'member' | 'pro' | null = 'member'): MembershipChecker {
  return {
    hasActiveMembership: vi.fn().mockResolvedValue(tier !== null),
    getTier: vi.fn().mockResolvedValue(tier),
  };
}

function mockPaymentPort(): BookingPaymentPort {
  return {
    createPaymentIntent: vi.fn().mockResolvedValue({ paymentIntentId: 'pi_1', clientSecret: 'pi_1_secret' }),
    getPaymentStatus: vi.fn().mockResolvedValue('succeeded'),
    refund: vi.fn().mockResolvedValue({ refundId: 're_1' }),
    cancelPaymentIntent: vi.fn().mockResolvedValue(undefined),
  };
}

function mockAudit(): AuditLog {
  return { append: vi.fn().mockResolvedValue({ id: 'evt', seq: 1 }) };
}

function mockUow(): UnitOfWork {
  return { execute: vi.fn(async (fn: any) => fn({})) } as unknown as UnitOfWork;
}

function buildService(overrides: {
  typeRepo?: ResourceTypeRepository;
  resourceRepo?: ResourceRepository;
  claimRepo?: SlotClaimRepository;
  reservationRepo?: ReservationRepository;
  checker?: MembershipChecker;
  paymentPort?: BookingPaymentPort;
  audit?: AuditLog;
  uow?: UnitOfWork;
  clubRoster?: ClubRosterPort;
} = {}) {
  const typeRepo = overrides.typeRepo ?? mockTypeRepo();
  const resourceRepo = overrides.resourceRepo ?? mockResourceRepo();
  const claimRepo = overrides.claimRepo ?? mockClaimRepo();
  const reservationRepo = overrides.reservationRepo ?? mockReservationRepo();
  const checker = overrides.checker ?? mockChecker();
  const paymentPort = overrides.paymentPort ?? mockPaymentPort();
  const audit = overrides.audit ?? mockAudit();
  const uow = overrides.uow ?? mockUow();
  const service = new ReservationService(
    typeRepo,
    resourceRepo,
    claimRepo,
    reservationRepo,
    checker,
    paymentPort,
    audit,
    uow,
    { timezone: NY, holdMinutes: 12 },
    overrides.clubRoster,
  );
  return { service, typeRepo, resourceRepo, claimRepo, reservationRepo, checker, paymentPort, audit, uow };
}

function auditEventTypes(audit: AuditLog): string[] {
  return (audit.append as ReturnType<typeof vi.fn>).mock.calls.map(([, event]) => event.eventType);
}

const CREATE_REQUEST = {
  typeCode: 'badminton_court',
  date: DATE,
  slots: ['18:00', '18:30'],
  organizerId: 'mem_1',
  now: NOW,
};

describe('ReservationService.create', () => {
  it('inserts pending_payment + hold in one transaction, then creates the intent outside it', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const detail = detailFixture();
    (reservationRepo.createWithClaim as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    const { service } = buildService({ reservationRepo, paymentPort });

    const result = await service.create(CREATE_REQUEST);

    expect(reservationRepo.advisoryLockMember).toHaveBeenCalledWith(expect.anything(), 'mem_1');
    expect(reservationRepo.createWithClaim).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'pending_payment',
        resourceId: 'r1',
        holdExpiresAt: new Date(NOW.getTime() + 12 * 60_000),
        startsAt: wallTimeToUtc(DATE, 18 * 60, NY),
        endsAt: wallTimeToUtc(DATE, 19 * 60, NY),
        participants: [expect.objectContaining({ role: 'organizer', status: 'confirmed' })],
      }),
    );
    expect(paymentPort.createPaymentIntent).toHaveBeenCalledWith({
      reservationId: 'rsv_1',
      memberId: 'mem_1',
      amountCents: 2000,
      attempt: 1,
    });
    expect(reservationRepo.addPayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'charge', amountCents: 2000, status: 'pending' }),
    );
    expect(result.clientSecret).toBe('pi_1_secret');
    expect(result.holdExpiresAt).toEqual(new Date(NOW.getTime() + 12 * 60_000));
  });

  it('sweeps expired holds on the type resources before computing candidates', async () => {
    const reservationRepo = mockReservationRepo();
    const detail = detailFixture();
    (reservationRepo.createWithClaim as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    const { service } = buildService({ reservationRepo });

    await service.create(CREATE_REQUEST);

    expect(reservationRepo.listExpiredHolds).toHaveBeenCalledWith(NOW, ['r1', 'r2']);
  });

  it('retries the next candidate resource on a 23P01 conflict', async () => {
    const reservationRepo = mockReservationRepo();
    const detail = detailFixture({ resourceId: 'r2' });
    (reservationRepo.createWithClaim as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new SlotUnavailableError())
      .mockResolvedValueOnce(detail);
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    const { service } = buildService({ reservationRepo });

    const result = await service.create(CREATE_REQUEST);

    expect(reservationRepo.createWithClaim).toHaveBeenCalledTimes(2);
    expect((reservationRepo.createWithClaim as ReturnType<typeof vi.fn>).mock.calls[0][1].resourceId).toBe('r1');
    expect((reservationRepo.createWithClaim as ReturnType<typeof vi.fn>).mock.calls[1][1].resourceId).toBe('r2');
    expect(result.reservation.resourceId).toBe('r2');
  });

  it('fails with "slot just taken" when every candidate conflicts', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.createWithClaim as ReturnType<typeof vi.fn>).mockRejectedValue(new SlotUnavailableError());
    const { service } = buildService({ reservationRepo });

    await expect(service.create(CREATE_REQUEST)).rejects.toThrow(SlotUnavailableError);
    expect(reservationRepo.createWithClaim).toHaveBeenCalledTimes(2);
  });

  it('rejects a fragmented selection no single resource can host', async () => {
    const claimRepo = mockClaimRepo();
    (claimRepo.listActiveInWindow as ReturnType<typeof vi.fn>).mockResolvedValue([
      { resourceId: 'r1', startsAt: wallTimeToUtc(DATE, 18 * 60, NY), endsAt: wallTimeToUtc(DATE, 18 * 60 + 30, NY) },
      { resourceId: 'r2', startsAt: wallTimeToUtc(DATE, 18 * 60 + 30, NY), endsAt: wallTimeToUtc(DATE, 19 * 60, NY) },
    ]);
    const reservationRepo = mockReservationRepo();
    const { service } = buildService({ claimRepo, reservationRepo });

    await expect(service.create(CREATE_REQUEST)).rejects.toThrow(SlotUnavailableError);
    expect(reservationRepo.createWithClaim).not.toHaveBeenCalled();
  });

  it('enforces the per-member daily limit under the advisory lock', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.countActiveOnDate as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    const { service } = buildService({ reservationRepo });

    await expect(service.create(CREATE_REQUEST)).rejects.toThrow(MaxReservationsExceededError);
    expect(reservationRepo.advisoryLockMember).toHaveBeenCalled();
    expect(reservationRepo.createWithClaim).not.toHaveBeenCalled();
  });

  it('gates PRO facilities on the membership tier', async () => {
    const resourceRepo = mockResourceRepo([resource('s1', SHOWER.id)]);
    const { service } = buildService({ resourceRepo, checker: mockChecker('member') });

    await expect(
      service.create({ ...CREATE_REQUEST, typeCode: 'shower' }),
    ).rejects.toThrow(TierRequiredError);
  });

  it('lets admins comp a reservation: confirmed, no hold, no payment', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const detail = detailFixture({ status: 'confirmed', createdByAdminId: 'usr_admin' });
    (reservationRepo.createWithClaim as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    const { service } = buildService({ reservationRepo, paymentPort });

    const result = await service.create({ ...CREATE_REQUEST, admin: { adminUserId: 'usr_admin' } });

    expect(reservationRepo.createWithClaim).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'confirmed', holdExpiresAt: null, createdByAdminId: 'usr_admin' }),
    );
    expect(paymentPort.createPaymentIntent).not.toHaveBeenCalled();
    expect(reservationRepo.addPayment).not.toHaveBeenCalled();
    expect(result.clientSecret).toBeNull();
  });

  it('rejects dates outside the horizon', async () => {
    const { service } = buildService();
    await expect(service.create({ ...CREATE_REQUEST, date: '2026-06-30' })).rejects.toThrow(ReservationInPastError);
    await expect(service.create({ ...CREATE_REQUEST, date: '2026-07-09' })).rejects.toThrow(
      ReservationTooFarInAdvanceError,
    );
  });

  it('releases the hold via a guarded transition when the payment intent cannot be created', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const detail = detailFixture();
    (reservationRepo.createWithClaim as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    (paymentPort.createPaymentIntent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('stripe down'));
    const { service } = buildService({ reservationRepo, paymentPort });

    await expect(service.create(CREATE_REQUEST)).rejects.toThrow('stripe down');
    expect(reservationRepo.transitionStatus).toHaveBeenCalledWith(
      expect.anything(),
      'rsv_1',
      ['pending_payment'],
      'expired',
    );
    expect(reservationRepo.releaseClaim).toHaveBeenCalledWith(expect.anything(), 'rsv_1');
  });
});

describe('ReservationService.confirm', () => {
  it('asserts payment success through the port and flips to confirmed via compare-and-set', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const detail = detailFixture({ payments: [paymentRow({ status: 'pending' })] });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    const { service } = buildService({ reservationRepo, paymentPort });

    await service.confirm('rsv_1', { memberId: 'mem_1' });

    expect(paymentPort.getPaymentStatus).toHaveBeenCalledWith('pi_1');
    expect(reservationRepo.advisoryLockReservation).toHaveBeenCalledWith(expect.anything(), 'rsv_1');
    expect(reservationRepo.confirmFrom).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 'pending_payment', 2000);
    expect(reservationRepo.setPaymentStatusIf).toHaveBeenCalledWith(expect.anything(), 'pay_1', 'pending', 'succeeded');
  });

  it('rejects a confirm by anyone but the organizer as a 404-shaped error', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detailFixture());
    const { service } = buildService({ reservationRepo });

    await expect(service.confirm('rsv_1', { memberId: 'mem_other' })).rejects.toThrow(ReservationNotFoundError);
  });

  it('fails closed when the payment has not succeeded', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (paymentPort.getPaymentStatus as ReturnType<typeof vi.fn>).mockResolvedValue('requires_payment');
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ payments: [paymentRow({ status: 'pending' })] }),
    );
    const { service } = buildService({ reservationRepo, paymentPort });

    await expect(service.confirm('rsv_1', { memberId: 'mem_1' })).rejects.toThrow(PaymentNotCompletedError);
  });

  it('is idempotent for an already confirmed reservation', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detailFixture({ status: 'confirmed' }));
    const { service } = buildService({ reservationRepo });

    const result = await service.confirm('rsv_1', { memberId: 'mem_1' });
    expect(result.status).toBe('confirmed');
    expect(reservationRepo.confirmFrom).not.toHaveBeenCalled();
  });

  it('appends no events when a concurrent confirmer already won (no duplicate outbox rows)', async () => {
    const reservationRepo = mockReservationRepo();
    const audit = mockAudit();
    const pending = detailFixture({ payments: [paymentRow({ status: 'pending' })] });
    const confirmed = detailFixture({ status: 'confirmed', amountPaidCents: 2000, payments: [paymentRow()] });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(pending) // getOwn
      .mockResolvedValue(confirmed); // in-tx fresh read: the race is already lost
    const { service } = buildService({ reservationRepo, audit });

    const result = await service.confirm('rsv_1', { memberId: 'mem_1' });

    expect(result.status).toBe('confirmed');
    expect(reservationRepo.confirmFrom).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('surfaces a concurrent cancel instead of resurrecting the reservation', async () => {
    const reservationRepo = mockReservationRepo();
    const pending = detailFixture({ payments: [paymentRow({ status: 'pending' })] });
    const cancelled = detailFixture({ status: 'cancelled' });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(pending) // getOwn
      .mockResolvedValue(cancelled); // fresh reads
    const { service } = buildService({ reservationRepo });

    await expect(service.confirm('rsv_1', { memberId: 'mem_1' })).rejects.toThrow(InvalidReservationStatusError);
    expect(reservationRepo.confirmFrom).not.toHaveBeenCalled();
  });

  it('recovers an expired reservation whose intent captured by re-acquiring the slot', async () => {
    const reservationRepo = mockReservationRepo();
    const audit = mockAudit();
    const expired = detailFixture({ status: 'expired', payments: [paymentRow({ status: 'pending' })] });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(expired);
    const { service } = buildService({ reservationRepo, audit });

    await service.confirm('rsv_1', { memberId: 'mem_1' });

    expect(reservationRepo.reactivateClaim).toHaveBeenCalledWith(expect.anything(), 'rsv_1');
    expect(reservationRepo.confirmFrom).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 'expired', 2000);
    expect(auditEventTypes(audit)).toEqual(
      expect.arrayContaining(['reservation.payment_captured', 'reservation.confirmed']),
    );
  });

  it('refunds a captured charge in full when the expired slot is already gone', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const audit = mockAudit();
    const expired = detailFixture({ status: 'expired', payments: [paymentRow({ status: 'pending' })] });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(expired);
    (reservationRepo.reactivateClaim as ReturnType<typeof vi.fn>).mockRejectedValue(new SlotUnavailableError());
    const { service } = buildService({ reservationRepo, paymentPort, audit });

    await expect(service.confirm('rsv_1', { memberId: 'mem_1' })).rejects.toThrow(HoldExpiredError);

    // The refund was reserved as a pending ledger row, then executed.
    expect(reservationRepo.addPayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'refund', amountCents: 2000, status: 'pending' }),
    );
    expect(paymentPort.refund).toHaveBeenCalledWith({ paymentIntentId: 'pi_1', amountCents: 2000, reservationId: 'rsv_1', refundKey: expect.any(String) });
    expect(reservationRepo.completeRefund).toHaveBeenCalledWith(expect.anything(), 'pay_1', 're_1');
    expect(auditEventTypes(audit)).toEqual(
      expect.arrayContaining(['reservation.expired_paid_refunded', 'reservation.payment_refunded']),
    );
  });

  it('reports an expired hold whose payment never succeeded', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (paymentPort.getPaymentStatus as ReturnType<typeof vi.fn>).mockResolvedValue('requires_payment');
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'expired', payments: [paymentRow({ status: 'pending' })] }),
    );
    const { service } = buildService({ reservationRepo, paymentPort });

    await expect(service.confirm('rsv_1', { memberId: 'mem_1' })).rejects.toThrow(HoldExpiredError);
  });

  it('applies a PAID pending change: the claim moves only now', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const detail = detailFixture({
      status: 'confirmed',
      amountPaidCents: 2000,
      payments: [paymentRow(), deltaChargeRow()],
      pendingChange: pendingChangeFixture() as never,
    });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    const { service } = buildService({ reservationRepo, paymentPort });

    await service.confirm('rsv_1', { memberId: 'mem_1' });

    expect(paymentPort.getPaymentStatus).toHaveBeenCalledWith('pi_2');
    expect(reservationRepo.moveClaimAndReservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reservationId: 'rsv_1',
        startsAt: wallTimeToUtc(DATE, 19 * 60, NY),
        endsAt: wallTimeToUtc(DATE, 20 * 60 + 30, NY),
      }),
    );
    expect(reservationRepo.clearPendingChange).toHaveBeenCalledWith(expect.anything(), 'rsv_1');
    expect(reservationRepo.setPaymentStatusIf).toHaveBeenCalledWith(expect.anything(), 'pay_2', 'pending', 'succeeded');
    expect(reservationRepo.adjustAmountPaid).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 1000);
  });

  it('refunds the delta and keeps the original booking when the parked slot is gone', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const audit = mockAudit();
    const detail = detailFixture({
      status: 'confirmed',
      amountPaidCents: 2000,
      payments: [paymentRow(), deltaChargeRow()],
      pendingChange: pendingChangeFixture() as never,
    });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    (reservationRepo.moveClaimAndReservation as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SlotUnavailableError(),
    );
    const { service } = buildService({ reservationRepo, paymentPort, audit });

    await expect(service.confirm('rsv_1', { memberId: 'mem_1' })).rejects.toThrow(SlotUnavailableError);

    expect(reservationRepo.clearPendingChange).toHaveBeenCalledWith(expect.anything(), 'rsv_1');
    expect(paymentPort.refund).toHaveBeenCalledWith({ paymentIntentId: 'pi_2', amountCents: 1000, reservationId: 'rsv_1', refundKey: expect.any(String) });
    expect(auditEventTypes(audit)).toEqual(expect.arrayContaining(['reservation.change_rejected']));
  });
});

describe('ReservationService.respond', () => {
  it('rechecks the reservation status inside the transaction', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'cancelled', participants: [detailFixture().participants[0], guest('mem_2', 'pending')] }),
    );
    const { service } = buildService({ reservationRepo });

    await expect(service.respond('rsv_1', 'mem_2', 'accept')).rejects.toThrow(InvalidReservationStatusError);
    expect(reservationRepo.updateParticipantStatus).not.toHaveBeenCalled();
  });

  it('accepts a pending invite', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed', participants: [detailFixture().participants[0], guest('mem_2', 'pending')] }),
    );
    const { service } = buildService({ reservationRepo });

    const result = await service.respond('rsv_1', 'mem_2', 'accept');

    expect(result.status).toBe('confirmed');
    expect(reservationRepo.updateParticipantStatus).toHaveBeenCalledWith(
      expect.anything(),
      'rp_mem_2',
      'confirmed',
      expect.any(Date),
    );
  });

  it('treats a repeat response as an idempotent no-op', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed', participants: [detailFixture().participants[0], guest('mem_2', 'declined')] }),
    );
    const { service } = buildService({ reservationRepo });

    const result = await service.respond('rsv_1', 'mem_2', 'decline');
    expect(result.status).toBe('declined');
    expect(reservationRepo.updateParticipantStatus).not.toHaveBeenCalled();
  });

  it('hides the reservation from non-participants', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detailFixture({ status: 'confirmed' }));
    const { service } = buildService({ reservationRepo });

    await expect(service.respond('rsv_1', 'mem_stranger', 'accept')).rejects.toThrow(ReservationNotFoundError);
  });
});

describe('ReservationService.addParticipants', () => {
  it('lets confirmed guests invite, per decision 6', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed', participants: [detailFixture().participants[0], guest('mem_2', 'confirmed')] }),
    );
    const { service } = buildService({ reservationRepo });

    const result = await service.addParticipants('rsv_1', 'mem_2', { memberIds: ['mem_3'] });

    expect(result.invited).toEqual(['mem_3']);
    expect(reservationRepo.upsertPendingInvite).toHaveBeenCalledWith(expect.anything(), {
      reservationId: 'rsv_1',
      memberId: 'mem_3',
      invitedById: 'mem_2',
      viaClubId: null,
    });
  });

  it('denies pending guests', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed', participants: [detailFixture().participants[0], guest('mem_2', 'pending')] }),
    );
    const { service } = buildService({ reservationRepo });

    await expect(service.addParticipants('rsv_1', 'mem_2', { memberIds: ['mem_3'] })).rejects.toThrow(NotInvitePermittedError);
  });

  it('skips already invited members and re-invites declined ones ("add all")', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({
        status: 'confirmed',
        participants: [
          detailFixture().participants[0],
          guest('mem_2', 'pending'),
          guest('mem_3', 'declined'),
        ],
      }),
    );
    const { service } = buildService({ reservationRepo });

    const result = await service.addParticipants('rsv_1', 'mem_1', {
      memberIds: ['mem_1', 'mem_2', 'mem_3', 'mem_4'],
    });

    expect(result.invited).toEqual(['mem_3', 'mem_4']);
    expect(reservationRepo.upsertPendingInvite).toHaveBeenCalledTimes(2);
  });
});

describe('club-chip invite expansion (ClubRosterPort seam)', () => {
  function mockClubRoster(rosters: Record<string, string[]>): ClubRosterPort {
    return {
      getRostersForInviter: vi.fn(async (clubIds: string[], inviterId: string) => {
        for (const clubId of clubIds) {
          if (!rosters[clubId]?.includes(inviterId)) throw new ClubInviteNotAllowedError();
        }
        return clubIds.map((clubId) => ({ clubId, memberIds: rosters[clubId] }));
      }),
    };
  }

  describe('create with inviteeClubIds', () => {
    it('snapshots the club roster into pending participants with viaClubId provenance, skipping the organizer', async () => {
      const reservationRepo = mockReservationRepo();
      const detail = detailFixture();
      (reservationRepo.createWithClaim as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
      (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
      const clubRoster = mockClubRoster({ club_1: ['mem_1', 'mem_2', 'mem_3'] });
      const { service, audit } = buildService({ reservationRepo, clubRoster });

      await service.create({ ...CREATE_REQUEST, inviteeClubIds: ['club_1'] });

      const participants = (reservationRepo.createWithClaim as ReturnType<typeof vi.fn>).mock
        .calls[0][1].participants;
      expect(participants).toEqual([
        expect.objectContaining({ memberId: 'mem_1', role: 'organizer', status: 'confirmed' }),
        expect.objectContaining({ memberId: 'mem_2', status: 'pending', viaClubId: 'club_1' }),
        expect.objectContaining({ memberId: 'mem_3', status: 'pending', viaClubId: 'club_1' }),
      ]);
      expect(
        (audit.append as ReturnType<typeof vi.fn>).mock.calls
          .filter(([, event]) => event.eventType === 'reservation.participant_invited')
          .map(([, event]) => event.data),
      ).toEqual([
        { memberId: 'mem_2', invitedById: 'mem_1', viaClubId: 'club_1' },
        { memberId: 'mem_3', invitedById: 'mem_1', viaClubId: 'club_1' },
      ]);
    });

    it('links the reservation to the first club and lets a direct invite outrank club provenance', async () => {
      const reservationRepo = mockReservationRepo();
      const detail = detailFixture();
      (reservationRepo.createWithClaim as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
      (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
      const clubRoster = mockClubRoster({
        club_1: ['mem_1', 'mem_2'],
        club_2: ['mem_1', 'mem_2', 'mem_4'],
      });
      const { service } = buildService({ reservationRepo, clubRoster });

      await service.create({
        ...CREATE_REQUEST,
        inviteeMemberIds: ['mem_2'],
        inviteeClubIds: ['club_1', 'club_2'],
      });

      const input = (reservationRepo.createWithClaim as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(input.clubId).toBe('club_1');
      // mem_2 was directly picked: one row, no club provenance; mem_4 rode club_2.
      expect(input.participants).toEqual([
        expect.objectContaining({ memberId: 'mem_1', role: 'organizer' }),
        expect.objectContaining({ memberId: 'mem_2', status: 'pending' }),
        expect.objectContaining({ memberId: 'mem_4', status: 'pending', viaClubId: 'club_2' }),
      ]);
      expect(input.participants[1].viaClubId).toBeUndefined();
    });

    it('rejects a club the organizer does not belong to before anything is written', async () => {
      const reservationRepo = mockReservationRepo();
      const clubRoster = mockClubRoster({ club_1: ['mem_9'] });
      const { service } = buildService({ reservationRepo, clubRoster });

      await expect(
        service.create({ ...CREATE_REQUEST, inviteeClubIds: ['club_1'] }),
      ).rejects.toThrow(ClubInviteNotAllowedError);
      expect(reservationRepo.createWithClaim).not.toHaveBeenCalled();
    });

    it('fails closed when no roster port is wired', async () => {
      const reservationRepo = mockReservationRepo();
      const { service } = buildService({ reservationRepo }); // no clubRoster

      await expect(
        service.create({ ...CREATE_REQUEST, inviteeClubIds: ['club_1'] }),
      ).rejects.toThrow(ClubInviteNotAllowedError);
      expect(reservationRepo.createWithClaim).not.toHaveBeenCalled();
    });
  });

  describe('addParticipants with clubIds', () => {
    it('expands against the ACTING inviter and skips already-invited members and the organizer', async () => {
      const reservationRepo = mockReservationRepo();
      (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
        detailFixture({
          status: 'confirmed',
          participants: [
            detailFixture().participants[0],
            guest('mem_2', 'confirmed'),
            guest('mem_3', 'pending'),
          ],
        }),
      );
      const clubRoster = mockClubRoster({ club_1: ['mem_1', 'mem_2', 'mem_3', 'mem_4'] });
      const { service } = buildService({ reservationRepo, clubRoster });

      const result = await service.addParticipants('rsv_1', 'mem_2', { clubIds: ['club_1'] });

      // mem_1 is the organizer, mem_2 the inviter, mem_3 already pending.
      expect(result.invited).toEqual(['mem_4']);
      expect(reservationRepo.upsertPendingInvite).toHaveBeenCalledTimes(1);
      expect(reservationRepo.upsertPendingInvite).toHaveBeenCalledWith(expect.anything(), {
        reservationId: 'rsv_1',
        memberId: 'mem_4',
        invitedById: 'mem_2',
        viaClubId: 'club_1',
      });
    });

    it('rejects a club the inviter does not belong to (cross-club authz)', async () => {
      const reservationRepo = mockReservationRepo();
      (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
        detailFixture({
          status: 'confirmed',
          participants: [detailFixture().participants[0], guest('mem_2', 'confirmed')],
        }),
      );
      const clubRoster = mockClubRoster({ club_1: ['mem_9'] });
      const { service } = buildService({ reservationRepo, clubRoster });

      await expect(
        service.addParticipants('rsv_1', 'mem_2', { clubIds: ['club_1'] }),
      ).rejects.toThrow(ClubInviteNotAllowedError);
      expect(reservationRepo.upsertPendingInvite).not.toHaveBeenCalled();
    });
  });
});

describe('ReservationService.removeParticipant', () => {
  it('lets only the organizer remove, and never the organizer row', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed', participants: [detailFixture().participants[0], guest('mem_2', 'pending')] }),
    );
    const { service } = buildService({ reservationRepo });

    await expect(service.removeParticipant('rsv_1', 'mem_2', 'mem_2')).rejects.toThrow(ReservationNotFoundError);
    await expect(service.removeParticipant('rsv_1', 'mem_1', 'mem_1')).rejects.toThrow(CannotRemoveOrganizerError);

    await service.removeParticipant('rsv_1', 'mem_1', 'mem_2');
    expect(reservationRepo.deleteParticipant).toHaveBeenCalledWith(expect.anything(), 'rp_mem_2');
  });
});

describe('ReservationService.reschedule', () => {
  function confirmedDetail(overrides: Partial<ReservationDetailRecord> = {}) {
    return detailFixture({
      status: 'confirmed',
      amountPaidCents: 2000,
      payments: [paymentRow()],
      participants: [detailFixture().participants[0], guest('mem_2', 'confirmed')],
      ...overrides,
    });
  }

  it('moves the claim, resets confirmed guests and reserves+executes a shrink refund', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const detail = confirmedDetail();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    (reservationRepo.resetConfirmedGuestsToPending as ReturnType<typeof vi.fn>).mockResolvedValue(['mem_2']);
    const { service } = buildService({ reservationRepo, paymentPort });

    // Shrink from 60 to 30 minutes: delta -1000 at the snapshot rate.
    const result = await service.reschedule('rsv_1', 'mem_1', { date: DATE, slots: ['19:00'] }, undefined, NOW);

    expect(reservationRepo.advisoryLockReservation).toHaveBeenCalledWith(expect.anything(), 'rsv_1');
    expect(reservationRepo.moveClaimAndReservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reservationId: 'rsv_1',
        resourceId: 'r1', // same resource preferred
        startsAt: wallTimeToUtc(DATE, 19 * 60, NY),
        endsAt: wallTimeToUtc(DATE, 19 * 60 + 30, NY),
      }),
    );
    expect(reservationRepo.resetConfirmedGuestsToPending).toHaveBeenCalledWith(expect.anything(), 'rsv_1');
    expect(result.deltaCents).toBe(-1000);
    // Reserved as a pending ledger row in the transaction, executed after.
    expect(reservationRepo.addPayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'refund', amountCents: 1000, status: 'pending' }),
    );
    expect(paymentPort.refund).toHaveBeenCalledWith({ paymentIntentId: 'pi_1', amountCents: 1000, reservationId: 'rsv_1', refundKey: expect.any(String) });
    expect(reservationRepo.completeRefund).toHaveBeenCalledWith(expect.anything(), 'pay_1', 're_1');
    expect(reservationRepo.adjustAmountPaid).toHaveBeenCalledWith(expect.anything(), 'rsv_1', -1000);
  });

  it('parks a grow as a pending change: intent first, no move until the delta is paid', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(confirmedDetail());
    const { service } = buildService({ reservationRepo, paymentPort });

    const result = await service.reschedule(
      'rsv_1',
      'mem_1',
      { date: DATE, slots: ['19:00', '19:30', '20:00'] },
      undefined,
      NOW,
    );

    expect(result.deltaCents).toBe(1000);
    expect(result.clientSecret).toBe('pi_1_secret');
    expect(paymentPort.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 1000, reservationId: 'rsv_1' }),
    );
    // Nothing moved and no money was captured: the change is parked.
    expect(reservationRepo.moveClaimAndReservation).not.toHaveBeenCalled();
    expect(reservationRepo.addPayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'charge', amountCents: 1000, status: 'pending' }),
    );
    expect(reservationRepo.createPendingChange).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reservationId: 'rsv_1',
        deltaCents: 1000,
        chargePaymentId: 'pay_1',
        expiresAt: new Date(NOW.getTime() + 12 * 60_000),
      }),
    );
  });

  it('leaves the reservation untouched when the delta intent cannot be created', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(confirmedDetail());
    (paymentPort.createPaymentIntent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('stripe down'));
    const { service } = buildService({ reservationRepo, paymentPort });

    await expect(
      service.reschedule('rsv_1', 'mem_1', { date: DATE, slots: ['19:00', '19:30', '20:00'] }, undefined, NOW),
    ).rejects.toThrow('stripe down');

    expect(reservationRepo.moveClaimAndReservation).not.toHaveBeenCalled();
    expect(reservationRepo.createPendingChange).not.toHaveBeenCalled();
    expect(reservationRepo.addPayment).not.toHaveBeenCalled();
  });

  it('refuses to reschedule anything but a confirmed reservation', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detailFixture());
    const { service } = buildService({ reservationRepo });

    await expect(
      service.reschedule('rsv_1', 'mem_1', { date: DATE, slots: ['19:00'] }, undefined, NOW),
    ).rejects.toThrow(InvalidReservationStatusError);
  });

  it('self-excludes: the availability read ignores the reservation being moved', async () => {
    const claimRepo = mockClaimRepo();
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(confirmedDetail());
    const { service } = buildService({ claimRepo, reservationRepo });

    await service.rescheduleQuote('rsv_1', 'mem_1', { date: DATE, slots: ['19:00'] }, NOW);

    expect(claimRepo.listActiveInWindow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { excludeReservationId: 'rsv_1', now: NOW },
    );
  });
});

describe('ReservationService.cancel', () => {
  it('applies the 50% tier between 2h and 24h from FRESH in-transaction state', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed', amountPaidCents: 2000, payments: [paymentRow()] }),
    );
    const { service } = buildService({ reservationRepo, paymentPort });

    // 18:00 next day, cancelled the same morning: inside 2-24h.
    const now = wallTimeToUtc(DATE, 10 * 60, NY);
    const { refundCents } = await service.cancel('rsv_1', { memberId: 'mem_1', now });

    expect(refundCents).toBe(1000);
    expect(reservationRepo.advisoryLockReservation).toHaveBeenCalledWith(expect.anything(), 'rsv_1');
    expect(reservationRepo.transitionStatus).toHaveBeenCalledWith(
      expect.anything(),
      'rsv_1',
      ['pending_payment', 'confirmed'],
      'cancelled',
    );
    expect(reservationRepo.releaseClaim).toHaveBeenCalled();
    expect(paymentPort.refund).toHaveBeenCalledWith({ paymentIntentId: 'pi_1', amountCents: 1000, reservationId: 'rsv_1', refundKey: expect.any(String) });
  });

  it('refunds fully outside 24h and nothing inside 2h', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed', amountPaidCents: 2000, payments: [paymentRow()] }),
    );
    const { service } = buildService({ reservationRepo, paymentPort });

    const early = await service.cancel('rsv_1', { memberId: 'mem_1', now: NOW });
    expect(early.refundCents).toBe(2000);

    const late = await service.cancel('rsv_1', {
      memberId: 'mem_1',
      now: wallTimeToUtc(DATE, 17 * 60, NY),
    });
    expect(late.refundCents).toBe(0);
  });

  it('refunds fully for admin cancellations regardless of tier', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed', amountPaidCents: 2000, payments: [paymentRow()] }),
    );
    const { service } = buildService({ reservationRepo });

    const { refundCents } = await service.cancel('rsv_1', {
      fullRefund: true,
      now: wallTimeToUtc(DATE, 17 * 60, NY),
    });
    expect(refundCents).toBe(2000);
  });

  it('cancels an UNPAID pending_payment hold without a refund and voids the intent', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (paymentPort.getPaymentStatus as ReturnType<typeof vi.fn>).mockResolvedValue('requires_payment');
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ payments: [paymentRow({ status: 'pending' })] }),
    );
    const { service } = buildService({ reservationRepo, paymentPort });

    const { refundCents } = await service.cancel('rsv_1', { memberId: 'mem_1', now: NOW });

    expect(refundCents).toBe(0);
    expect(paymentPort.cancelPaymentIntent).toHaveBeenCalledWith('pi_1');
    expect(paymentPort.refund).not.toHaveBeenCalled();
  });

  it('never eats a captured charge: a paid-but-unconfirmed hold is confirmed, then refunded per tier', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const pendingPaid = detailFixture({ payments: [paymentRow({ status: 'pending' })] });
    const confirmedPaid = detailFixture({
      status: 'confirmed',
      amountPaidCents: 2000,
      payments: [paymentRow()],
    });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(pendingPaid) // getOwn
      .mockResolvedValueOnce(pendingPaid) // settlePendingConfirmation fresh read
      .mockResolvedValue(confirmedPaid); // cancel transaction and after
    const { service } = buildService({ reservationRepo, paymentPort });

    // The stub intent reports succeeded: the money is captured.
    const { refundCents } = await service.cancel('rsv_1', { memberId: 'mem_1', now: NOW });

    expect(reservationRepo.confirmFrom).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 'pending_payment', 2000);
    expect(refundCents).toBe(2000); // >24h out: 100% tier
    expect(paymentPort.refund).toHaveBeenCalledWith({ paymentIntentId: 'pi_1', amountCents: 2000, reservationId: 'rsv_1', refundKey: expect.any(String) });
    expect(paymentPort.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it('refunds a PAID unapplied pending change at 100% on top of the tiered base refund', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({
        status: 'confirmed',
        amountPaidCents: 2000,
        payments: [paymentRow(), deltaChargeRow()],
        pendingChange: pendingChangeFixture() as never,
      }),
    );
    const { service } = buildService({ reservationRepo, paymentPort });

    // 2-24h window: base refunds 50% of 2000 = 1000; the paid delta (1000)
    // bought time that was never delivered, so it comes back in full.
    const now = wallTimeToUtc(DATE, 10 * 60, NY);
    const { refundCents } = await service.cancel('rsv_1', { memberId: 'mem_1', now });

    expect(refundCents).toBe(2000);
    expect(reservationRepo.clearPendingChange).toHaveBeenCalledWith(expect.anything(), 'rsv_1');
    expect(reservationRepo.setPaymentStatusIf).toHaveBeenCalledWith(expect.anything(), 'pay_2', 'pending', 'succeeded');
  });

  it('drops an UNPAID pending change and voids its intent on cancel', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (paymentPort.getPaymentStatus as ReturnType<typeof vi.fn>).mockResolvedValue('requires_payment');
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({
        status: 'confirmed',
        amountPaidCents: 2000,
        payments: [paymentRow(), deltaChargeRow()],
        pendingChange: pendingChangeFixture() as never,
      }),
    );
    const { service } = buildService({ reservationRepo, paymentPort });

    const { refundCents } = await service.cancel('rsv_1', { memberId: 'mem_1', now: NOW });

    expect(refundCents).toBe(2000); // base only, 100% tier
    expect(reservationRepo.setPaymentStatusIf).toHaveBeenCalledWith(expect.anything(), 'pay_2', 'pending', 'failed');
    expect(paymentPort.cancelPaymentIntent).toHaveBeenCalledWith('pi_2');
  });

  it('routes a failed void back through handleCapturedPayment (delta captured mid-drop is refunded, not stranded)', async () => {
    // The intent was judged unpaid, but captured before the post-commit
    // void: Stripe refuses the cancel, and the money must be settled
    // through the captured-payment entry point instead of swallowed.
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (paymentPort.getPaymentStatus as ReturnType<typeof vi.fn>).mockResolvedValue('requires_payment');
    (paymentPort.cancelPaymentIntent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('You cannot cancel this PaymentIntent because it has a status of succeeded.'),
    );
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({
        status: 'confirmed',
        amountPaidCents: 2000,
        payments: [paymentRow(), deltaChargeRow()],
        pendingChange: pendingChangeFixture() as never,
      }),
    );
    (reservationRepo.findChargeByPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValue(
      deltaChargeRow(),
    );
    const { service } = buildService({ reservationRepo, paymentPort });
    const settleSpy = vi.spyOn(service, 'handleCapturedPayment').mockResolvedValue('orphan_refunded');

    await service.cancel('rsv_1', { memberId: 'mem_1', now: NOW });

    expect(settleSpy).toHaveBeenCalledWith('rsv_1', {
      source: 'cancel',
      intent: { paymentIntentId: 'pi_2', amountCents: 1000 },
    });
  });

  it('yields when a concurrent transition already moved the reservation', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed', amountPaidCents: 2000, payments: [paymentRow()] }),
    );
    (reservationRepo.transitionStatus as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const { service } = buildService({ reservationRepo });

    await expect(service.cancel('rsv_1', { memberId: 'mem_1', now: NOW })).rejects.toThrow(
      InvalidReservationStatusError,
    );
    expect(reservationRepo.releaseClaim).not.toHaveBeenCalled();
  });

  it('refuses to cancel after the reservation started (members)', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed' }),
    );
    const { service } = buildService({ reservationRepo });

    await expect(
      service.cancel('rsv_1', { memberId: 'mem_1', now: wallTimeToUtc(DATE, 18 * 60 + 5, NY) }),
    ).rejects.toThrow(ReservationAlreadyStartedError);
  });
});

describe('ReservationService.expireStaleHolds', () => {
  it('confirms a hold whose payment actually succeeded instead of expiring it', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const hold = detailFixture({ payments: [paymentRow({ status: 'pending' })] });
    (reservationRepo.listExpiredHolds as ReturnType<typeof vi.fn>).mockResolvedValue([hold]);
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(hold);
    const { service } = buildService({ reservationRepo, paymentPort });

    const result = await service.expireStaleHolds(NOW);

    expect(result).toEqual({ expired: 0, confirmed: 1, changesApplied: 0, changesExpired: 0 });
    expect(reservationRepo.confirmFrom).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 'pending_payment', 2000);
    expect(reservationRepo.releaseClaim).not.toHaveBeenCalled();
  });

  it('expires a hold whose payment did not succeed via a guarded transition', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (paymentPort.getPaymentStatus as ReturnType<typeof vi.fn>).mockResolvedValue('requires_payment');
    const hold = detailFixture({ payments: [paymentRow({ status: 'pending' })] });
    (reservationRepo.listExpiredHolds as ReturnType<typeof vi.fn>).mockResolvedValue([hold]);
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(hold);
    const { service } = buildService({ reservationRepo, paymentPort });

    const result = await service.expireStaleHolds(NOW);

    expect(result).toEqual({ expired: 1, confirmed: 0, changesApplied: 0, changesExpired: 0 });
    expect(reservationRepo.transitionStatus).toHaveBeenCalledWith(
      expect.anything(),
      'rsv_1',
      ['pending_payment'],
      'expired',
    );
    expect(reservationRepo.releaseClaim).toHaveBeenCalled();
    expect(paymentPort.cancelPaymentIntent).toHaveBeenCalledWith('pi_1');
  });

  it('appends nothing when the client confirmed mid-race (no duplicate confirmed events)', async () => {
    const reservationRepo = mockReservationRepo();
    const audit = mockAudit();
    const hold = detailFixture({ payments: [paymentRow({ status: 'pending' })] });
    (reservationRepo.listExpiredHolds as ReturnType<typeof vi.fn>).mockResolvedValue([hold]);
    // By the time the sweeper's transaction reads it, the client confirmed.
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed', amountPaidCents: 2000, payments: [paymentRow()] }),
    );
    const { service } = buildService({ reservationRepo, audit });

    const result = await service.expireStaleHolds(NOW);

    expect(result).toEqual({ expired: 0, confirmed: 0, changesApplied: 0, changesExpired: 0 });
    expect(reservationRepo.confirmFrom).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('applies a PAID lapsed pending change instead of dropping it (died client)', async () => {
    const reservationRepo = mockReservationRepo();
    const detail = detailFixture({
      status: 'confirmed',
      amountPaidCents: 2000,
      payments: [paymentRow(), deltaChargeRow()],
      pendingChange: pendingChangeFixture() as never,
    });
    (reservationRepo.listExpiredPendingChanges as ReturnType<typeof vi.fn>).mockResolvedValue([detail]);
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    const { service } = buildService({ reservationRepo });

    const result = await service.expireStaleHolds(NOW);

    expect(result).toEqual({ expired: 0, confirmed: 0, changesApplied: 1, changesExpired: 0 });
    expect(reservationRepo.moveClaimAndReservation).toHaveBeenCalled();
    expect(reservationRepo.clearPendingChange).toHaveBeenCalledWith(expect.anything(), 'rsv_1');
  });

  it('drops an UNPAID lapsed pending change and voids its intent', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (paymentPort.getPaymentStatus as ReturnType<typeof vi.fn>).mockResolvedValue('requires_payment');
    const detail = detailFixture({
      status: 'confirmed',
      amountPaidCents: 2000,
      payments: [paymentRow(), deltaChargeRow()],
      pendingChange: pendingChangeFixture() as never,
    });
    (reservationRepo.listExpiredPendingChanges as ReturnType<typeof vi.fn>).mockResolvedValue([detail]);
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    const { service } = buildService({ reservationRepo, paymentPort });

    const result = await service.expireStaleHolds(NOW);

    expect(result).toEqual({ expired: 0, confirmed: 0, changesApplied: 0, changesExpired: 1 });
    expect(reservationRepo.moveClaimAndReservation).not.toHaveBeenCalled();
    expect(reservationRepo.setPaymentStatusIf).toHaveBeenCalledWith(expect.anything(), 'pay_2', 'pending', 'failed');
    expect(paymentPort.cancelPaymentIntent).toHaveBeenCalledWith('pi_2');
  });
});

describe('ReservationService.reissuePaymentIntent', () => {
  function pendingHoldDetail(overrides: Partial<ReservationDetailRecord> = {}) {
    return detailFixture({
      payments: [paymentRow({ status: 'pending' })],
      claim: { id: 'clm_1', status: 'active', expiresAt: new Date(NOW.getTime() + 10 * 60_000) },
      ...overrides,
    });
  }

  it('retires the old intent at Stripe BEFORE minting the replacement, swaps the ledger row and keeps the hold TTL', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const audit = mockAudit();
    const detail = pendingHoldDetail();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    (paymentPort.getPaymentStatus as ReturnType<typeof vi.fn>).mockResolvedValue('requires_payment');
    (paymentPort.createPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValue({
      paymentIntentId: 'pi_new',
      clientSecret: 'pi_new_secret',
    });
    const { service } = buildService({ reservationRepo, paymentPort, audit });

    const result = await service.reissuePaymentIntent('rsv_1', { memberId: 'mem_1', now: NOW });

    // NO-DOUBLE-CHARGE ordering: the old intent is uncapturable before the
    // new one exists.
    const cancelOrder = (paymentPort.cancelPaymentIntent as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const createOrder = (paymentPort.createPaymentIntent as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(paymentPort.cancelPaymentIntent).toHaveBeenCalledWith('pi_1');
    expect(cancelOrder).toBeLessThan(createOrder);

    expect(paymentPort.createPaymentIntent).toHaveBeenCalledWith({
      reservationId: 'rsv_1',
      memberId: 'mem_1',
      amountCents: 2000,
      attempt: 2, // one ledger row so far; attempts strictly increase
    });
    expect(reservationRepo.setPaymentStatusIf).toHaveBeenCalledWith(expect.anything(), 'pay_1', 'pending', 'failed');
    expect(reservationRepo.addPayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'charge',
        amountCents: 2000,
        stripePaymentIntentId: 'pi_new',
        status: 'pending',
      }),
    );
    expect(auditEventTypes(audit)).toContain('reservation.payment_intent_reissued');
    expect(result).toMatchObject({
      purpose: 'hold',
      amountCents: 2000,
      clientSecret: 'pi_new_secret',
      alreadyPaid: false,
    });
    // Same hold, same TTL: a reissue must never extend the squat.
    expect(result.expiresAt).toEqual(detail.claim!.expiresAt);
  });

  it('NO DOUBLE CHARGE: a captured intent is settled as alreadyPaid, never superseded', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort(); // getPaymentStatus defaults to succeeded
    const detail = pendingHoldDetail();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    const { service } = buildService({ reservationRepo, paymentPort });

    const result = await service.reissuePaymentIntent('rsv_1', { memberId: 'mem_1', now: NOW });

    expect(paymentPort.createPaymentIntent).not.toHaveBeenCalled();
    expect(paymentPort.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(reservationRepo.confirmFrom).toHaveBeenCalled(); // settled through confirm
    expect(result.alreadyPaid).toBe(true);
    expect(result.clientSecret).toBeNull();
  });

  it('NO DOUBLE CHARGE: a capture discovered when Stripe refuses the cancel settles instead of minting', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(pendingHoldDetail());
    (paymentPort.getPaymentStatus as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('requires_payment') // pre-cancel check
      .mockResolvedValue('succeeded'); // re-check after the refused cancel + confirm path
    (paymentPort.cancelPaymentIntent as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('You cannot cancel this PaymentIntent'),
    );
    const { service } = buildService({ reservationRepo, paymentPort });

    const result = await service.reissuePaymentIntent('rsv_1', { memberId: 'mem_1', now: NOW });

    expect(paymentPort.createPaymentIntent).not.toHaveBeenCalled();
    expect(result.alreadyPaid).toBe(true);
    expect(reservationRepo.confirmFrom).toHaveBeenCalled();
  });

  it('fails CLOSED when the old intent cannot be retired (no replacement while it might be live)', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(pendingHoldDetail());
    (paymentPort.getPaymentStatus as ReturnType<typeof vi.fn>).mockResolvedValue('requires_payment');
    (paymentPort.cancelPaymentIntent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('stripe down'));
    const { service } = buildService({ reservationRepo, paymentPort });

    await expect(
      service.reissuePaymentIntent('rsv_1', { memberId: 'mem_1', now: NOW }),
    ).rejects.toThrow('stripe down');
    expect(paymentPort.createPaymentIntent).not.toHaveBeenCalled();
    expect(reservationRepo.addPayment).not.toHaveBeenCalled();
  });

  it('refuses an expired hold without touching the payment port', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      pendingHoldDetail({
        claim: { id: 'clm_1', status: 'active', expiresAt: new Date(NOW.getTime() - 1000) },
      }),
    );
    const { service } = buildService({ reservationRepo, paymentPort });

    await expect(
      service.reissuePaymentIntent('rsv_1', { memberId: 'mem_1', now: NOW }),
    ).rejects.toThrow(HoldExpiredError);
    expect(paymentPort.getPaymentStatus).not.toHaveBeenCalled();
    expect(paymentPort.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(paymentPort.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('voids the replacement and reports the truth when the reservation resolved mid-reissue', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(pendingHoldDetail()) // getOwn
      .mockResolvedValue(detailFixture({ status: 'cancelled' })); // in-tx fresh + post-mortem
    (paymentPort.getPaymentStatus as ReturnType<typeof vi.fn>).mockResolvedValue('requires_payment');
    (paymentPort.createPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValue({
      paymentIntentId: 'pi_new',
      clientSecret: 'pi_new_secret',
    });
    const { service } = buildService({ reservationRepo, paymentPort });

    await expect(
      service.reissuePaymentIntent('rsv_1', { memberId: 'mem_1', now: NOW }),
    ).rejects.toThrow(InvalidReservationStatusError);
    // The replacement's secret never left the server; it is voided.
    expect(paymentPort.cancelPaymentIntent).toHaveBeenNthCalledWith(2, 'pi_new');
    expect(reservationRepo.addPayment).not.toHaveBeenCalled();
  });

  it('is organizer-only (404-shaped for everyone else)', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(pendingHoldDetail());
    const { service, paymentPort } = buildService({ reservationRepo });

    await expect(
      service.reissuePaymentIntent('rsv_1', { memberId: 'mem_intruder', now: NOW }),
    ).rejects.toThrow(ReservationNotFoundError);
    expect(paymentPort.getPaymentStatus).not.toHaveBeenCalled();
  });

  it('rejects a confirmed reservation with no pending change (nothing is owed)', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed', payments: [paymentRow()] }),
    );
    const { service } = buildService({ reservationRepo });

    await expect(
      service.reissuePaymentIntent('rsv_1', { memberId: 'mem_1', now: NOW }),
    ).rejects.toThrow(InvalidReservationStatusError);
  });

  it('reissues a live parked-change delta and repoints the change at the new row', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const audit = mockAudit();
    const pending = pendingChangeFixture();
    const detail = detailFixture({
      status: 'confirmed',
      payments: [paymentRow(), deltaChargeRow()],
      pendingChange: pending,
    });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    (reservationRepo.addPayment as ReturnType<typeof vi.fn>).mockResolvedValue(
      paymentRow({ id: 'pay_3', amountCents: 1000, stripePaymentIntentId: 'pi_new', status: 'pending' }),
    );
    (paymentPort.getPaymentStatus as ReturnType<typeof vi.fn>).mockResolvedValue('requires_payment');
    (paymentPort.createPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValue({
      paymentIntentId: 'pi_new',
      clientSecret: 'pi_new_secret',
    });
    const { service } = buildService({ reservationRepo, paymentPort, audit });

    const result = await service.reissuePaymentIntent('rsv_1', { memberId: 'mem_1', now: NOW });

    expect(paymentPort.cancelPaymentIntent).toHaveBeenCalledWith('pi_2');
    expect(paymentPort.createPaymentIntent).toHaveBeenCalledWith({
      reservationId: 'rsv_1',
      memberId: 'mem_1',
      amountCents: 1000,
      attempt: 3,
    });
    expect(reservationRepo.setPaymentStatusIf).toHaveBeenCalledWith(expect.anything(), 'pay_2', 'pending', 'failed');
    expect(reservationRepo.addPayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose: 'change_delta', amountCents: 1000, stripePaymentIntentId: 'pi_new' }),
    );
    expect(reservationRepo.setPendingChangeCharge).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 'pc_1', 'pay_3');
    expect(auditEventTypes(audit)).toContain('reservation.payment_intent_reissued');
    expect(result).toMatchObject({
      purpose: 'change_delta',
      amountCents: 1000,
      clientSecret: 'pi_new_secret',
      alreadyPaid: false,
    });
    expect(result.expiresAt).toEqual(pending.expiresAt);
  });

  it('NO DOUBLE CHARGE: a captured delta applies the move instead of minting', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort(); // succeeded by default
    const detail = detailFixture({
      status: 'confirmed',
      payments: [paymentRow(), deltaChargeRow()],
      pendingChange: pendingChangeFixture(),
    });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    const { service } = buildService({ reservationRepo, paymentPort });

    const result = await service.reissuePaymentIntent('rsv_1', { memberId: 'mem_1', now: NOW });

    expect(paymentPort.createPaymentIntent).not.toHaveBeenCalled();
    expect(reservationRepo.moveClaimAndReservation).toHaveBeenCalled(); // the paid move applied
    expect(result.alreadyPaid).toBe(true);
    expect(result.clientSecret).toBeNull();
  });

  it('treats a lapsed parked change as expired (the sweeper owns it)', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({
        status: 'confirmed',
        payments: [paymentRow(), deltaChargeRow()],
        pendingChange: pendingChangeFixture({ expiresAt: new Date(NOW.getTime() - 1000) }),
      }),
    );
    const { service } = buildService({ reservationRepo, paymentPort });

    await expect(
      service.reissuePaymentIntent('rsv_1', { memberId: 'mem_1', now: NOW }),
    ).rejects.toThrow(HoldExpiredError);
    expect(paymentPort.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('answers RESERVATION_CHANGED when the change charge is no longer pending', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({
        status: 'confirmed',
        payments: [paymentRow(), deltaChargeRow({ status: 'succeeded' })],
        pendingChange: pendingChangeFixture(),
      }),
    );
    const { service, paymentPort } = buildService({ reservationRepo });

    await expect(
      service.reissuePaymentIntent('rsv_1', { memberId: 'mem_1', now: NOW }),
    ).rejects.toThrow(ReservationChangedError);
    expect(paymentPort.createPaymentIntent).not.toHaveBeenCalled();
  });
});

describe('ReservationService availability and quote', () => {
  it('hides days where the member hit the daily limit', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.countActiveOnDate as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    const { service } = buildService({ reservationRepo });

    const days = await service.getAvailability({
      typeCode: 'badminton_court',
      startDate: DATE,
      memberId: 'mem_1',
      now: NOW,
    });

    expect(days).toEqual([{ date: DATE, slots: [] }]);
  });

  it('returns empty slots outside the horizon', async () => {
    const { service } = buildService();
    const days = await service.getAvailability({
      typeCode: 'badminton_court',
      startDate: '2026-07-07',
      days: 3,
      memberId: 'mem_1',
      now: NOW,
    });
    expect(days[0].slots.length).toBeGreaterThan(0); // 07-07 within 7 days
    expect(days[1].slots.length).toBeGreaterThan(0); // 07-08 boundary day
    expect(days[2].slots).toEqual([]); // 07-09 beyond maxAdvanceDays
  });

  it('asks the claim read to treat expired holds as free', async () => {
    const claimRepo = mockClaimRepo();
    const { service } = buildService({ claimRepo });

    await service.getAvailability({ typeCode: 'badminton_court', startDate: DATE, memberId: 'mem_1', now: NOW });

    expect(claimRepo.listActiveInWindow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { excludeReservationId: undefined, now: NOW },
    );
  });

  it('locks PRO types for member-tier viewers', async () => {
    const { service } = buildService({ checker: mockChecker('member') });
    await expect(
      service.getAvailability({ typeCode: 'shower', startDate: DATE, memberId: 'mem_1', now: NOW }),
    ).rejects.toThrow(TierRequiredError);
  });

  it('passes self-exclusion through for a participant of the reservation', async () => {
    const claimRepo = mockClaimRepo();
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed' }),
    );
    const { service } = buildService({ claimRepo, reservationRepo });

    await service.getAvailability({
      typeCode: 'badminton_court',
      startDate: DATE,
      memberId: 'mem_1',
      excludeReservationId: 'rsv_1',
      now: NOW,
    });

    expect(reservationRepo.getDetail).toHaveBeenCalledWith('rsv_1');
    expect(claimRepo.listActiveInWindow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { excludeReservationId: 'rsv_1', now: NOW },
    );
    // The daily-limit count must not charge the member for the excluded
    // reservation either (the edit flow's own booking).
    expect(reservationRepo.countActiveOnDate).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ excludeReservationId: 'rsv_1' }),
    );
  });

  it('answers 404-shaped when the excluded reservation is not the caller\'s', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed' }),
    );
    const { service, claimRepo } = buildService({ reservationRepo });

    await expect(
      service.getAvailability({
        typeCode: 'badminton_court',
        startDate: DATE,
        memberId: 'mem_other',
        excludeReservationId: 'rsv_1',
        now: NOW,
      }),
    ).rejects.toThrow(ReservationNotFoundError);
    expect(claimRepo.listActiveInWindow).not.toHaveBeenCalled();
  });

  it('answers 404-shaped when the excluded reservation does not exist', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { service } = buildService({ reservationRepo });

    await expect(
      service.getAvailability({
        typeCode: 'badminton_court',
        startDate: DATE,
        memberId: 'mem_1',
        excludeReservationId: 'rsv_missing',
        now: NOW,
      }),
    ).rejects.toThrow(ReservationNotFoundError);
  });

  it('quotes only when one resource can host the whole selection', async () => {
    const claimRepo = mockClaimRepo();
    (claimRepo.listActiveInWindow as ReturnType<typeof vi.fn>).mockResolvedValue([
      { resourceId: 'r1', startsAt: wallTimeToUtc(DATE, 18 * 60, NY), endsAt: wallTimeToUtc(DATE, 18 * 60 + 30, NY) },
      { resourceId: 'r2', startsAt: wallTimeToUtc(DATE, 18 * 60 + 30, NY), endsAt: wallTimeToUtc(DATE, 19 * 60, NY) },
    ]);
    const { service } = buildService({ claimRepo });

    await expect(
      service.quote({ typeCode: 'badminton_court', date: DATE, slots: ['18:00', '18:30'], memberId: 'mem_1', now: NOW }),
    ).rejects.toThrow(SlotUnavailableError);
  });

  it('prices a valid quote at the type rate', async () => {
    const { service } = buildService();
    const quote = await service.quote({
      typeCode: 'badminton_court',
      date: DATE,
      slots: ['18:00', '18:30', '19:00'],
      memberId: 'mem_1',
      now: NOW,
    });
    expect(quote).toMatchObject({ durationMinutes: 90, hourlyRateCents: 2000, totalCents: 3000 });
  });
});

describe('ReservationService.getForViewer', () => {
  it('serves participants with capability flags and hides from outsiders', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed', participants: [detailFixture().participants[0], guest('mem_2', 'pending')] }),
    );
    const { service } = buildService({ reservationRepo });

    const organizerView = await service.getForViewer('rsv_1', 'mem_1');
    expect(organizerView.viewer).toMatchObject({ role: 'organizer', canManage: true, canInvite: true, canRespond: false });

    const guestView = await service.getForViewer('rsv_1', 'mem_2');
    expect(guestView.viewer).toMatchObject({ role: 'guest', canManage: false, canInvite: false, canRespond: true });

    await expect(service.getForViewer('rsv_1', 'mem_x')).rejects.toThrow(ReservationNotFoundError);
  });
});

// ── Billing-context entry points (webhook + reconcile) ──

describe('ReservationService.handleCapturedPayment', () => {
  it('throws NOT-FOUND for an invisible reservation so the webhook 500s and Stripe retries', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { service } = buildService({ reservationRepo });

    await expect(service.handleCapturedPayment('rsv_ghost')).rejects.toThrow(ReservationNotFoundError);
  });

  it('confirms a paid pending_payment hold through the normal confirm path', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ payments: [paymentRow({ status: 'pending' })] }),
    );
    const { service, audit } = buildService({ reservationRepo });

    expect(await service.handleCapturedPayment('rsv_1', { source: 'webhook' })).toBe('confirmed');
    expect(reservationRepo.confirmFrom).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 'pending_payment', 2000);
    expect(auditEventTypes(audit)).toContain('reservation.confirmed');
  });

  it('recreates a missing charge row from the intent (crash between PI create and row insert)', async () => {
    const reservationRepo = mockReservationRepo();
    const withoutRow = detailFixture({ payments: [] });
    const withRow = detailFixture({ payments: [paymentRow({ status: 'pending' })] });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(withoutRow)
      .mockResolvedValue(withRow);
    const { service } = buildService({ reservationRepo });

    await service.handleCapturedPayment('rsv_1', {
      intent: { paymentIntentId: 'pi_1', amountCents: 2000 },
    });

    expect(reservationRepo.addPayment).toHaveBeenCalledWith(expect.anything(), {
      reservationId: 'rsv_1',
      kind: 'charge',
      amountCents: 2000,
      stripePaymentIntentId: 'pi_1',
      status: 'pending',
    });
  });

  it('refunds an orphaned capture on a CANCELLED reservation at the percent the cancel applied', async () => {
    const reservationRepo = mockReservationRepo();
    const cancelled = detailFixture({
      status: 'cancelled',
      cancelRefundPercent: 50,
      payments: [paymentRow({ status: 'pending' })],
    });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(cancelled);
    const { service, paymentPort, audit } = buildService({ reservationRepo });

    expect(await service.handleCapturedPayment('rsv_1', { source: 'reconcile' })).toBe('orphan_refunded');

    // The capture is acknowledged (pending -> succeeded, paid total up)...
    expect(reservationRepo.setPaymentStatusIf).toHaveBeenCalledWith(expect.anything(), 'pay_1', 'pending', 'succeeded');
    expect(reservationRepo.adjustAmountPaid).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 2000);
    // ...and HALF comes back (the 50% tier), not the full amount.
    expect(paymentPort.refund).toHaveBeenCalledWith({
      paymentIntentId: 'pi_1',
      amountCents: 1000,
      reservationId: 'rsv_1',
      refundKey: expect.any(String),
    });
    expect(auditEventTypes(audit)).toContain('reservation.orphaned_capture_refunded');
  });

  it('refunds an orphaned GROW delta at 100% (the time was never delivered), even off a failed row', async () => {
    const reservationRepo = mockReservationRepo();
    const cancelled = detailFixture({
      status: 'cancelled',
      cancelRefundPercent: 0,
      payments: [deltaChargeRow({ status: 'failed', purpose: 'change_delta' })],
    });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(cancelled);
    const { service, paymentPort } = buildService({ reservationRepo });

    expect(await service.handleCapturedPayment('rsv_1')).toBe('orphan_refunded');
    expect(reservationRepo.setPaymentStatusIf).toHaveBeenCalledWith(expect.anything(), 'pay_2', 'failed', 'succeeded');
    expect(paymentPort.refund).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: 'pi_2', amountCents: 1000 }),
    );
  });

  it('keeps the whole capture on a 0% cancellation (inside 2h) without calling Stripe', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'cancelled', cancelRefundPercent: 0, payments: [paymentRow({ status: 'pending' })] }),
    );
    const { service, paymentPort } = buildService({ reservationRepo });

    expect(await service.handleCapturedPayment('rsv_1')).toBe('already_settled');
    expect(reservationRepo.adjustAmountPaid).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 2000);
    expect(paymentPort.refund).not.toHaveBeenCalled();
  });

  it('is idempotent: a redelivered event on an already-settled cancelled reservation does nothing', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'cancelled', payments: [paymentRow({ status: 'succeeded' })] }),
    );
    const { service, paymentPort } = buildService({ reservationRepo });

    expect(await service.handleCapturedPayment('rsv_1')).toBe('not_captured');
    expect(reservationRepo.setPaymentStatusIf).not.toHaveBeenCalled();
    expect(paymentPort.refund).not.toHaveBeenCalled();
  });

  it('refunds a captured SUPERSEDED change delta on a CONFIRMED reservation at 100% (pay-vs-drop TOCTOU)', async () => {
    // A shrink superseded the parked grow (pendingChange cleared, delta row
    // marked failed) but the delta intent captured in the window. The
    // reservation stays confirmed; no live path settles pi_2, so the
    // capture is acknowledged and comes straight back.
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({
        status: 'confirmed',
        amountPaidCents: 2000,
        payments: [paymentRow(), deltaChargeRow({ status: 'failed', purpose: 'change_delta' })],
        pendingChange: null,
      }),
    );
    const { service, paymentPort, audit } = buildService({ reservationRepo });

    expect(await service.handleCapturedPayment('rsv_1', { source: 'webhook' })).toBe('orphan_refunded');

    // The Stripe capture is ground truth: failed -> succeeded, paid total up...
    expect(reservationRepo.setPaymentStatusIf).toHaveBeenCalledWith(expect.anything(), 'pay_2', 'failed', 'succeeded');
    expect(reservationRepo.adjustAmountPaid).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 1000);
    // ...and ALL of it comes back (the changed time was never delivered).
    expect(paymentPort.refund).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: 'pi_2', amountCents: 1000 }),
    );
    expect(auditEventTypes(audit)).toContain('reservation.orphaned_capture_refunded');
  });

  it('leaves the LIVE parked grow to confirm(): its charge is never treated as an orphan', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({
        status: 'confirmed',
        payments: [paymentRow(), deltaChargeRow()],
        pendingChange: pendingChangeFixture(),
      }),
    );
    const { service, paymentPort } = buildService({ reservationRepo });

    expect(await service.handleCapturedPayment('rsv_1', { source: 'webhook' })).toBe('confirmed');
    // The paid change APPLIED through settlePendingChange, no refund.
    expect(reservationRepo.moveClaimAndReservation).toHaveBeenCalled();
    expect(paymentPort.refund).not.toHaveBeenCalled();
  });

  it('does not touch a confirmed reservation whose superseded intent never captured', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({
        status: 'confirmed',
        payments: [paymentRow(), deltaChargeRow({ status: 'failed' })],
        pendingChange: null,
      }),
    );
    const paymentPort = mockPaymentPort();
    (paymentPort.getPaymentStatus as ReturnType<typeof vi.fn>).mockResolvedValue('canceled');
    const { service } = buildService({ reservationRepo, paymentPort });

    expect(await service.handleCapturedPayment('rsv_1')).toBe('confirmed'); // plain idempotent no-op
    expect(reservationRepo.adjustAmountPaid).not.toHaveBeenCalled();
    expect(paymentPort.refund).not.toHaveBeenCalled();
  });
});

describe('ReservationService.reconcileRefundOutcome', () => {
  it('reports an unknown refund id for external recording', async () => {
    const { service } = buildService();
    expect(await service.reconcileRefundOutcome('re_ghost', 'failed')).toBe('unknown');
  });

  it('flips an async-FAILED refund back and restores the paid total', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.findPaymentByStripeRefundId as ReturnType<typeof vi.fn>).mockResolvedValue(
      paymentRow({ id: 'pay_r', kind: 'refund', amountCents: 1000, stripeRefundId: 're_1', status: 'succeeded' }),
    );
    const { service, audit } = buildService({ reservationRepo });

    expect(await service.reconcileRefundOutcome('re_1', 'failed')).toBe('reconciled');
    expect(reservationRepo.setPaymentStatusIf).toHaveBeenCalledWith(expect.anything(), 'pay_r', 'succeeded', 'failed');
    expect(reservationRepo.adjustAmountPaid).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 1000);
    expect(auditEventTypes(audit)).toContain('reservation.refund_failed');
  });

  it('a succeeded outcome is a no-op for our own already-recorded refunds', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.findPaymentByStripeRefundId as ReturnType<typeof vi.fn>).mockResolvedValue(
      paymentRow({ id: 'pay_r', kind: 'refund', amountCents: 1000, stripeRefundId: 're_1', status: 'succeeded' }),
    );
    (reservationRepo.setPaymentStatusIf as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const { service } = buildService({ reservationRepo });

    expect(await service.reconcileRefundOutcome('re_1', 'succeeded')).toBe('reconciled');
    expect(reservationRepo.adjustAmountPaid).not.toHaveBeenCalled();
  });
});

describe('ReservationService.recordExternalRefund', () => {
  it('records a dashboard goodwill refund against the settlement ledger (balance stays truthful)', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.findReservationIdByPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValue('rsv_1');
    const { service, audit } = buildService({ reservationRepo });

    const outcome = await service.recordExternalRefund({
      stripeRefundId: 're_dash',
      stripePaymentIntentId: 'pi_1',
      amountCents: 500,
      status: 'succeeded',
    });

    expect(outcome).toBe('recorded');
    expect(reservationRepo.addPayment).toHaveBeenCalledWith(expect.anything(), {
      reservationId: 'rsv_1',
      kind: 'refund',
      amountCents: 500,
      stripePaymentIntentId: 'pi_1',
      stripeRefundId: 're_dash',
      status: 'succeeded',
    });
    expect(reservationRepo.adjustAmountPaid).toHaveBeenCalledWith(expect.anything(), 'rsv_1', -500);
    expect(auditEventTypes(audit)).toContain('reservation.external_refund_recorded');
  });

  it('is idempotent by stripeRefundId', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.findPaymentByStripeRefundId as ReturnType<typeof vi.fn>).mockResolvedValue(
      paymentRow({ kind: 'refund', stripeRefundId: 're_dash' }),
    );
    const { service } = buildService({ reservationRepo });

    expect(
      await service.recordExternalRefund({
        stripeRefundId: 're_dash',
        stripePaymentIntentId: 'pi_1',
        amountCents: 500,
        status: 'succeeded',
      }),
    ).toBe('known');
    expect(reservationRepo.addPayment).not.toHaveBeenCalled();
  });

  it('reports unmatched when no reservation owns the intent (not booking money)', async () => {
    const { service } = buildService();
    expect(
      await service.recordExternalRefund({
        stripeRefundId: 're_x',
        stripePaymentIntentId: 'pi_sub',
        amountCents: 4800,
        status: 'succeeded',
      }),
    ).toBe('unmatched');
  });

  it('ADOPTS our own reserved refund observed before completeRefund stamped it (never a second row)', async () => {
    // Crash between refunds.create returning re_123 and completeRefund: the
    // reserved row is still pending with no stripeRefundId. The webhook or
    // sweep observing re_123 must stamp THAT row, not insert a duplicate
    // that would double-decrement amountPaid.
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getPaymentById as ReturnType<typeof vi.fn>).mockResolvedValue(
      paymentRow({ id: 'pay_r', kind: 'refund', amountCents: 1000, stripeRefundId: null, status: 'pending' }),
    );
    (reservationRepo.setPaymentStatusIf as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tx: unknown, _id: string, expected: string) => expected === 'pending',
    );
    const { service, audit } = buildService({ reservationRepo });

    const outcome = await service.recordExternalRefund({
      stripeRefundId: 're_123',
      stripePaymentIntentId: 'pi_1',
      amountCents: 1000,
      status: 'succeeded',
      refundKey: 'pay_r',
    });

    expect(outcome).toBe('known');
    expect(reservationRepo.adoptReservedRefund).toHaveBeenCalledWith(expect.anything(), 'pay_r', 're_123');
    expect(reservationRepo.setPaymentStatusIf).toHaveBeenCalledWith(expect.anything(), 'pay_r', 'pending', 'succeeded');
    expect(reservationRepo.addPayment).not.toHaveBeenCalled(); // NO second refund row
    expect(reservationRepo.adjustAmountPaid).not.toHaveBeenCalled(); // reserve already decremented
    expect(auditEventTypes(audit)).toContain('reservation.reserved_refund_adopted');
  });

  it('adoption re-applies the decrement for a locally-FAILED reserved refund that actually reached Stripe', async () => {
    // refunds.create threw transiently, the failure handler restored the
    // balance — but the refund actually went through. Adoption flips
    // failed -> succeeded and re-applies the decrement.
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getPaymentById as ReturnType<typeof vi.fn>).mockResolvedValue(
      paymentRow({ id: 'pay_r', kind: 'refund', amountCents: 1000, stripeRefundId: null, status: 'failed' }),
    );
    (reservationRepo.setPaymentStatusIf as ReturnType<typeof vi.fn>).mockImplementation(
      async (_tx: unknown, _id: string, expected: string) => expected === 'failed',
    );
    const { service } = buildService({ reservationRepo });

    const outcome = await service.recordExternalRefund({
      stripeRefundId: 're_123',
      stripePaymentIntentId: 'pi_1',
      amountCents: 1000,
      status: 'succeeded',
      refundKey: 'pay_r',
    });

    expect(outcome).toBe('known');
    expect(reservationRepo.adjustAmountPaid).toHaveBeenCalledWith(expect.anything(), 'rsv_1', -1000);
    expect(reservationRepo.addPayment).not.toHaveBeenCalled();
  });

  it('falls through to the external path when refundKey resolves to nothing of ours', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.findReservationIdByPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValue('rsv_1');
    const { service } = buildService({ reservationRepo });

    const outcome = await service.recordExternalRefund({
      stripeRefundId: 're_dash',
      stripePaymentIntentId: 'pi_1',
      amountCents: 500,
      status: 'succeeded',
      refundKey: 'pay_ghost',
    });

    expect(outcome).toBe('recorded');
    expect(reservationRepo.addPayment).toHaveBeenCalled();
  });
});

describe('ReservationService reserved-refund batches and re-drive', () => {
  it('attempts EVERY allocation of a multi-PI refund even when an earlier one fails at Stripe', async () => {
    // Base $20 on pi_1 + applied grow delta $10 on pi_2; cancel >24h out
    // refunds 100% across both intents, newest first. The pi_2 refund
    // failing must not abandon the pi_1 allocation as a stranded pending
    // row: it is attempted, completed, and the error rethrown afterwards.
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({
        status: 'confirmed',
        amountPaidCents: 3000,
        payments: [paymentRow(), deltaChargeRow({ status: 'succeeded', purpose: 'change_delta' })],
      }),
    );
    (reservationRepo.addPayment as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(paymentRow({ id: 'ref_a', kind: 'refund', amountCents: 1000, stripePaymentIntentId: 'pi_2', status: 'pending' }))
      .mockResolvedValueOnce(paymentRow({ id: 'ref_b', kind: 'refund', amountCents: 2000, stripePaymentIntentId: 'pi_1', status: 'pending' }));
    const paymentPort = mockPaymentPort();
    (paymentPort.refund as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('stripe transient'))
      .mockResolvedValue({ refundId: 're_ok' });
    const { service, reservationRepo: repo } = buildService({ reservationRepo, paymentPort });

    await expect(service.cancel('rsv_1', { memberId: 'mem_1', now: NOW })).rejects.toThrow('stripe transient');

    // Both allocations went to Stripe (newest intent first)...
    expect(paymentPort.refund).toHaveBeenCalledTimes(2);
    expect(paymentPort.refund).toHaveBeenNthCalledWith(1, expect.objectContaining({ paymentIntentId: 'pi_2', amountCents: 1000, refundKey: 'ref_a' }));
    expect(paymentPort.refund).toHaveBeenNthCalledWith(2, expect.objectContaining({ paymentIntentId: 'pi_1', amountCents: 2000, refundKey: 'ref_b' }));
    // ...the failed one was terminalized with its balance restored...
    expect(repo.setPaymentStatusIf).toHaveBeenCalledWith(expect.anything(), 'ref_a', 'pending', 'failed');
    expect(repo.adjustAmountPaid).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 1000);
    // ...and the healthy one completed normally.
    expect(repo.completeRefund).toHaveBeenCalledWith(expect.anything(), 'ref_b', 're_ok');
  });

  it('re-drives reserved refunds that never reached Stripe under their per-row idempotency key', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.listStalePendingRefunds as ReturnType<typeof vi.fn>).mockResolvedValue([
      paymentRow({ id: 'pay_r', kind: 'refund', amountCents: 1500, stripePaymentIntentId: 'pi_1', stripeRefundId: null, status: 'pending' }),
    ]);
    const { service, paymentPort } = buildService({ reservationRepo });

    const result = await service.redriveStalePendingRefunds(NOW);

    expect(reservationRepo.listStalePendingRefunds).toHaveBeenCalledWith(new Date(NOW.getTime() - 60 * 60_000));
    expect(paymentPort.refund).toHaveBeenCalledWith({
      paymentIntentId: 'pi_1',
      amountCents: 1500,
      reservationId: 'rsv_1',
      refundKey: 'pay_r',
    });
    expect(reservationRepo.completeRefund).toHaveBeenCalledWith(expect.anything(), 'pay_r', 're_1');
    expect(result).toEqual({ reissued: 1, failed: 0 });
  });

  it('a re-drive failure terminalizes that row (restore + staff-alert seam) without aborting the pass', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.listStalePendingRefunds as ReturnType<typeof vi.fn>).mockResolvedValue([
      paymentRow({ id: 'pay_a', kind: 'refund', amountCents: 500, stripePaymentIntentId: 'pi_1', stripeRefundId: null, status: 'pending' }),
      paymentRow({ id: 'pay_b', kind: 'refund', amountCents: 700, reservationId: 'rsv_2', stripePaymentIntentId: 'pi_9', stripeRefundId: null, status: 'pending' }),
    ]);
    const paymentPort = mockPaymentPort();
    (paymentPort.refund as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValue({ refundId: 're_2' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { service } = buildService({ reservationRepo, paymentPort });

    const result = await service.redriveStalePendingRefunds(NOW);

    expect(result).toEqual({ reissued: 1, failed: 1 });
    expect(reservationRepo.setPaymentStatusIf).toHaveBeenCalledWith(expect.anything(), 'pay_a', 'pending', 'failed');
    expect(reservationRepo.adjustAmountPaid).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 500);
    expect(reservationRepo.completeRefund).toHaveBeenCalledWith(expect.anything(), 'pay_b', 're_2');
    errorSpy.mockRestore();
  });
});

describe('ReservationService dispute freeze', () => {
  it('stamps the disputed charge and audits the freeze', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.markChargeDisputed as ReturnType<typeof vi.fn>).mockResolvedValue(['rsv_1']);
    const { service, audit } = buildService({ reservationRepo });

    expect(await service.freezeChargeForDispute('pi_1')).toEqual(['rsv_1']);
    expect(reservationRepo.markChargeDisputed).toHaveBeenCalledWith('pi_1', expect.any(Date));
    expect(auditEventTypes(audit)).toContain('reservation.dispute_opened');
  });

  it('cancelling a DISPUTED reservation succeeds with the refund withheld, never a 500', async () => {
    const reservationRepo = mockReservationRepo();
    const disputed = detailFixture({
      status: 'confirmed',
      amountPaidCents: 2000,
      payments: [paymentRow({ disputedAt: NOW })],
    });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(disputed);
    const { service, paymentPort, audit } = buildService({ reservationRepo });

    const result = await service.cancel('rsv_1', { memberId: 'mem_1', now: NOW });

    expect(result.refundCents).toBe(0); // policy said 100%, dispute froze it
    expect(paymentPort.refund).not.toHaveBeenCalled();
    const cancelledEvent = (audit.append as ReturnType<typeof vi.fn>).mock.calls
      .map(([, event]) => event)
      .find((event) => event.eventType === 'reservation.cancelled');
    expect(cancelledEvent.data).toMatchObject({ refundCents: 0, withheldDisputedCents: 2000 });
  });

  it('persists the cancellation refund percent for the TOCTOU repair path', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed', amountPaidCents: 2000, payments: [paymentRow()] }),
    );
    const { service } = buildService({ reservationRepo });

    await service.cancel('rsv_1', { memberId: 'mem_1', now: NOW });
    expect(reservationRepo.setCancelRefundPercent).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 100);
  });

  it('blocks account closure while a refund is pending or a dispute is open', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.countBlockingFinancialState as ReturnType<typeof vi.fn>).mockResolvedValue({
      pendingRefunds: 1,
      disputedCharges: 0,
    });
    const { service } = buildService({ reservationRepo });
    expect(await service.hasBlockingFinancialState('mem_1')).toBe(true);
  });
});

describe('account-deletion seams', () => {
  const NOW = new Date('2026-09-01T12:00:00Z');

  function upcomingRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rsv_1',
      organizerId: 'mem_1',
      status: 'confirmed',
      startsAt: new Date('2026-09-02T18:00:00Z'),
      endsAt: new Date('2026-09-02T19:00:00Z'),
      participants: [
        { id: 'rp_1', memberId: 'mem_1', role: 'organizer', status: 'confirmed' },
      ],
      ...overrides,
    };
  }

  describe('cancelFutureReservationsForMember', () => {
    it('cancels only FUTURE reservations the member organizes, at policy refund', async () => {
      const reservationRepo = mockReservationRepo();
      (reservationRepo.listForMember as ReturnType<typeof vi.fn>).mockResolvedValue([
        upcomingRow(), // future, organizer -> cancelled
        upcomingRow({ id: 'rsv_guest', organizerId: 'mem_other' }), // guest -> skipped
        upcomingRow({
          id: 'rsv_running',
          startsAt: new Date('2026-09-01T11:00:00Z'), // already under way -> left alone
        }),
      ]);
      const { service } = buildService({ reservationRepo });
      const cancel = vi
        .spyOn(service, 'cancel')
        .mockResolvedValue({ refundCents: 1500 });

      const result = await service.cancelFutureReservationsForMember('mem_1', 'mem_1', NOW);

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith('rsv_1', { memberId: 'mem_1', actorId: 'mem_1', now: NOW });
      expect(result).toEqual({ cancelled: 1, refundCents: 1500 });
    });

    it('treats already-cancelled/raced rows as done (resumable re-run)', async () => {
      const reservationRepo = mockReservationRepo();
      (reservationRepo.listForMember as ReturnType<typeof vi.fn>).mockResolvedValue([
        upcomingRow(),
        upcomingRow({ id: 'rsv_2' }),
      ]);
      const { service } = buildService({ reservationRepo });
      vi.spyOn(service, 'cancel')
        .mockRejectedValueOnce(new InvalidReservationStatusError('cancelled', 'pending_payment or confirmed'))
        .mockResolvedValueOnce({ refundCents: 0 });

      const result = await service.cancelFutureReservationsForMember('mem_1', 'mem_1', NOW);
      expect(result).toEqual({ cancelled: 1, refundCents: 0 });
    });

    it('propagates a real failure (Stripe down) so the pipeline can retry', async () => {
      const reservationRepo = mockReservationRepo();
      (reservationRepo.listForMember as ReturnType<typeof vi.fn>).mockResolvedValue([upcomingRow()]);
      const { service } = buildService({ reservationRepo });
      vi.spyOn(service, 'cancel').mockRejectedValue(new Error('stripe unavailable'));

      await expect(service.cancelFutureReservationsForMember('mem_1', 'mem_1', NOW)).rejects.toThrow(
        'stripe unavailable',
      );
    });
  });

  describe('releaseParticipationsForMember', () => {
    it('declines pending and withdraws confirmed guest participations', async () => {
      const reservationRepo = mockReservationRepo();
      (reservationRepo.listForMember as ReturnType<typeof vi.fn>).mockResolvedValue([
        upcomingRow({
          id: 'rsv_g1',
          organizerId: 'mem_other',
          participants: [{ id: 'rp_2', memberId: 'mem_1', role: 'guest', status: 'pending' }],
        }),
        upcomingRow({
          id: 'rsv_g2',
          organizerId: 'mem_other',
          participants: [{ id: 'rp_3', memberId: 'mem_1', role: 'guest', status: 'confirmed' }],
        }),
        upcomingRow({ id: 'rsv_own' }), // organizer row: not a participation to release
        upcomingRow({
          id: 'rsv_declined',
          organizerId: 'mem_other',
          participants: [{ id: 'rp_4', memberId: 'mem_1', role: 'guest', status: 'declined' }],
        }),
      ]);
      const { service } = buildService({ reservationRepo });
      const respond = vi.spyOn(service, 'respond').mockResolvedValue({ status: 'declined' });

      const result = await service.releaseParticipationsForMember('mem_1', 'mem_1', NOW);

      expect(respond).toHaveBeenCalledTimes(2);
      expect(respond).toHaveBeenCalledWith('rsv_g1', 'mem_1', 'decline', 'mem_1');
      expect(respond).toHaveBeenCalledWith('rsv_g2', 'mem_1', 'decline', 'mem_1');
      expect(result).toEqual({ released: 2 });
    });

    it('tolerates a reservation resolving between list and respond', async () => {
      const reservationRepo = mockReservationRepo();
      (reservationRepo.listForMember as ReturnType<typeof vi.fn>).mockResolvedValue([
        upcomingRow({
          id: 'rsv_g1',
          organizerId: 'mem_other',
          participants: [{ id: 'rp_2', memberId: 'mem_1', role: 'guest', status: 'pending' }],
        }),
      ]);
      const { service } = buildService({ reservationRepo });
      vi.spyOn(service, 'respond').mockRejectedValue(new ReservationNotFoundError('rsv_g1'));

      expect(await service.releaseParticipationsForMember('mem_1', 'mem_1', NOW)).toEqual({ released: 0 });
    });
  });

  describe('getLifetimeActivityStats', () => {
    it('aggregates repo rows through the court-family definition', async () => {
      const reservationRepo = mockReservationRepo();
      (reservationRepo as any).aggregateLifetimeStatsForMember = vi.fn().mockResolvedValue([
        { typeCode: 'badminton_court', count: 4, minutes: 240 },
        { typeCode: 'tennis_simulator', count: 2, minutes: 120 },
      ]);
      const { service } = buildService({ reservationRepo });

      expect(await service.getLifetimeActivityStats('mem_1')).toEqual({
        courtsBooked: 4,
        badmintonMinutes: 240,
        tennisMinutes: 0,
      });
    });
  });
});
