import { ReservationService } from './reservation.service';
import type { AuditLog } from './ports';
import { wallTimeToUtc } from '@/lib/kernel';
import {
  HoldExpiredError,
  InvalidReservationStatusError,
  MaxReservationsExceededError,
  NotInvitePermittedError,
  CannotRemoveOrganizerError,
  PaymentNotCompletedError,
  ReservationAlreadyStartedError,
  ReservationInPastError,
  ReservationNotFoundError,
  ReservationTooFarInAdvanceError,
  SlotUnavailableError,
  TierRequiredError,
  type BookingPaymentPort,
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
    amountCents: 2000,
    stripePaymentIntentId: 'pi_1',
    stripeRefundId: null,
    status: 'succeeded' as const,
    createdAt: NOW,
    ...overrides,
  };
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
    countActiveOnDate: vi.fn().mockResolvedValue(0),
    forceReleaseExpiredHolds: vi.fn().mockResolvedValue([]),
    createWithClaim: vi.fn(),
    moveClaimAndReservation: vi.fn(),
    updateStatus: vi.fn(),
    confirmReservation: vi.fn(),
    releaseClaim: vi.fn(),
    adjustAmountPaid: vi.fn(),
    addPayment: vi.fn().mockResolvedValue(paymentRow()),
    setPaymentStatus: vi.fn(),
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
  );
  return { service, typeRepo, resourceRepo, claimRepo, reservationRepo, checker, paymentPort, audit, uow };
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

  it('releases the hold when the payment intent cannot be created', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const detail = detailFixture();
    (reservationRepo.createWithClaim as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    (paymentPort.createPaymentIntent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('stripe down'));
    const { service } = buildService({ reservationRepo, paymentPort });

    await expect(service.create(CREATE_REQUEST)).rejects.toThrow('stripe down');
    expect(reservationRepo.releaseClaim).toHaveBeenCalledWith(expect.anything(), 'rsv_1');
    expect(reservationRepo.updateStatus).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 'expired');
  });
});

describe('ReservationService.confirm', () => {
  it('asserts payment success through the port and flips to confirmed', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const detail = detailFixture({ payments: [paymentRow({ status: 'pending' })] });
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    const { service } = buildService({ reservationRepo, paymentPort });

    await service.confirm('rsv_1', { memberId: 'mem_1' });

    expect(paymentPort.getPaymentStatus).toHaveBeenCalledWith('pi_1');
    expect(reservationRepo.confirmReservation).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 2000);
    expect(reservationRepo.setPaymentStatus).toHaveBeenCalledWith(expect.anything(), 'pay_1', 'succeeded');
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
    expect(reservationRepo.confirmReservation).not.toHaveBeenCalled();
  });

  it('reports an expired hold', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detailFixture({ status: 'expired' }));
    const { service } = buildService({ reservationRepo });

    await expect(service.confirm('rsv_1', { memberId: 'mem_1' })).rejects.toThrow(HoldExpiredError);
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

    const result = await service.addParticipants('rsv_1', 'mem_2', ['mem_3']);

    expect(result.invited).toEqual(['mem_3']);
    expect(reservationRepo.upsertPendingInvite).toHaveBeenCalledWith(expect.anything(), {
      reservationId: 'rsv_1',
      memberId: 'mem_3',
      invitedById: 'mem_2',
    });
  });

  it('denies pending guests', async () => {
    const reservationRepo = mockReservationRepo();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ status: 'confirmed', participants: [detailFixture().participants[0], guest('mem_2', 'pending')] }),
    );
    const { service } = buildService({ reservationRepo });

    await expect(service.addParticipants('rsv_1', 'mem_2', ['mem_3'])).rejects.toThrow(NotInvitePermittedError);
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

    const result = await service.addParticipants('rsv_1', 'mem_1', ['mem_1', 'mem_2', 'mem_3', 'mem_4']);

    expect(result.invited).toEqual(['mem_3', 'mem_4']);
    expect(reservationRepo.upsertPendingInvite).toHaveBeenCalledTimes(2);
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

  it('moves the claim, resets confirmed guests and refunds a shrink delta', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    const detail = confirmedDetail();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    (reservationRepo.resetConfirmedGuestsToPending as ReturnType<typeof vi.fn>).mockResolvedValue(['mem_2']);
    const { service } = buildService({ reservationRepo, paymentPort });

    // Shrink from 60 to 30 minutes: delta -1000 at the snapshot rate.
    const result = await service.reschedule('rsv_1', 'mem_1', { date: DATE, slots: ['19:00'] }, undefined, NOW);

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
    expect(paymentPort.refund).toHaveBeenCalledWith({ paymentIntentId: 'pi_1', amountCents: 1000, reservationId: 'rsv_1' });
    expect(reservationRepo.adjustAmountPaid).toHaveBeenCalledWith(expect.anything(), 'rsv_1', -1000);
  });

  it('charges a grow delta through a new payment intent', async () => {
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
    expect(paymentPort.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 1000, reservationId: 'rsv_1' }),
    );
    expect(result.clientSecret).toBe('pi_1_secret');
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
      { excludeReservationId: 'rsv_1' },
    );
  });
});

describe('ReservationService.cancel', () => {
  it('applies the 50% tier between 2h and 24h', async () => {
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
    expect(reservationRepo.releaseClaim).toHaveBeenCalled();
    expect(reservationRepo.updateStatus).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 'cancelled');
    expect(paymentPort.refund).toHaveBeenCalledWith({ paymentIntentId: 'pi_1', amountCents: 1000, reservationId: 'rsv_1' });
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

  it('cancels a pending_payment hold without a refund and voids the intent', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(
      detailFixture({ payments: [paymentRow({ status: 'pending' })] }),
    );
    const { service } = buildService({ reservationRepo, paymentPort });

    const { refundCents } = await service.cancel('rsv_1', { memberId: 'mem_1', now: NOW });

    expect(refundCents).toBe(0);
    expect(paymentPort.cancelPaymentIntent).toHaveBeenCalledWith('pi_1');
    expect(paymentPort.refund).not.toHaveBeenCalled();
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

    expect(result).toEqual({ expired: 0, confirmed: 1 });
    expect(reservationRepo.confirmReservation).toHaveBeenCalled();
    expect(reservationRepo.releaseClaim).not.toHaveBeenCalled();
  });

  it('expires a hold whose payment did not succeed', async () => {
    const reservationRepo = mockReservationRepo();
    const paymentPort = mockPaymentPort();
    (paymentPort.getPaymentStatus as ReturnType<typeof vi.fn>).mockResolvedValue('requires_payment');
    const hold = detailFixture({ payments: [paymentRow({ status: 'pending' })] });
    (reservationRepo.listExpiredHolds as ReturnType<typeof vi.fn>).mockResolvedValue([hold]);
    (reservationRepo.getDetail as ReturnType<typeof vi.fn>).mockResolvedValue(hold);
    const { service } = buildService({ reservationRepo, paymentPort });

    const result = await service.expireStaleHolds(NOW);

    expect(result).toEqual({ expired: 1, confirmed: 0 });
    expect(reservationRepo.releaseClaim).toHaveBeenCalled();
    expect(reservationRepo.updateStatus).toHaveBeenCalledWith(expect.anything(), 'rsv_1', 'expired');
    expect(paymentPort.cancelPaymentIntent).toHaveBeenCalledWith('pi_1');
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

  it('locks PRO types for member-tier viewers', async () => {
    const { service } = buildService({ checker: mockChecker('member') });
    await expect(
      service.getAvailability({ typeCode: 'shower', startDate: DATE, memberId: 'mem_1', now: NOW }),
    ).rejects.toThrow(TierRequiredError);
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
