import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  api,
  type Reservation,
  type ReservationViewer,
  type RescheduleQuote,
  type ResourceTypeSummary,
} from '../../lib/api';
import { addDaysToDateKey, formatDateLong, todayDateKey } from '../../lib/booking';
import { ToastProvider } from '../../components';
import { EditReservationPage } from './EditReservationPage';

/**
 * The 2-step reschedule wizard: current-slot pre-selection with the dirty
 * check, then the two money branches of confirm-changes (refund applies
 * immediately; grow collects the delta through the shared Payment Element
 * pattern with no path to a double charge).
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getReservation: vi.fn(),
      getResourceTypes: vi.fn(),
      getMyMembership: vi.fn(),
      getAvailability: vi.fn(),
      rescheduleQuote: vi.fn(),
      rescheduleReservation: vi.fn(),
      confirmReservation: vi.fn(),
    },
  };
});

vi.mock('../../lib/session-context', () => ({
  useSession: () => ({ memberId: 'm-self' }),
}));

// The grow branch only checks getStripe() for null (a promise is truthy).
vi.mock('../../lib/stripe', () => ({
  getStripe: () => Promise.resolve(null),
  stripeAppearance: {},
}));

const { confirmPayment } = vi.hoisted(() => ({ confirmPayment: vi.fn() }));

vi.mock('@stripe/react-stripe-js', async () => {
  const { useEffect } = await import('react');
  return {
    Elements: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    PaymentElement: ({ onReady }: { onReady?: () => void }) => {
      useEffect(() => {
        onReady?.();
      }, [onReady]);
      return <div data-testid="payment-element" />;
    },
    useStripe: () => ({ confirmPayment }),
    useElements: () => ({}),
  };
});

const getReservation = vi.mocked(api.getReservation);
const getResourceTypes = vi.mocked(api.getResourceTypes);
const getMyMembership = vi.mocked(api.getMyMembership);
const getAvailability = vi.mocked(api.getAvailability);
const rescheduleQuote = vi.mocked(api.rescheduleQuote);
const rescheduleReservation = vi.mocked(api.rescheduleReservation);
const confirmReservation = vi.mocked(api.confirmReservation);

const TYPE: ResourceTypeSummary = {
  code: 'badminton_court',
  name: 'Badminton Court',
  slotDurationMinutes: 30,
  opStartMinutes: 480,
  opEndMinutes: 1440,
  hourlyRateCents: 6000,
  maxAdvanceDays: 14,
  minTier: 'member',
  locked: false,
  resourceCount: 4,
  icon: 'badminton_court',
};

const TOMORROW = addDaysToDateKey(todayDateKey(), 1);

const VIEWER: ReservationViewer = {
  role: 'organizer',
  status: 'confirmed',
  canInvite: true,
  canManage: true,
  canRespond: false,
};

/** Confirmed 2-slot booking tomorrow 21:30-22:30, $120 paid. */
const DETAIL: Reservation & { viewer: ReservationViewer } = {
  id: 'res1',
  reference: 'BK-010492',
  typeCode: 'badminton_court',
  typeName: 'Badminton Court',
  resource: { id: 'r1', name: 'Court 1' },
  date: TOMORROW,
  startTime: '21:30',
  endTime: '22:30',
  startsAt: new Date(Date.now() + 30 * 3_600_000).toISOString(),
  endsAt: new Date(Date.now() + 31 * 3_600_000).toISOString(),
  durationMinutes: 60,
  status: 'confirmed',
  hourlyRateCents: 6000,
  amountPaidCents: 12000,
  clubId: null,
  seriesId: null,
  weekly: false,
  createdByAdmin: false,
  participants: [
    {
      memberId: 'm-self',
      firstName: 'Olivia',
      lastName: 'Zha',
      role: 'organizer',
      status: 'confirmed',
      invitedById: null,
    },
    {
      memberId: 'm-chris',
      firstName: 'Chris',
      lastName: 'Thompson',
      role: 'guest',
      status: 'confirmed',
      invitedById: 'm-self',
    },
  ],
  pendingChange: null,
  viewer: VIEWER,
};

function quoteFixture(overrides: Partial<RescheduleQuote>): RescheduleQuote {
  return {
    date: TOMORROW,
    slots: ['22:00'],
    durationMinutes: 30,
    newTotalCents: 3000,
    netPaidCents: 12000,
    deltaCents: -9000,
    ...overrides,
  };
}

/** The post-move reservation: guests reset to pending. */
function updatedReservation(overrides: Partial<Reservation>): Reservation {
  return {
    ...DETAIL,
    startTime: '22:00',
    endTime: '22:30',
    durationMinutes: 30,
    amountPaidCents: 3000,
    participants: [
      DETAIL.participants[0],
      { ...DETAIL.participants[1], status: 'pending' },
    ],
    pendingChange: null,
    ...overrides,
  };
}

function renderEdit(initialEntry = '/reservations/res1/edit') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/reservations/:reservationId/edit" element={<EditReservationPage />} />
            <Route path="/reservations/:reservationId" element={<div>Detail page</div>} />
            <Route
              path="/reservations/:reservationId/invite"
              element={<div>Invite page</div>}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getReservation.mockResolvedValue(DETAIL);
  getResourceTypes.mockResolvedValue([TYPE]);
  getMyMembership.mockResolvedValue({
    membership: {
      id: 'sub1',
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      cancelAtPeriodEnd: false,
      plan: null,
      pendingPlan: null,
      pendingPlanEffectiveAt: null,
    },
  });
  // Only 21:00 is free on the grid; the reservation's own 21:30/22:00 are
  // merged in as available-to-itself.
  getAvailability.mockResolvedValue([
    { date: TOMORROW, slots: [{ start: '21:00', startsAt: new Date().toISOString() }] },
  ]);
});

describe('step 1: pre-selection and the dirty check', () => {
  it('pre-selects the reservation\'s own slots and disables Continue until changed', async () => {
    renderEdit();

    expect(await screen.findByRole('heading', { name: 'Edit booking' })).toBeInTheDocument();

    // Own slots are listed (merged into availability) and pre-selected.
    const own1 = await screen.findByRole('option', { name: '9:30PM - 10:00PM' });
    const own2 = screen.getByRole('option', { name: '10:00PM - 10:30PM' });
    const free = screen.getByRole('option', { name: '9:00PM - 9:30PM' });
    expect(own1).toHaveAttribute('aria-selected', 'true');
    expect(own2).toHaveAttribute('aria-selected', 'true');
    expect(free).toHaveAttribute('aria-selected', 'false');

    // Unchanged selection: Continue stays off.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    // Growing the run makes it dirty.
    await userEvent.click(free);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

    // Back to exactly the original slots: clean again.
    await userEvent.click(free);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });
});

describe('step 2: refund branch (shrink)', () => {
  it('shows the refund order summary and applies the change on Save', async () => {
    rescheduleQuote.mockResolvedValue(quoteFixture({ deltaCents: -9000 }));
    rescheduleReservation.mockResolvedValue({
      reservation: updatedReservation({}),
      deltaCents: -9000,
      clientSecret: null,
    });
    renderEdit();

    // Shrink to the 10:00PM slot only (deselecting the run's first slot).
    await userEvent.click(await screen.findByRole('option', { name: '9:30PM - 10:00PM' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Confirm changes' })).toBeInTheDocument();

    // Old time struck through -> new time; the money is a refund.
    expect(await screen.findByText('9:30-10:30PM')).toBeInTheDocument();
    expect(screen.getByText('10:00-10:30PM')).toBeInTheDocument();
    expect(screen.getByText('Total due today')).toBeInTheDocument();
    expect(screen.getByText('$0.00')).toBeInTheDocument();
    expect(screen.getByText('Previous payment')).toBeInTheDocument();
    expect(
      screen.getByText(/You will be refunded \$90\.00 to the account on file/),
    ).toBeInTheDocument();
    // No payment form on a refund.
    expect(screen.queryByTestId('payment-element')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(rescheduleReservation).toHaveBeenCalledWith('res1', {
        date: TOMORROW,
        slots: ['22:00'],
      }),
    );

    // Success modal: booking ref persists, players reset to pending.
    expect(
      await screen.findByText('Your court booking was updated'),
    ).toBeInTheDocument();
    expect(screen.getByText('#BK-010492')).toBeInTheDocument();
    expect(screen.getByText('will need to reaccept their invitations')).toBeInTheDocument();
    expect(screen.getByText('$90.00 is being refunded to your card')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });
});

describe('step 2: charge branch (grow)', () => {
  function growSelection() {
    return (async () => {
      await userEvent.click(await screen.findByRole('option', { name: '9:00PM - 9:30PM' }));
      await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await screen.findByRole('heading', { name: 'Confirm changes' });
    })();
  }

  const GROW_SLOTS = ['21:00', '21:30', '22:00'];

  beforeEach(() => {
    rescheduleQuote.mockResolvedValue(
      quoteFixture({
        slots: GROW_SLOTS,
        durationMinutes: 90,
        newTotalCents: 18000,
        deltaCents: 6000,
      }),
    );
    rescheduleReservation.mockResolvedValue({
      reservation: {
        ...DETAIL,
        pendingChange: {
          date: TOMORROW,
          startTime: '21:00',
          endTime: '22:30',
          deltaCents: 6000,
          expiresAt: new Date(Date.now() + 12 * 60_000).toISOString(),
        },
      },
      deltaCents: 6000,
      clientSecret: 'cs_change',
    });
  });

  it('parks the change, collects the delta, and applies it after payment', async () => {
    confirmPayment.mockResolvedValue({});
    confirmReservation.mockResolvedValue(
      updatedReservation({
        startTime: '21:00',
        endTime: '22:30',
        durationMinutes: 90,
        amountPaidCents: 18000,
      }),
    );
    renderEdit();
    await growSelection();

    // The PATCH parked the change up front and its PaymentIntent feeds the
    // Payment Element.
    await waitFor(() =>
      expect(rescheduleReservation).toHaveBeenCalledWith('res1', {
        date: TOMORROW,
        slots: GROW_SLOTS,
      }),
    );
    expect(await screen.findByTestId('payment-element')).toBeInTheDocument();
    // The delta appears as Total due today (and equals the hourly rate here).
    expect(screen.getAllByText('$60.00').length).toBeGreaterThanOrEqual(2);

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(confirmPayment).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(confirmReservation).toHaveBeenCalledWith('res1'));

    // The Stripe return URL carries the requested move so the redirect
    // return leg can verify the reservation actually landed on it.
    expect(confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmParams: expect.objectContaining({
          return_url: expect.stringContaining(
            `resume=1&to_date=${TOMORROW}&to_start=21%3A00&to_end=22%3A30`,
          ),
        }),
      }),
    );

    expect(await screen.findByText('Your court booking was updated')).toBeInTheDocument();
    expect(screen.getByText('will need to reaccept their invitations')).toBeInTheDocument();
    // One PATCH, one payment confirm: no double charge path.
    expect(rescheduleReservation).toHaveBeenCalledTimes(1);
  });

  it('reports a dropped change instead of success when the reservation did not move', async () => {
    confirmPayment.mockResolvedValue({});
    // The parked change lapsed or was swept while the payment settled: the
    // backend cleared pendingChange, refunded the delta, and confirm()
    // returns the UNMOVED original (same date, old 21:30-22:30 time).
    confirmReservation.mockResolvedValue({ ...DETAIL });
    renderEdit();
    await growSelection();

    await userEvent.click(await screen.findByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText(/We could not apply your change in time/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Your court booking was updated')).not.toBeInTheDocument();
  });

  it('surfaces a decline inline and never confirms the change', async () => {
    confirmPayment.mockResolvedValue({
      error: { type: 'card_error', message: 'Your card was declined.' },
    });
    renderEdit();
    await growSelection();

    await userEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Your card was declined.')).toBeInTheDocument();
    expect(confirmReservation).not.toHaveBeenCalled();
    expect(rescheduleReservation).toHaveBeenCalledTimes(1);
  });
});

describe('redirect-based payment return', () => {
  // The wizard put the requested move (21:00-22:30 tomorrow) on the
  // return URL before handing off to the redirect payment method.
  const RESUME_URL =
    `/reservations/res1/edit?resume=1&redirect_status=succeeded` +
    `&to_date=${TOMORROW}&to_start=21%3A00&to_end=22%3A30`;

  it('shows the updated modal when the reservation moved to the requested time', async () => {
    confirmReservation.mockResolvedValue(
      updatedReservation({
        startTime: '21:00',
        endTime: '22:30',
        durationMinutes: 90,
        amountPaidCents: 18000,
      }),
    );
    renderEdit(RESUME_URL);

    expect(await screen.findByText('Your court booking was updated')).toBeInTheDocument();
    await waitFor(() => expect(confirmReservation).toHaveBeenCalledWith('res1'));
  });

  it('reports a dropped change when confirm returns the unmoved original', async () => {
    // pendingChange is gone but the reservation still sits on its old
    // 21:30-22:30 time: the change lapsed/was swept and the delta was
    // refunded server-side. Success must NOT be reported.
    confirmReservation.mockResolvedValue({ ...DETAIL });
    renderEdit(RESUME_URL);

    expect(
      await screen.findByText(/We could not apply your change in time/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Your court booking was updated')).not.toBeInTheDocument();
  });
});

describe('step 2: date-only move (same clock time on a new day)', () => {
  it('marks the date as changed without striking through the identical time', async () => {
    const dayAfter = addDaysToDateKey(todayDateKey(), 2);
    getAvailability.mockResolvedValue([
      {
        date: TOMORROW,
        slots: [
          { start: '21:30', startsAt: new Date().toISOString() },
          { start: '22:00', startsAt: new Date().toISOString() },
        ],
      },
    ]);
    rescheduleQuote.mockResolvedValue(
      quoteFixture({
        date: dayAfter,
        slots: ['21:30', '22:00'],
        durationMinutes: 60,
        newTotalCents: 12000,
        deltaCents: 0,
      }),
    );
    renderEdit();

    // Pick the day after tomorrow (strip starts today), then the same
    // 21:30-22:30 run.
    await screen.findByRole('heading', { name: 'Edit booking' });
    await userEvent.click(screen.getAllByRole('radio')[2]);
    await userEvent.click(await screen.findByRole('option', { name: '9:30PM - 10:00PM' }));
    await userEvent.click(screen.getByRole('option', { name: '10:00PM - 10:30PM' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Confirm changes' })).toBeInTheDocument();

    // The date change is spelled out for screen readers (the struck-through
    // <s> carries no old/new semantics on its own).
    expect(
      await screen.findByText(
        `Changed from ${formatDateLong(TOMORROW)} to ${formatDateLong(dayAfter)}`,
      ),
    ).toBeInTheDocument();

    // The unchanged time renders once: no strike-through, no bogus
    // "Changed from X to X" announcement.
    expect(screen.getAllByText('9:30-10:30PM')).toHaveLength(1);
    expect(screen.getByText('9:30-10:30PM').tagName).not.toBe('S');
    expect(screen.queryByText(/Changed from 9:30-10:30PM/)).not.toBeInTheDocument();
  });
});

describe('guards', () => {
  it('blocks non-organizers from the edit wizard', async () => {
    getReservation.mockResolvedValue({
      ...DETAIL,
      viewer: { ...VIEWER, role: 'guest', canManage: false },
    });
    renderEdit();

    expect(await screen.findByText('Only the organizer can edit')).toBeInTheDocument();
  });

  it('blocks editing a cancelled reservation', async () => {
    getReservation.mockResolvedValue({ ...DETAIL, status: 'cancelled' });
    renderEdit();

    expect(
      await screen.findByText('This reservation can no longer be edited'),
    ).toBeInTheDocument();
  });
});
