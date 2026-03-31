import { BookingService } from './booking.service';
import {
  FacilityNotFoundError,
  BookingNotFoundError,
  MaxBookingsExceededError,
  BookingInPastError,
  BookingTooFarInAdvanceError,
  InactiveMembershipError,
  CancellationDeadlinePassedError,
  type Booking,
  type Court,
  type Shower,
  type MembershipChecker,
} from '../domain';
import type { CourtRepository, CreateCourtInput, UpdateCourtInput } from '../infrastructure/court.repository';
import type { ShowerRepository, CreateShowerInput, UpdateShowerInput } from '../infrastructure/shower.repository';
import type { BookingRepository } from '../infrastructure/booking.repository';
import type { UnitOfWork } from '@/lib/kernel/unit-of-work';

// ── Mock factories ──

function mockCourtRepo(): CourtRepository {
  return {
    listAll: vi.fn(),
    listActive: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  } as unknown as CourtRepository;
}

function mockShowerRepo(): ShowerRepository {
  return {
    listAll: vi.fn(),
    listActive: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  } as unknown as ShowerRepository;
}

function mockBookingRepo(): BookingRepository {
  return {
    getById: vi.fn(),
    getConfirmedForFacility: vi.fn().mockResolvedValue([]),
    countMemberBookings: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    getUpcomingForFacility: vi.fn().mockResolvedValue([]),
    listAll: vi.fn(),
    getUpcomingForMember: vi.fn(),
    countUpcomingForFacility: vi.fn(),
    cancel: vi.fn(),
  } as unknown as BookingRepository;
}

function mockMembershipChecker(): MembershipChecker {
  return {
    hasActiveMembership: vi.fn().mockResolvedValue(true),
  };
}

function mockUow(): UnitOfWork {
  return {
    execute: vi.fn(async (fn: any) => fn({})),
  } as unknown as UnitOfWork;
}

// ── Fixtures ──

const NOW = new Date();
const TODAY = new Date(NOW);
TODAY.setHours(0, 0, 0, 0);

const TOMORROW = new Date(TODAY);
TOMORROW.setDate(TOMORROW.getDate() + 1);
const TOMORROW_STR = TOMORROW.toISOString().split('T')[0];

const COURT: Court = {
  id: 'court_1',
  name: 'Court A',
  slotDurationMinutes: 60,
  operatingHoursStart: '08:00',
  operatingHoursEnd: '22:00',
  maxAdvanceDays: 7,
  maxBookingsPerMemberPerDay: 2,
  cancellationDeadlineMinutes: 60,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const SHOWER: Shower = {
  id: 'shower_1',
  name: 'Shower A',
  slotDurationMinutes: 30,
  operatingHoursStart: '08:00',
  operatingHoursEnd: '22:00',
  maxAdvanceDays: 3,
  maxBookingsPerMemberPerDay: 1,
  cancellationDeadlineMinutes: 30,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MEMBER_ID = 'mbr_1';

function makeBooking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'bk_1',
    facilityType: 'court',
    facilityId: 'court_1',
    memberId: MEMBER_ID,
    date: TOMORROW,
    startTime: '10:00',
    endTime: '11:00',
    status: 'confirmed',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildService(overrides: {
  courtRepo?: CourtRepository;
  showerRepo?: ShowerRepository;
  bookingRepo?: BookingRepository;
  membershipChecker?: MembershipChecker;
  uow?: UnitOfWork;
} = {}) {
  const courtRepo = overrides.courtRepo ?? mockCourtRepo();
  const showerRepo = overrides.showerRepo ?? mockShowerRepo();
  const bookingRepo = overrides.bookingRepo ?? mockBookingRepo();
  const membershipChecker = overrides.membershipChecker ?? mockMembershipChecker();
  const uow = overrides.uow ?? mockUow();
  return { service: new BookingService(courtRepo, showerRepo, bookingRepo, membershipChecker, uow), courtRepo, showerRepo, bookingRepo, membershipChecker, uow };
}

// ── Tests ──

describe('BookingService', () => {
  // ── bookCourt ──

  describe('bookCourt', () => {
    it('creates a court booking for a valid request', async () => {
      const courtRepo = mockCourtRepo();
      const bookingRepo = mockBookingRepo();
      (courtRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(COURT);
      const created = makeBooking();
      (bookingRepo.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

      const { service } = buildService({ courtRepo, bookingRepo });
      const result = await service.bookCourt('court_1', TOMORROW_STR, '10:00', MEMBER_ID);

      expect(result).toBe(created);
      expect(bookingRepo.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          facilityType: 'court',
          facilityId: 'court_1',
          memberId: MEMBER_ID,
          startTime: '10:00',
          endTime: '11:00',
        }),
      );
    });

    it('throws FacilityNotFoundError when court does not exist', async () => {
      const courtRepo = mockCourtRepo();
      (courtRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const { service } = buildService({ courtRepo });
      await expect(service.bookCourt('missing', TOMORROW_STR, '10:00', MEMBER_ID)).rejects.toThrow(FacilityNotFoundError);
    });

    it('throws FacilityNotFoundError when court is inactive', async () => {
      const courtRepo = mockCourtRepo();
      (courtRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ ...COURT, active: false });

      const { service } = buildService({ courtRepo });
      await expect(service.bookCourt('court_1', TOMORROW_STR, '10:00', MEMBER_ID)).rejects.toThrow(FacilityNotFoundError);
    });

    it('throws BookingInPastError for a past date', async () => {
      const courtRepo = mockCourtRepo();
      (courtRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(COURT);

      const { service } = buildService({ courtRepo });
      await expect(service.bookCourt('court_1', '2020-01-01', '10:00', MEMBER_ID)).rejects.toThrow(BookingInPastError);
    });

    it('throws BookingTooFarInAdvanceError when date exceeds maxAdvanceDays', async () => {
      const courtRepo = mockCourtRepo();
      (courtRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(COURT);

      const farDate = new Date(TODAY);
      farDate.setDate(farDate.getDate() + COURT.maxAdvanceDays + 1);
      const farDateStr = farDate.toISOString().split('T')[0];

      const { service } = buildService({ courtRepo });
      await expect(service.bookCourt('court_1', farDateStr, '10:00', MEMBER_ID)).rejects.toThrow(BookingTooFarInAdvanceError);
    });

    it('throws InactiveMembershipError when member has no active membership', async () => {
      const courtRepo = mockCourtRepo();
      const membershipChecker = mockMembershipChecker();
      (courtRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(COURT);
      (membershipChecker.hasActiveMembership as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { service } = buildService({ courtRepo, membershipChecker });
      await expect(service.bookCourt('court_1', TOMORROW_STR, '10:00', MEMBER_ID)).rejects.toThrow(InactiveMembershipError);
    });

    it('throws MaxBookingsExceededError when member exceeds daily limit', async () => {
      const courtRepo = mockCourtRepo();
      const bookingRepo = mockBookingRepo();
      (courtRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(COURT);
      (bookingRepo.countMemberBookings as ReturnType<typeof vi.fn>).mockResolvedValue(COURT.maxBookingsPerMemberPerDay);

      const { service } = buildService({ courtRepo, bookingRepo });
      await expect(service.bookCourt('court_1', TOMORROW_STR, '10:00', MEMBER_ID)).rejects.toThrow(MaxBookingsExceededError);
    });
  });

  // ── bookShower ──

  describe('bookShower', () => {
    it('creates a shower booking for a valid request', async () => {
      const showerRepo = mockShowerRepo();
      const bookingRepo = mockBookingRepo();
      (showerRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(SHOWER);
      const created = makeBooking({ facilityType: 'shower', facilityId: 'shower_1', startTime: '10:00', endTime: '10:30' });
      (bookingRepo.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

      const { service } = buildService({ showerRepo, bookingRepo });
      const result = await service.bookShower('shower_1', TOMORROW_STR, '10:00', MEMBER_ID);

      expect(result).toBe(created);
      expect(bookingRepo.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          facilityType: 'shower',
          facilityId: 'shower_1',
          memberId: MEMBER_ID,
          startTime: '10:00',
          endTime: '10:30',
        }),
      );
    });

    it('throws FacilityNotFoundError when shower does not exist', async () => {
      const showerRepo = mockShowerRepo();
      (showerRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const { service } = buildService({ showerRepo });
      await expect(service.bookShower('missing', TOMORROW_STR, '10:00', MEMBER_ID)).rejects.toThrow(FacilityNotFoundError);
    });

    it('throws FacilityNotFoundError when shower is inactive', async () => {
      const showerRepo = mockShowerRepo();
      (showerRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ ...SHOWER, active: false });

      const { service } = buildService({ showerRepo });
      await expect(service.bookShower('shower_1', TOMORROW_STR, '10:00', MEMBER_ID)).rejects.toThrow(FacilityNotFoundError);
    });

    it('throws InactiveMembershipError when member has no active membership', async () => {
      const showerRepo = mockShowerRepo();
      const membershipChecker = mockMembershipChecker();
      (showerRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(SHOWER);
      (membershipChecker.hasActiveMembership as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      const { service } = buildService({ showerRepo, membershipChecker });
      await expect(service.bookShower('shower_1', TOMORROW_STR, '10:00', MEMBER_ID)).rejects.toThrow(InactiveMembershipError);
    });

    it('throws MaxBookingsExceededError when member exceeds daily limit', async () => {
      const showerRepo = mockShowerRepo();
      const bookingRepo = mockBookingRepo();
      (showerRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(SHOWER);
      (bookingRepo.countMemberBookings as ReturnType<typeof vi.fn>).mockResolvedValue(SHOWER.maxBookingsPerMemberPerDay);

      const { service } = buildService({ showerRepo, bookingRepo });
      await expect(service.bookShower('shower_1', TOMORROW_STR, '10:00', MEMBER_ID)).rejects.toThrow(MaxBookingsExceededError);
    });
  });

  // ── cancel ──

  describe('cancel', () => {
    it('cancels a booking owned by the member', async () => {
      const bookingRepo = mockBookingRepo();
      const courtRepo = mockCourtRepo();
      // Booking far in the future so cancellation deadline hasn't passed
      const futureDate = new Date(TODAY);
      futureDate.setDate(futureDate.getDate() + 5);
      const booking = makeBooking({ date: futureDate, startTime: '18:00', endTime: '19:00' });
      (bookingRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(booking);
      (courtRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(COURT);

      const { service } = buildService({ bookingRepo, courtRepo });
      await service.cancel('bk_1', MEMBER_ID);

      expect(bookingRepo.cancel).toHaveBeenCalledWith('bk_1');
    });

    it('throws BookingNotFoundError when booking does not exist', async () => {
      const bookingRepo = mockBookingRepo();
      (bookingRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const { service } = buildService({ bookingRepo });
      await expect(service.cancel('missing', MEMBER_ID)).rejects.toThrow(BookingNotFoundError);
    });

    it('throws BookingNotFoundError when member does not own the booking', async () => {
      const bookingRepo = mockBookingRepo();
      (bookingRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(makeBooking({ memberId: 'other_member' }));

      const { service } = buildService({ bookingRepo });
      await expect(service.cancel('bk_1', MEMBER_ID)).rejects.toThrow(BookingNotFoundError);
    });

    it('throws BookingNotFoundError when booking is already cancelled', async () => {
      const bookingRepo = mockBookingRepo();
      (bookingRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(makeBooking({ status: 'cancelled' }));

      const { service } = buildService({ bookingRepo });
      await expect(service.cancel('bk_1', MEMBER_ID)).rejects.toThrow(BookingNotFoundError);
    });

    it('throws CancellationDeadlinePassedError when past the deadline', async () => {
      const bookingRepo = mockBookingRepo();
      const courtRepo = mockCourtRepo();
      // Booking starting right now - deadline is 60 min before, so it's passed
      const booking = makeBooking({
        date: TODAY,
        startTime: `${String(NOW.getHours()).padStart(2, '0')}:${String(NOW.getMinutes()).padStart(2, '0')}`,
      });
      (bookingRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(booking);
      (courtRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(COURT);

      const { service } = buildService({ bookingRepo, courtRepo });
      await expect(service.cancel('bk_1', MEMBER_ID)).rejects.toThrow(CancellationDeadlinePassedError);
    });
  });

  // ── adminCancel ──

  describe('adminCancel', () => {
    it('cancels any confirmed booking without ownership check', async () => {
      const bookingRepo = mockBookingRepo();
      (bookingRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(makeBooking());

      const { service } = buildService({ bookingRepo });
      await service.adminCancel('bk_1');

      expect(bookingRepo.cancel).toHaveBeenCalledWith('bk_1');
    });

    it('throws BookingNotFoundError when booking does not exist', async () => {
      const bookingRepo = mockBookingRepo();
      (bookingRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const { service } = buildService({ bookingRepo });
      await expect(service.adminCancel('missing')).rejects.toThrow(BookingNotFoundError);
    });

    it('throws BookingNotFoundError when booking is already cancelled', async () => {
      const bookingRepo = mockBookingRepo();
      (bookingRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(makeBooking({ status: 'cancelled' }));

      const { service } = buildService({ bookingRepo });
      await expect(service.adminCancel('bk_1')).rejects.toThrow(BookingNotFoundError);
    });
  });

  // ── getCourtAvailability ──

  describe('getCourtAvailability', () => {
    it('returns available slots excluding existing bookings', async () => {
      const courtRepo = mockCourtRepo();
      const bookingRepo = mockBookingRepo();
      (courtRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(COURT);
      (bookingRepo.getUpcomingForFacility as ReturnType<typeof vi.fn>).mockResolvedValue([
        { startTime: '10:00', endTime: '11:00' },
      ]);

      const { service } = buildService({ courtRepo, bookingRepo });
      const slots = await service.getCourtAvailability('court_1', TOMORROW_STR);

      expect(slots.length).toBeGreaterThan(0);
      expect(slots.find((s) => s.startTime === '10:00')).toBeUndefined();
      expect(slots.find((s) => s.startTime === '08:00')).toBeDefined();
    });

    it('throws FacilityNotFoundError when court does not exist', async () => {
      const courtRepo = mockCourtRepo();
      (courtRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const { service } = buildService({ courtRepo });
      await expect(service.getCourtAvailability('missing', TOMORROW_STR)).rejects.toThrow(FacilityNotFoundError);
    });

    it('throws FacilityNotFoundError when court is inactive', async () => {
      const courtRepo = mockCourtRepo();
      (courtRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ ...COURT, active: false });

      const { service } = buildService({ courtRepo });
      await expect(service.getCourtAvailability('court_1', TOMORROW_STR)).rejects.toThrow(FacilityNotFoundError);
    });
  });

  // ── getShowerAvailability ──

  describe('getShowerAvailability', () => {
    it('returns available slots excluding existing bookings', async () => {
      const showerRepo = mockShowerRepo();
      const bookingRepo = mockBookingRepo();
      (showerRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(SHOWER);
      (bookingRepo.getUpcomingForFacility as ReturnType<typeof vi.fn>).mockResolvedValue([
        { startTime: '08:00', endTime: '08:30' },
      ]);

      const { service } = buildService({ showerRepo, bookingRepo });
      const slots = await service.getShowerAvailability('shower_1', TOMORROW_STR);

      expect(slots.length).toBeGreaterThan(0);
      expect(slots.find((s) => s.startTime === '08:00')).toBeUndefined();
      expect(slots.find((s) => s.startTime === '08:30')).toBeDefined();
    });

    it('throws FacilityNotFoundError when shower does not exist', async () => {
      const showerRepo = mockShowerRepo();
      (showerRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const { service } = buildService({ showerRepo });
      await expect(service.getShowerAvailability('missing', TOMORROW_STR)).rejects.toThrow(FacilityNotFoundError);
    });
  });

  // ── listBookings ──

  describe('listBookings', () => {
    it('delegates to bookingRepo.listAll with no date', async () => {
      const bookingRepo = mockBookingRepo();
      const bookings = [makeBooking()];
      (bookingRepo.listAll as ReturnType<typeof vi.fn>).mockResolvedValue(bookings);

      const { service } = buildService({ bookingRepo });
      const result = await service.listBookings();

      expect(bookingRepo.listAll).toHaveBeenCalledWith(undefined);
      expect(result).toBe(bookings);
    });

    it('passes parsed date when provided', async () => {
      const bookingRepo = mockBookingRepo();
      (bookingRepo.listAll as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const { service } = buildService({ bookingRepo });
      await service.listBookings(TOMORROW_STR);

      expect(bookingRepo.listAll).toHaveBeenCalledWith(expect.any(Date));
    });
  });

  // ── getMyBookings ──

  describe('getMyBookings', () => {
    it('delegates to bookingRepo.getUpcomingForMember', async () => {
      const bookingRepo = mockBookingRepo();
      const bookings = [makeBooking()];
      (bookingRepo.getUpcomingForMember as ReturnType<typeof vi.fn>).mockResolvedValue(bookings);

      const { service } = buildService({ bookingRepo });
      const result = await service.getMyBookings(MEMBER_ID);

      expect(bookingRepo.getUpcomingForMember).toHaveBeenCalledWith(MEMBER_ID);
      expect(result).toBe(bookings);
    });
  });

  // ── Court management ──

  describe('listCourts', () => {
    it('delegates to courtRepo.listActive', async () => {
      const courtRepo = mockCourtRepo();
      const courts = [COURT];
      (courtRepo.listActive as ReturnType<typeof vi.fn>).mockResolvedValue(courts);

      const { service } = buildService({ courtRepo });
      const result = await service.listCourts();

      expect(courtRepo.listActive).toHaveBeenCalled();
      expect(result).toBe(courts);
    });
  });

  describe('listAllCourts', () => {
    it('delegates to courtRepo.listAll', async () => {
      const courtRepo = mockCourtRepo();
      (courtRepo.listAll as ReturnType<typeof vi.fn>).mockResolvedValue([COURT]);

      const { service } = buildService({ courtRepo });
      await service.listAllCourts();

      expect(courtRepo.listAll).toHaveBeenCalled();
    });
  });

  describe('createCourt', () => {
    it('delegates to courtRepo.create', async () => {
      const courtRepo = mockCourtRepo();
      const input: CreateCourtInput = { name: 'Court B' };
      (courtRepo.create as ReturnType<typeof vi.fn>).mockResolvedValue({ ...COURT, ...input });

      const { service } = buildService({ courtRepo });
      const result = await service.createCourt(input);

      expect(courtRepo.create).toHaveBeenCalledWith(input);
      expect(result.name).toBe('Court B');
    });
  });

  describe('updateCourt', () => {
    it('updates court when it exists', async () => {
      const courtRepo = mockCourtRepo();
      const data: UpdateCourtInput = { name: 'Court Updated' };
      (courtRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(COURT);
      (courtRepo.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...COURT, ...data });

      const { service } = buildService({ courtRepo });
      const result = await service.updateCourt('court_1', data);

      expect(courtRepo.update).toHaveBeenCalledWith('court_1', data);
      expect(result.name).toBe('Court Updated');
    });

    it('throws FacilityNotFoundError when court does not exist', async () => {
      const courtRepo = mockCourtRepo();
      (courtRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const { service } = buildService({ courtRepo });
      await expect(service.updateCourt('missing', { name: 'X' })).rejects.toThrow(FacilityNotFoundError);
    });
  });

  // ── Shower management ──

  describe('listShowers', () => {
    it('delegates to showerRepo.listActive', async () => {
      const showerRepo = mockShowerRepo();
      (showerRepo.listActive as ReturnType<typeof vi.fn>).mockResolvedValue([SHOWER]);

      const { service } = buildService({ showerRepo });
      const result = await service.listShowers();

      expect(showerRepo.listActive).toHaveBeenCalled();
      expect(result).toEqual([SHOWER]);
    });
  });

  describe('listAllShowers', () => {
    it('delegates to showerRepo.listAll', async () => {
      const showerRepo = mockShowerRepo();
      (showerRepo.listAll as ReturnType<typeof vi.fn>).mockResolvedValue([SHOWER]);

      const { service } = buildService({ showerRepo });
      await service.listAllShowers();

      expect(showerRepo.listAll).toHaveBeenCalled();
    });
  });

  describe('createShower', () => {
    it('delegates to showerRepo.create', async () => {
      const showerRepo = mockShowerRepo();
      const input: CreateShowerInput = { name: 'Shower B' };
      (showerRepo.create as ReturnType<typeof vi.fn>).mockResolvedValue({ ...SHOWER, ...input });

      const { service } = buildService({ showerRepo });
      const result = await service.createShower(input);

      expect(showerRepo.create).toHaveBeenCalledWith(input);
      expect(result.name).toBe('Shower B');
    });
  });

  describe('updateShower', () => {
    it('updates shower when it exists', async () => {
      const showerRepo = mockShowerRepo();
      const data: UpdateShowerInput = { name: 'Shower Updated' };
      (showerRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(SHOWER);
      (showerRepo.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...SHOWER, ...data });

      const { service } = buildService({ showerRepo });
      const result = await service.updateShower('shower_1', data);

      expect(showerRepo.update).toHaveBeenCalledWith('shower_1', data);
      expect(result.name).toBe('Shower Updated');
    });

    it('throws FacilityNotFoundError when shower does not exist', async () => {
      const showerRepo = mockShowerRepo();
      (showerRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const { service } = buildService({ showerRepo });
      await expect(service.updateShower('missing', { name: 'X' })).rejects.toThrow(FacilityNotFoundError);
    });
  });

  // ── countUpcomingBookings ──

  describe('countUpcomingBookings', () => {
    it('delegates to bookingRepo.countUpcomingForFacility', async () => {
      const bookingRepo = mockBookingRepo();
      (bookingRepo.countUpcomingForFacility as ReturnType<typeof vi.fn>).mockResolvedValue(5);

      const { service } = buildService({ bookingRepo });
      const result = await service.countUpcomingBookings('court', 'court_1');

      expect(bookingRepo.countUpcomingForFacility).toHaveBeenCalledWith('court', 'court_1');
      expect(result).toBe(5);
    });
  });
});
