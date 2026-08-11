import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import {
  api,
  ApiError,
  type HomeFeed,
  type Reservation,
  type ReservationParticipant,
} from '../../lib/api';
import { ToastProvider } from '../../components';
import { HomePage } from './HomePage';

/**
 * Home feed composition (upcoming vs invitations vs the empty state), the
 * inline invitation respond flow (optimistic move + rollback), the club
 * invitation respond flow, and the greeting timezone pass-through.
 */

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getHome: vi.fn(),
      getMemberQr: vi.fn(),
      respondToReservation: vi.fn(),
      respondToClubInvitation: vi.fn(),
    },
  };
});

vi.mock('../../lib/session-context', () => ({
  useSession: () => ({ memberId: 'm-self' }),
}));

const getHome = vi.mocked(api.getHome);
const respondToReservation = vi.mocked(api.respondToReservation);
const respondToClubInvitation = vi.mocked(api.respondToClubInvitation);

function participant(
  memberId: string,
  overrides: Partial<ReservationParticipant> = {},
): ReservationParticipant {
  return {
    memberId,
    firstName: memberId === 'm-self' ? 'Olivia' : 'Sarah',
    lastName: memberId === 'm-self' ? 'Zha' : 'Kim',
    role: 'guest',
    status: 'confirmed',
    invitedById: null,
    ...overrides,
  };
}

function reservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 'r1',
    reference: 'BK-000123',
    typeCode: 'badminton_court',
    typeName: 'Badminton Court',
    resource: { id: 'c3', name: 'Court 3' },
    date: '2026-07-21',
    startTime: '09:00',
    endTime: '11:30',
    startsAt: '2026-07-21T13:00:00.000Z',
    endsAt: '2026-07-21T15:30:00.000Z',
    durationMinutes: 150,
    status: 'confirmed',
    hourlyRateCents: 6000,
    amountPaidCents: 15000,
    clubId: null,
    seriesId: null,
    weekly: false,
    createdByAdmin: false,
    participants: [participant('m-self', { role: 'organizer' })],
    pendingChange: null,
    myParticipation: {
      role: 'organizer',
      status: 'confirmed',
      invitedByName: null,
      invitedByFirstName: null,
    },
    ...overrides,
  };
}

const INVITATION = reservation({
  id: 'r-inv',
  date: '2026-07-26',
  startsAt: '2026-07-26T13:00:00.000Z',
  participants: [
    participant('m-sarah', { role: 'organizer', status: 'confirmed' }),
    participant('m-self', { status: 'pending', invitedById: 'm-sarah' }),
    participant('m-ben', { firstName: 'Ben', lastName: 'Ng', status: 'confirmed' }),
    participant('m-mia', { firstName: 'Mia', lastName: 'Tan', status: 'confirmed' }),
  ],
  myParticipation: {
    role: 'guest',
    status: 'pending',
    invitedByName: 'Sarah Kim',
    invitedByFirstName: 'Sarah',
  },
});

function feed(overrides: Partial<HomeFeed> = {}): HomeFeed {
  return {
    member: {
      id: 'm-self',
      email: 'olivia@example.com',
      firstName: 'Olivia',
      lastName: 'Zha',
      phone: null,
      memberNumber: 'A12345',
      displayName: null,
      avatarUrl: null,
      memberSince: '2026-01-01T00:00:00.000Z',
      membership: null,
    },
    greeting: { firstName: 'Olivia', timeOfDay: 'evening', timezone: 'America/New_York' },
    spotlightEvents: [
      {
        id: 'e1',
        title: 'CTC Exhibition Match',
        imageUrl: null,
        details: null,
        startsAt: '2026-08-15T20:00:00.000Z',
        endsAt: '2026-08-15T23:00:00.000Z',
        timezone: 'America/New_York',
        active: true,
        courts: [],
      },
    ],
    upcomingReservations: [reservation({ id: 'r-weekly', seriesId: 's1', weekly: true })],
    pendingInvitations: [INVITATION],
    clubInvitations: [
      {
        id: 'ci1',
        club: { id: 'club1', name: 'baddies', description: null, coverImageUrl: null, memberCount: 6 },
        invitedBy: { memberId: 'm-colin', firstName: 'Colin', lastName: 'Wu' },
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ],
    quickBook: {
      typeCode: 'badminton_court',
      typeName: 'Badminton Court',
      date: '2026-07-26',
      startTime: '09:00',
      endTime: '10:30',
      durationMinutes: 90,
      hourlyRateCents: 6000,
      reason: 'based on previous bookings',
    },
    amenities: null,
    ...overrides,
  };
}

const EMPTY_FEED = feed({
  upcomingReservations: [],
  pendingInvitations: [],
  clubInvitations: [],
  quickBook: null,
  amenities: [
    {
      typeCode: 'badminton_court',
      typeName: 'Badminton Court',
      hourlyRateCents: 2000,
      resourceCount: 4,
      availableSlotsToday: 12,
      locked: false,
    },
    {
      typeCode: 'shower',
      typeName: 'Shower',
      hourlyRateCents: 1000,
      resourceCount: 2,
      availableSlotsToday: 0,
      locked: true,
    },
  ],
});

function renderHome() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HomePage composition', () => {
  it('renders greeting, quick book, invitations before upcoming, clubs, and events', async () => {
    getHome.mockResolvedValue(feed());
    renderHome();

    expect(await screen.findByRole('heading', { level: 1, name: 'Olivia' })).toBeInTheDocument();
    expect(screen.getByText('Good evening,')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show membership card' })).toBeInTheDocument();

    // Quick book with the deep link into the wizard.
    expect(screen.getByRole('heading', { name: 'Quick book' })).toBeInTheDocument();
    expect(screen.getByText('AI suggestion')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Book Badminton Court/ })).toHaveAttribute(
      'href',
      expect.stringContaining('/reserve/badminton_court?date=2026-07-26'),
    );

    // The invitation renders distinctly (inviter line + inline actions).
    expect(screen.getByText('Sarah')).toBeInTheDocument();
    const respondGroup = screen.getByRole('group', { name: "Respond to Sarah's invitation" });
    expect(within(respondGroup).getByRole('button', { name: 'Accept' })).toBeEnabled();

    // Upcoming card links to the W4 detail and shows the Weekly badge.
    const upcomingLink = screen
      .getAllByRole('link')
      .find((link) => link.getAttribute('href') === '/reservations/r-weekly');
    expect(upcomingLink).toBeDefined();
    expect(screen.getByText('Weekly')).toBeInTheDocument();
    expect(screen.getByText('Court 3 · 1 player')).toBeInTheDocument();

    // Club invitation card + spotlight events; no empty-state banner.
    expect(screen.getByText('baddies')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Spotlight events' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('CTC Exhibition Match')).toBeInTheDocument();
    expect(screen.queryByText(/Book your first session/i)).not.toBeInTheDocument();
  });

  it('passes the browser IANA timezone to the home read', async () => {
    getHome.mockResolvedValue(feed());
    renderHome();
    await screen.findByRole('heading', { level: 1, name: 'Olivia' });
    expect(getHome).toHaveBeenCalledWith(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('renders the amenity empty state when the backend sends amenities', async () => {
    getHome.mockResolvedValue(EMPTY_FEED);
    renderHome();

    expect(await screen.findByText('Book your first session')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Reserve play' })).toBeInTheDocument();
    expect(screen.getByText('4 courts available · $20/hr')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Book Badminton Court' })).toHaveAttribute(
      'href',
      '/reserve/badminton_court',
    );
    // Locked amenity gets no booking action.
    expect(screen.getByText('Requires a PRO membership')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Book Shower' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Upcoming reservations' })).not.toBeInTheDocument();
  });

  it('shows a retryable error instead of a blank shell when the load fails', async () => {
    getHome.mockRejectedValueOnce(new ApiError('UNKNOWN', 'boom', 500));
    getHome.mockResolvedValueOnce(feed());
    renderHome();

    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load your home feed.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Olivia' })).toBeInTheDocument();
  });
});

describe('inline reservation invitation respond', () => {
  // The club invitation is left out so the invitation card's Accept is
  // the only one on the page.
  const INVITES_ONLY = feed({ clubInvitations: [] });

  it('accept moves the card into upcoming optimistically, then toasts', async () => {
    getHome.mockResolvedValue(INVITES_ONLY);
    const pending = deferred<{ status: 'confirmed' }>();
    respondToReservation.mockReturnValue(pending.promise);
    renderHome();

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));

    // Optimistic: the invitation card is gone before the server answers,
    // and the reservation now renders as a normal upcoming row.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    });
    const movedLink = screen
      .getAllByRole('link')
      .find((link) => link.getAttribute('href') === '/reservations/r-inv');
    expect(movedLink).toBeDefined();

    pending.resolve({ status: 'confirmed' });
    expect(await screen.findByText('Invite accepted! See you July 26.')).toBeInTheDocument();
    expect(respondToReservation).toHaveBeenCalledWith('r-inv', 'accept');
  });

  it('rolls the card back and toasts on failure', async () => {
    getHome.mockResolvedValue(INVITES_ONLY);
    respondToReservation.mockRejectedValue(new ApiError('UNKNOWN', 'boom', 500));
    renderHome();

    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));

    expect(
      await screen.findByText('We could not save your response. Try again.'),
    ).toBeInTheDocument();
    // Rollback: the invitation card (inline actions included) is back.
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(
      screen.getAllByRole('link').find((link) => link.getAttribute('href') === '/reservations/r-inv'),
    ).toBeUndefined();
  });
});

describe('club invitation respond', () => {
  // The reservation invitation is left out so the club card's Accept is
  // the only one on the page.
  const CLUBS_ONLY = feed({ pendingInvitations: [] });

  it('accept removes the card optimistically and toasts the join', async () => {
    getHome.mockResolvedValue(CLUBS_ONLY);
    const pending = deferred<{ status: string; clubId: string }>();
    respondToClubInvitation.mockReturnValue(pending.promise);
    renderHome();

    await screen.findByText('baddies');
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => {
      expect(screen.queryByText('baddies')).not.toBeInTheDocument();
    });

    pending.resolve({ status: 'accepted', clubId: 'club1' });
    expect(await screen.findByText('You joined baddies.')).toBeInTheDocument();
    expect(respondToClubInvitation).toHaveBeenCalledWith('ci1', 'accept');
  });

  it('rolls back when the invitation is no longer open', async () => {
    getHome.mockResolvedValue(CLUBS_ONLY);
    respondToClubInvitation.mockRejectedValue(
      new ApiError('INVALID_INVITATION_STATE', 'stale', 409),
    );
    renderHome();

    await screen.findByText('baddies');
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));

    expect(
      await screen.findByText('This club invitation is no longer open.'),
    ).toBeInTheDocument();
    expect(screen.getByText('baddies')).toBeInTheDocument();
  });
});
