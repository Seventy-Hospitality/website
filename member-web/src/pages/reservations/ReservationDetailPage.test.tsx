import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  api,
  ApiError,
  type Reservation,
  type ReservationParticipant,
  type ReservationViewer,
} from '../../lib/api';
import { ToastProvider } from '../../components';
import { ReservationDetailPage } from './ReservationDetailPage';

/**
 * Capability-driven rendering and the respond lifecycle: the same page
 * serves the organizer (edit/cancel/invite), a pending invitee
 * (ACCEPT/DECLINE with optimistic rollback), and an accepted participant
 * (withdraw behind a confirmation).
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getReservation: vi.fn(),
      respondToReservation: vi.fn(),
      cancelReservation: vi.fn(),
      addReservationParticipants: vi.fn(),
      removeReservationParticipant: vi.fn(),
    },
  };
});

vi.mock('../../lib/session-context', () => ({
  useSession: () => ({ memberId: 'm-self' }),
}));

const getReservation = vi.mocked(api.getReservation);
const respondToReservation = vi.mocked(api.respondToReservation);
const cancelReservation = vi.mocked(api.cancelReservation);

const ORGANIZER: ReservationParticipant = {
  memberId: 'm-org',
  firstName: 'Olivia',
  lastName: 'Zha',
  role: 'organizer',
  status: 'confirmed',
  invitedById: null,
};

const GUEST_CONFIRMED: ReservationParticipant = {
  memberId: 'm-chris',
  firstName: 'Chris',
  lastName: 'Thompson',
  role: 'guest',
  status: 'confirmed',
  invitedById: 'm-org',
};

const GUEST_DECLINED: ReservationParticipant = {
  memberId: 'm-sofia',
  firstName: 'Sofia',
  lastName: 'Lopez',
  role: 'guest',
  status: 'declined',
  invitedById: 'm-org',
};

function selfParticipant(
  status: ReservationParticipant['status'],
  role: ReservationParticipant['role'] = 'guest',
): ReservationParticipant {
  return {
    memberId: 'm-self',
    firstName: 'Sam',
    lastName: 'Lee',
    role,
    status,
    invitedById: role === 'guest' ? 'm-org' : null,
  };
}

function detailFixture(overrides: {
  participants: ReservationParticipant[];
  viewer: ReservationViewer;
  status?: Reservation['status'];
  startsAt?: string;
  amountPaidCents?: number;
}): Reservation & { viewer: ReservationViewer } {
  const startsAt = overrides.startsAt ?? new Date(Date.now() + 48 * 3_600_000).toISOString();
  return {
    id: 'res1',
    reference: 'BK-010492',
    typeCode: 'badminton_court',
    typeName: 'Badminton Court',
    resource: { id: 'r1', name: 'Court 1' },
    date: '2026-07-06',
    startTime: '21:30',
    endTime: '23:00',
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 90 * 60_000).toISOString(),
    durationMinutes: 90,
    status: overrides.status ?? 'confirmed',
    hourlyRateCents: 6000,
    amountPaidCents: overrides.amountPaidCents ?? 9000,
    clubId: null,
    seriesId: null,
    weekly: false,
    createdByAdmin: false,
    participants: overrides.participants,
    pendingChange: null,
    viewer: overrides.viewer,
  };
}

const ORGANIZER_VIEW = detailFixture({
  participants: [selfParticipant('confirmed', 'organizer'), GUEST_CONFIRMED, GUEST_DECLINED],
  viewer: {
    role: 'organizer',
    status: 'confirmed',
    canInvite: true,
    canManage: true,
    canRespond: false,
  },
});

const PENDING_INVITEE_VIEW = detailFixture({
  participants: [ORGANIZER, selfParticipant('pending'), GUEST_CONFIRMED],
  viewer: {
    role: 'guest',
    status: 'pending',
    canInvite: false,
    canManage: false,
    canRespond: true,
  },
});

const ACCEPTED_GUEST_VIEW = detailFixture({
  participants: [ORGANIZER, selfParticipant('confirmed'), GUEST_CONFIRMED],
  viewer: {
    role: 'guest',
    status: 'confirmed',
    canInvite: true,
    canManage: false,
    canRespond: true,
  },
});

function renderDetail() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/reservations/res1']}>
          <Routes>
            <Route path="/reservations/:reservationId" element={<ReservationDetailPage />} />
            <Route path="/reservations/:reservationId/invite" element={<div>Invite page</div>} />
            <Route path="/reservations/:reservationId/edit" element={<div>Edit page</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('capability-driven actions', () => {
  it('shows the organizer edit/cancel/invite plus per-player menus', async () => {
    getReservation.mockResolvedValue(ORGANIZER_VIEW);
    renderDetail();

    expect(await screen.findByRole('link', { name: 'Edit reservation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel reservation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for Chris Thompson' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decline reservation' })).not.toBeInTheDocument();
    // The booking card facts.
    expect(screen.getByText('Court 1')).toBeInTheDocument();
    expect(screen.getByText('#BK-010492')).toBeInTheDocument();
  });

  it('shows a pending invitee ACCEPT / DECLINE on their own row only', async () => {
    getReservation.mockResolvedValue(PENDING_INVITEE_VIEW);
    renderDetail();

    expect(await screen.findByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit reservation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel reservation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
  });

  it('shows an accepted guest the withdraw action behind a confirmation', async () => {
    // Initial read: accepted; the refetch after responding sees withdrawn.
    getReservation.mockResolvedValueOnce(ACCEPTED_GUEST_VIEW).mockResolvedValue(
      detailFixture({
        participants: [ORGANIZER, selfParticipant('withdrawn'), GUEST_CONFIRMED],
        viewer: {
          role: 'guest',
          status: 'withdrawn',
          canInvite: false,
          canManage: false,
          canRespond: true,
        },
      }),
    );
    respondToReservation.mockResolvedValue({ status: 'withdrawn' });
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Decline reservation' }));
    const dialog = screen.getByRole('dialog', { hidden: true, name: 'Decline reservation' });
    expect(within(dialog).getByText(/Declining gives up your spot/)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Decline reservation' }));
    await waitFor(() =>
      expect(respondToReservation).toHaveBeenCalledWith('res1', 'decline'),
    );
    // Optimistic: the own row flips to Withdrawn.
    expect(await screen.findByText('Withdrawn')).toBeInTheDocument();
  });

  it('shows no actions on a cancelled reservation', async () => {
    getReservation.mockResolvedValue(
      detailFixture({
        participants: [selfParticipant('confirmed', 'organizer'), GUEST_CONFIRMED],
        viewer: {
          role: 'organizer',
          status: 'confirmed',
          canInvite: false,
          canManage: true,
          canRespond: false,
        },
        status: 'cancelled',
      }),
    );
    renderDetail();

    expect(await screen.findByText('This reservation was cancelled.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit reservation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel reservation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
  });

  it('never offers Invite on an inactive reservation, even with a stale canInvite flag', async () => {
    // The optimistic cancel write flips status but keeps the old viewer
    // flags; the Invite gate must re-derive the status half itself.
    getReservation.mockResolvedValue(
      detailFixture({
        participants: [selfParticipant('confirmed', 'organizer'), GUEST_CONFIRMED],
        viewer: {
          role: 'organizer',
          status: 'confirmed',
          canInvite: true,
          canManage: true,
          canRespond: false,
        },
        status: 'cancelled',
      }),
    );
    renderDetail();

    expect(await screen.findByText('This reservation was cancelled.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
  });

  it('renders not-found for a reservation the viewer is not part of', async () => {
    getReservation.mockRejectedValue(new ApiError('NOT_FOUND', 'not found', 404));
    renderDetail();

    expect(await screen.findByText('Reservation not found')).toBeInTheDocument();
  });
});

describe('accept/decline optimistic updates', () => {
  it('flips the own row to Confirmed before the server answers', async () => {
    getReservation.mockResolvedValue(PENDING_INVITEE_VIEW);
    let resolveRespond!: (value: { status: 'confirmed' }) => void;
    respondToReservation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRespond = resolve;
        }),
    );
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));

    // Optimistic: pills replaced by the Confirmed status while in flight
    // (organizer + Chris + the viewer's flipped row make it 3 total).
    await waitFor(() => expect(screen.getAllByText('Confirmed')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();

    getReservation.mockResolvedValue(
      detailFixture({
        participants: [ORGANIZER, selfParticipant('confirmed'), GUEST_CONFIRMED],
        viewer: {
          role: 'guest',
          status: 'confirmed',
          canInvite: true,
          canManage: false,
          canRespond: true,
        },
      }),
    );
    resolveRespond({ status: 'confirmed' });
    await waitFor(() => expect(respondToReservation).toHaveBeenCalledWith('res1', 'accept'));
  });

  it('keeps keyboard focus on the row and announces the result after accepting', async () => {
    getReservation.mockResolvedValueOnce(PENDING_INVITEE_VIEW).mockResolvedValue(
      detailFixture({
        participants: [ORGANIZER, selfParticipant('confirmed'), GUEST_CONFIRMED],
        viewer: {
          role: 'guest',
          status: 'confirmed',
          canInvite: true,
          canManage: false,
          canRespond: true,
        },
      }),
    );
    respondToReservation.mockResolvedValue({ status: 'confirmed' });
    renderDetail();

    const accept = await screen.findByRole('button', { name: 'Accept' });
    const row = accept.closest('li')!;
    await userEvent.click(accept);

    // The pressed pill unmounts (the row flips off pending); focus must
    // land on the viewer's own row, not fall back to the body.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(row).toHaveFocus());

    // The saved outcome is announced to assistive tech.
    expect(
      await screen.findByText('Invitation accepted. You are confirmed for this booking.'),
    ).toBeInTheDocument();
  });

  it('rolls the row back when the respond call fails', async () => {
    getReservation.mockResolvedValue(PENDING_INVITEE_VIEW);
    respondToReservation.mockRejectedValue(new ApiError('UNKNOWN', 'boom', 500));
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));

    // Rolled back: the pills are offered again.
    expect(await screen.findByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(
      await screen.findByText('We could not save your response. Try again.'),
    ).toBeInTheDocument();
  });
});

describe('cancel with the tiered refund preview', () => {
  it('previews the 50% tier for a booking starting within 24 hours', async () => {
    const organizerSoon = detailFixture({
      participants: [selfParticipant('confirmed', 'organizer'), GUEST_CONFIRMED],
      viewer: {
        role: 'organizer',
        status: 'confirmed',
        canInvite: true,
        canManage: true,
        canRespond: false,
      },
      startsAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
      amountPaidCents: 12000,
    });
    // Initial read confirmed; the refetch after cancelling sees cancelled.
    getReservation
      .mockResolvedValueOnce(organizerSoon)
      .mockResolvedValue({ ...organizerSoon, status: 'cancelled' });
    cancelReservation.mockResolvedValue({ cancelled: true, refundCents: 6000 });
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel reservation' }));
    const dialog = screen.getByRole('dialog', { hidden: true, name: 'Cancel reservation' });
    expect(within(dialog).getByText('Refund to your card (50%)')).toBeInTheDocument();
    expect(within(dialog).getByText('$60.00')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/between 2 and 24 hours before the start time/),
    ).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel reservation' }));
    await waitFor(() => expect(cancelReservation).toHaveBeenCalledWith('res1'));
    expect(await screen.findByText('This reservation was cancelled.')).toBeInTheDocument();
    // The optimistic write leaves viewer.canInvite stale-true; Invite must
    // disappear with the cancellation, not wait for the refetch.
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
  });

  it('spells out the 0% tier inside 2 hours of start', async () => {
    getReservation.mockResolvedValue(
      detailFixture({
        participants: [selfParticipant('confirmed', 'organizer')],
        viewer: {
          role: 'organizer',
          status: 'confirmed',
          canInvite: true,
          canManage: true,
          canRespond: false,
        },
        startsAt: new Date(Date.now() + 1 * 3_600_000).toISOString(),
        amountPaidCents: 12000,
      }),
    );
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel reservation' }));
    const dialog = screen.getByRole('dialog', { hidden: true, name: 'Cancel reservation' });
    expect(within(dialog).getByText('Refund to your card (0%)')).toBeInTheDocument();
    expect(within(dialog).getByText('$0.00')).toBeInTheDocument();
    expect(within(dialog).getByText(/non-refundable/)).toBeInTheDocument();
  });
});
