import { useCallback, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CalendarDays,
  CalendarPlus,
  Lock,
  QrCode,
  RefreshCw,
  Sparkles,
  Users,
} from 'lucide-react';
import type {
  ClubInvitation,
  HomeAmenitySummary,
  QuickBookSuggestion,
  Reservation,
  SpotlightEvent,
} from '../../lib/api';
import {
  availabilityCountLabel,
  formatDateCompact,
  formatDateLong,
  formatMonthDay,
  formatTimeRangeCompact,
} from '../../lib/booking';
import { formatAmount } from '../../lib/plan-pricing';
import { isRespondConflict, useRespondToReservation } from '../../lib/reservation-respond';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  IconTile,
  ListRow,
  MemberQrSheet,
  ReservationCard,
  ResourceTypeIcon,
  Skeleton,
  useToast,
} from '../../components';
import { PageHeader } from '../../app/AppShell';
import { homeQuery, isClubInviteConflict, useRespondToClubInvitation } from './home-data';
import styles from './HomePage.module.css';

const GREETINGS = {
  morning: 'Good morning,',
  afternoon: 'Good afternoon,',
  evening: 'Good evening,',
} as const;

/**
 * The home feed (package W2; Figma home/default 68:1105, home/empty-state
 * 174:16152, home-with-invitation 325:14393): greeting + member QR entry,
 * the quick-book suggestion, upcoming reservations with inline invitation
 * cards, club invitations, spotlight events, and the first-session empty
 * state. One aggregated read (GET /api/me/home) feeds every section.
 */
export function HomePage() {
  const home = useQuery(homeQuery);
  const [qrOpen, setQrOpen] = useState(false);
  const { toast } = useToast();

  // Responding unmounts the pressed Accept/Decline control (the optimistic
  // write moves or removes the card), which would drop keyboard focus to
  // the body; park it on the owning section heading instead (W4's focus
  // pattern). When the response empties the whole section, that heading
  // unmounts too, so focus goes to the page heading, which survives every
  // layout swap (the transient "Nothing coming up" state and the refetched
  // amenity empty state included). Which target survives is decided from
  // the cached feed at click time: the section heading can still be
  // mounted when the timer fires and only unmount afterwards, so checking
  // ref.current inside the timer is not enough. The toast announces the
  // saved outcome.
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const upcomingHeadingRef = useRef<HTMLHeadingElement>(null);
  const clubsHeadingRef = useRef<HTMLHeadingElement>(null);
  const parkFocus = useCallback((target: RefObject<HTMLHeadingElement | null>) => {
    window.setTimeout(() => (target.current ?? pageHeadingRef.current)?.focus(), 0);
  }, []);

  // Both respond mutations live at the page level: the pressed card
  // unmounts with the optimistic write, and mutate-time callbacks (the
  // outcome toasts) are dropped for unmounted callers.
  const respond = useRespondToReservation();
  const respondToInvitation = useCallback(
    (reservation: Reservation, response: 'accept' | 'decline') => {
      // Declining the only pending invitation with nothing else upcoming
      // unmounts the whole "Upcoming reservations" section (accepting
      // never does: the card moves within the same section).
      const current = home.data;
      const emptiesSection =
        response === 'decline' &&
        current !== undefined &&
        current.pendingInvitations.length === 1 &&
        current.upcomingReservations.length === 0;
      parkFocus(emptiesSection ? pageHeadingRef : upcomingHeadingRef);
      respond.mutate(
        { reservationId: reservation.id, response },
        {
          onSuccess: ({ status }) => {
            toast({
              variant: 'success',
              message:
                status === 'confirmed'
                  ? `Invite accepted! See you ${formatMonthDay(reservation.date)}.`
                  : 'Invitation declined.',
            });
          },
          onError: (error) => {
            toast({
              variant: 'error',
              message: isRespondConflict(error)
                ? 'This reservation changed before your response was saved.'
                : 'We could not save your response. Try again.',
            });
          },
        },
      );
    },
    [home.data, respond, toast, parkFocus],
  );

  const clubRespond = useRespondToClubInvitation();
  const respondToClubInvitation = useCallback(
    (invitation: ClubInvitation, response: 'accept' | 'decline') => {
      // Responding removes the card on accept AND decline; the last one
      // unmounts the whole "Club invitations" section.
      const current = home.data;
      const emptiesSection = current !== undefined && current.clubInvitations.length === 1;
      parkFocus(emptiesSection ? pageHeadingRef : clubsHeadingRef);
      clubRespond.mutate(
        { invitationId: invitation.id, response },
        {
          onSuccess: () => {
            toast({
              variant: 'success',
              message:
                response === 'accept'
                  ? `You joined ${invitation.club.name}.`
                  : 'Club invitation declined.',
            });
          },
          onError: (error) => {
            toast({
              variant: 'error',
              message: isClubInviteConflict(error)
                ? 'This club invitation is no longer open.'
                : 'We could not save your response. Try again.',
            });
          },
        },
      );
    },
    [home.data, clubRespond, toast, parkFocus],
  );

  if (home.isPending) {
    return (
      <div className={styles.page}>
        <div className={styles.headerSkeleton}>
          <div className={styles.headerSkeletonText}>
            <Skeleton width="7rem" height="1.25rem" />
            <Skeleton width="11rem" height="2.5rem" />
          </div>
          <Skeleton width="2.75rem" height="2.75rem" shape="card" />
        </div>
        <div className={styles.page} role="status" aria-busy="true">
          <span className="visually-hidden">Loading your home feed</span>
          <Skeleton height="8rem" shape="card" />
          <Skeleton height="6.5rem" shape="card" />
          <Skeleton height="6.5rem" shape="card" />
          <Skeleton height="11rem" shape="card" />
        </div>
      </div>
    );
  }

  if (home.isError) {
    return (
      <>
        <PageHeader title="Home" />
        <div className={styles.errorBox} role="alert">
          <p>We could not load your home feed.</p>
          <Button variant="secondary" size="sm" onClick={() => void home.refetch()}>
            Try again
          </Button>
        </div>
      </>
    );
  }

  const feed = home.data;
  // The backend sends the amenity summary ONLY in the empty state (nothing
  // upcoming, no reservation invitations); its presence selects the layout.
  const isEmpty = feed.amenities !== null;
  const hasUpcoming =
    feed.pendingInvitations.length > 0 || feed.upcomingReservations.length > 0;
  // On wide screens the feed splits into a main column and a right-hand
  // Spotlight events rail; with no events there is nothing to rail, so the
  // feed stays a single column.
  const hasRail = feed.spotlightEvents.length > 0;

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow={isEmpty ? 'Welcome,' : GREETINGS[feed.greeting.timeOfDay]}
        title={feed.greeting.firstName}
        headingRef={pageHeadingRef}
        actions={
          <button
            type="button"
            className={styles.qrButton}
            aria-label="Show membership card"
            aria-haspopup="dialog"
            onClick={() => setQrOpen(true)}
          >
            <QrCode aria-hidden />
          </button>
        }
      />

      <div className={hasRail ? styles.feedGrid : styles.feedFlow}>
        <div className={styles.feedMain}>
          {feed.amenities !== null ? (
            <>
              <FirstSessionBanner />
              <HomeSection id="home-reserve-play" title="Reserve play">
                <ul className={styles.cardStack}>
                  {feed.amenities.map((amenity) => (
                    <li key={amenity.typeCode}>
                      <AmenityRow amenity={amenity} />
                    </li>
                  ))}
                </ul>
              </HomeSection>
            </>
          ) : (
            <>
              {feed.quickBook && (
                <HomeSection id="home-quick-book" title="Quick book">
                  <QuickBookCard suggestion={feed.quickBook} />
                </HomeSection>
              )}

              {hasUpcoming ? (
                <HomeSection
                  id="home-upcoming"
                  title="Upcoming reservations"
                  headingRef={upcomingHeadingRef}
                >
                  <ul className={styles.cardStack}>
                    {feed.pendingInvitations.map((reservation) => (
                      <li key={reservation.id}>
                        <InvitationCard
                          reservation={reservation}
                          onRespond={respondToInvitation}
                          pendingResponse={
                            respond.isPending && respond.variables.reservationId === reservation.id
                              ? respond.variables.response
                              : null
                          }
                        />
                      </li>
                    ))}
                    {feed.upcomingReservations.map((reservation) => (
                      <li key={reservation.id}>
                        <UpcomingCard reservation={reservation} />
                      </li>
                    ))}
                  </ul>
                </HomeSection>
              ) : (
                // Transient client-side gap only: the last invitation was just
                // declined optimistically and the refetch (which brings the
                // amenity empty state) has not landed yet.
                <EmptyState
                  icon={<CalendarDays aria-hidden />}
                  title="Nothing coming up"
                  description="Book a court or amenity to get back on the schedule."
                  action={<ButtonLink to="/reserve">Reserve play</ButtonLink>}
                />
              )}
            </>
          )}

          {feed.clubInvitations.length > 0 && (
            <HomeSection id="home-club-invites" title="Club invitations" headingRef={clubsHeadingRef}>
              <ul className={styles.cardStack}>
                {feed.clubInvitations.map((invitation) => (
                  <li key={invitation.id}>
                    <ClubInvitationCard
                      invitation={invitation}
                      onRespond={respondToClubInvitation}
                      pendingResponse={
                        clubRespond.isPending && clubRespond.variables.invitationId === invitation.id
                          ? clubRespond.variables.response
                          : null
                      }
                    />
                  </li>
                ))}
              </ul>
            </HomeSection>
          )}
        </div>

        {hasRail && (
          <div className={styles.feedRail}>
            <HomeSection id="home-events" title="Spotlight events">
              {/* The list itself is the horizontal scroller; it takes focus so
                  keyboard users can scroll it with the arrow keys. */}
              <ul className={styles.eventList} aria-label="Spotlight events" tabIndex={0}>
                {feed.spotlightEvents.map((event) => (
                  <EventCard key={event.id} event={event} />
                ))}
              </ul>
            </HomeSection>
          </div>
        )}
      </div>

      <MemberQrSheet
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        memberName={`${feed.member.firstName} ${feed.member.lastName}`}
        memberNumber={feed.member.memberNumber}
      />
    </div>
  );
}

function HomeSection({
  id,
  title,
  headingRef,
  children,
}: {
  id: string;
  title: string;
  headingRef?: Ref<HTMLHeadingElement>;
  children: ReactNode;
}) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} tabIndex={-1} ref={headingRef}>
        {title}
      </h2>
      {children}
    </section>
  );
}

// ── Quick book ──

function QuickBookCard({ suggestion }: { suggestion: QuickBookSuggestion }) {
  // The wizard does not read a date/slot prefill yet (W3 follow-up, see
  // docs/w2-home-notes.md); the params are forward-compatible and harmless.
  const bookHref =
    `/reserve/${encodeURIComponent(suggestion.typeCode)}` +
    `?${new URLSearchParams({ date: suggestion.date, start: suggestion.startTime, end: suggestion.endTime })}`;

  return (
    <ReservationCard
      typeCode={suggestion.typeCode}
      typeName={suggestion.typeName}
      resourceName={
        <>
          {formatDateCompact(suggestion.date)} ·{' '}
          <span className={styles.nowrap}>
            {formatTimeRangeCompact(suggestion.startTime, suggestion.endTime)}
          </span>
        </>
      }
      rows={[]}
      header={
        <p className={styles.aiLine}>
          <Sparkles aria-hidden className={styles.aiIcon} />
          <span className={styles.aiTag}>AI suggestion</span>
          <span className={styles.aiReason}>{suggestion.reason}</span>
        </p>
      }
      badge={
        <Link
          to={bookHref}
          className={styles.bookNow}
          aria-label={`Book ${suggestion.typeName} on ${formatDateLong(suggestion.date)}, ${formatTimeRangeCompact(suggestion.startTime, suggestion.endTime)}`}
        >
          Book now <ArrowRight aria-hidden />
        </Link>
      }
    />
  );
}

// ── Upcoming reservations ──

/** Confirmed + pending players, the count the Figma cards show. */
function playerCountLabel(reservation: Reservation): string {
  const count = reservation.participants.filter(
    (row) => row.status === 'confirmed' || row.status === 'pending',
  ).length;
  return count === 1 ? '1 player' : `${count} players`;
}

function UpcomingCard({ reservation }: { reservation: Reservation }) {
  const isGuest = reservation.myParticipation?.role === 'guest';
  return (
    <Link to={`/reservations/${reservation.id}`} className={styles.cardLink}>
      <ReservationCard
        typeCode={reservation.typeCode}
        typeName={reservation.typeName}
        resourceName={`${reservation.resource.name} · ${playerCountLabel(reservation)}`}
        badge={
          <>
            {isGuest && <Badge variant="success">Accepted</Badge>}
            {reservation.weekly && (
              <span className={styles.weeklyChip}>
                <RefreshCw aria-hidden />
                Weekly
              </span>
            )}
          </>
        }
        rows={[
          { label: 'Date', value: formatDateLong(reservation.date) },
          {
            label: 'Time',
            value: (
              <span className={styles.nowrap}>
                {formatTimeRangeCompact(reservation.startTime, reservation.endTime)}
              </span>
            ),
          },
        ]}
      />
    </Link>
  );
}

// ── Pending reservation invitations (inline Accept / Decline) ──

function InvitationCard({
  reservation,
  onRespond,
  pendingResponse,
}: {
  reservation: Reservation;
  onRespond: (reservation: Reservation, response: 'accept' | 'decline') => void;
  /** Which response is in flight for THIS card (drives the spinner). */
  pendingResponse: 'accept' | 'decline' | null;
}) {
  const inviter = reservation.myParticipation?.invitedByFirstName ?? null;
  const respondWith = (response: 'accept' | 'decline') => onRespond(reservation, response);

  return (
    <ReservationCard
      typeCode={reservation.typeCode}
      typeName={reservation.typeName}
      rows={[]}
      header={
        <p className={styles.inviterLine}>
          <span className={styles.inviterName}>{inviter ?? 'A member'}</span> invited you
        </p>
      }
    >
      <p className={styles.inviteMeta}>
        {formatDateCompact(reservation.date)} ·{' '}
        <span className={styles.nowrap}>
          {formatTimeRangeCompact(reservation.startTime, reservation.endTime)}
        </span>{' '}
        · {playerCountLabel(reservation)}
      </p>
      <div
        className={styles.respondRow}
        role="group"
        aria-label={`Respond to ${inviter ? `${inviter}'s` : 'this'} invitation`}
      >
        <Button
          fullWidth
          loading={pendingResponse === 'accept'}
          disabled={pendingResponse !== null}
          onClick={() => respondWith('accept')}
        >
          Accept
        </Button>
        <Button
          variant="secondary"
          fullWidth
          loading={pendingResponse === 'decline'}
          disabled={pendingResponse !== null}
          onClick={() => respondWith('decline')}
        >
          Decline
        </Button>
      </div>
    </ReservationCard>
  );
}

// ── Club invitations ──

function ClubInvitationCard({
  invitation,
  onRespond,
  pendingResponse,
}: {
  invitation: ClubInvitation;
  onRespond: (invitation: ClubInvitation, response: 'accept' | 'decline') => void;
  /** Which response is in flight for THIS card (drives the spinner). */
  pendingResponse: 'accept' | 'decline' | null;
}) {
  const inviter = invitation.invitedBy?.firstName ?? null;
  const memberCount =
    invitation.club.memberCount === 1 ? '1 member' : `${invitation.club.memberCount} members`;
  const respondWith = (response: 'accept' | 'decline') => onRespond(invitation, response);

  return (
    <Card className={styles.clubCard}>
      <p className={styles.inviterLine}>
        <span className={styles.inviterName}>{inviter ?? 'A member'}</span> invited you
      </p>
      <div className={styles.clubHead}>
        <IconTile>
          <Users aria-hidden />
        </IconTile>
        <div className={styles.clubHeadText}>
          <span className={styles.clubName}>{invitation.club.name}</span>
          <span className={styles.clubMeta}>{memberCount}</span>
        </div>
      </div>
      <div
        className={styles.respondRow}
        role="group"
        aria-label={`Respond to the ${invitation.club.name} invitation`}
      >
        <Button
          fullWidth
          loading={pendingResponse === 'accept'}
          disabled={pendingResponse !== null}
          onClick={() => respondWith('accept')}
        >
          Accept
        </Button>
        <Button
          variant="secondary"
          fullWidth
          loading={pendingResponse === 'decline'}
          disabled={pendingResponse !== null}
          onClick={() => respondWith('decline')}
        >
          Decline
        </Button>
      </div>
    </Card>
  );
}

// ── Spotlight events ──

function eventDateLabel(event: SpotlightEvent): string {
  const date = new Date(event.startsAt);
  try {
    const weekday = date.toLocaleDateString('en-US', {
      weekday: 'long',
      timeZone: event.timezone,
    });
    const monthDay = date.toLocaleDateString('en-US', {
      month: 'numeric',
      day: 'numeric',
      timeZone: event.timezone,
    });
    return `${weekday}, ${monthDay}`;
  } catch {
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'numeric', day: 'numeric' });
  }
}

function eventTimeLabel(event: SpotlightEvent): string {
  const format = (iso: string) => {
    const date = new Date(iso);
    try {
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: event.timezone,
      });
    } catch {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
  };
  return `${format(event.startsAt)} - ${format(event.endsAt)}`;
}

function EventCard({ event }: { event: SpotlightEvent }) {
  return (
    <li className={styles.eventCard}>
      {event.imageUrl ? (
        <img className={styles.eventImage} src={event.imageUrl} alt="" loading="lazy" />
      ) : (
        <div className={[styles.eventImage, styles.eventImageFallback].join(' ')} aria-hidden>
          <CalendarDays />
        </div>
      )}
      <div className={styles.eventShade} aria-hidden />
      <div className={styles.eventText}>
        <p className={styles.eventTitle}>{event.title}</p>
        <p className={styles.eventWhen}>
          {eventDateLabel(event)}
          <br />
          {eventTimeLabel(event)}
        </p>
      </div>
    </li>
  );
}

// ── Empty state ──

function FirstSessionBanner() {
  return (
    <Card className={styles.firstSession}>
      <p className={styles.firstSessionTitle}>
        <CalendarPlus aria-hidden />
        Book your first session
      </p>
      <p className={styles.firstSessionCopy}>
        Ready to play? Book your first session or check out upcoming club events below
      </p>
    </Card>
  );
}

function AmenityRow({ amenity }: { amenity: HomeAmenitySummary }) {
  const subtitle = `${availabilityCountLabel(amenity.typeName, amenity.resourceCount)} · ${formatAmount(amenity.hourlyRateCents)}/hr`;

  return (
    <ListRow
      leading={
        <IconTile>
          <ResourceTypeIcon code={amenity.typeCode} />
        </IconTile>
      }
      title={amenity.typeName}
      subtitle={subtitle}
      trailing={
        amenity.locked ? (
          <span className={styles.amenityLocked}>
            <Lock aria-hidden />
            <span className="visually-hidden">Requires a PRO membership</span>
          </span>
        ) : (
          <ButtonLink
            size="sm"
            to={`/reserve/${encodeURIComponent(amenity.typeCode)}`}
            aria-label={`Book ${amenity.typeName}`}
          >
            Book
          </ButtonLink>
        )
      }
    />
  );
}
