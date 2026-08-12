import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import type { ClubInvitation, QuickBookSuggestion, Reservation } from '../../lib/api';
import {
  AppScreen,
  EmptyStateView,
  EventSpotlightCard,
  MemberCardSheet,
  PrimaryButton,
  Skeleton,
  useToast,
} from '../../components';
import { dateKeyToDate } from '../reserve';
import { isRespondConflict, useRespondToReservation } from '../reservations';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { homeQuery, isClubInviteConflict, useRespondToClubInvitation } from './home-data';
import { greetingEyebrow, homeLayout } from './home-sections';
import {
  AmenityRow,
  ClubInvitationCard,
  FirstSessionBanner,
  HomeSection,
  InvitationCard,
  QuickBookCard,
  UpcomingReservationCard,
  type RespondResponse,
} from './HomeCards';

/** "August 26" for the accept toast (no year, per the Figma). */
function monthDayLabel(dateKey: string): string {
  return dateKeyToDate(dateKey).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

/**
 * The home feed (package M2; Figma home/default 68:1105, home/empty-state
 * 174:16152, home-with-invitation 325:14393, member-card 107:9461): greeting +
 * member QR entry, the quick-book suggestion, upcoming reservations with inline
 * invitation cards, club invitations, spotlight events, and the first-session
 * empty state. One aggregated read (GET /api/me/home) feeds every section.
 * Mirrors member-web's HomePage, native.
 */
export function HomeScreen() {
  const home = useQuery(homeQuery);
  const router = useRouter();
  const { toast } = useToast();
  const [cardOpen, setCardOpen] = useState(false);

  // Both respond mutations live at the screen level: the pressed card unmounts
  // with the optimistic write (accepting moves the invitation into upcoming;
  // declining removes it), and mutate-time callbacks (the outcome toasts) are
  // dropped for unmounted callers.
  const respond = useRespondToReservation();
  const clubRespond = useRespondToClubInvitation();

  const openReservation = useCallback(
    (id: string) => router.push(`/reservations/${id}` as never),
    [router],
  );

  // "Book now" / "Book" deep-link into M3's wizard for the suggested type. The
  // wizard reads only `typeCode` today; date/start/end are forward-compatible
  // (the wizard opens on that amenity with today selected). See the M3 prefill
  // follow-up in docs/club70-mobile-plan.md.
  const bookSuggestion = useCallback(
    (suggestion: QuickBookSuggestion) => {
      router.push({
        pathname: '/reserve/[typeCode]',
        params: {
          typeCode: suggestion.typeCode,
          date: suggestion.date,
          start: suggestion.startTime,
          end: suggestion.endTime,
        },
      });
    },
    [router],
  );

  const bookAmenity = useCallback(
    (typeCode: string) => router.push({ pathname: '/reserve/[typeCode]', params: { typeCode } }),
    [router],
  );

  const respondToInvitation = useCallback(
    (reservation: Reservation, response: RespondResponse) => {
      respond.mutate(
        { reservationId: reservation.id, response },
        {
          onSuccess: ({ status }) => {
            toast({
              variant: 'success',
              message:
                status === 'confirmed'
                  ? `Invite accepted! See you ${monthDayLabel(reservation.date)}.`
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
    [respond, toast],
  );

  const respondToClub = useCallback(
    (invitation: ClubInvitation, response: RespondResponse) => {
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
    [clubRespond, toast],
  );

  if (home.isPending) {
    return <HomeSkeleton />;
  }

  if (home.isError) {
    return (
      <AppScreen>
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>We could not load your home feed.</Text>
          <View style={styles.errorAction}>
            <PrimaryButton label="Try again" variant="secondary" onPress={() => void home.refetch()} />
          </View>
        </View>
      </AppScreen>
    );
  }

  const feed = home.data;
  const layout = homeLayout(feed);

  const invitationPending = (id: string): RespondResponse | null =>
    respond.isPending && respond.variables?.reservationId === id ? respond.variables.response : null;
  const clubPending = (id: string): RespondResponse | null =>
    clubRespond.isPending && clubRespond.variables?.invitationId === id
      ? clubRespond.variables.response
      : null;

  return (
    <AppScreen onRefresh={() => void home.refetch()} refreshing={home.isRefetching}>
      <GreetingHeader
        eyebrow={greetingEyebrow(feed.greeting.timeOfDay, layout.isEmpty)}
        name={feed.greeting.firstName}
        onOpenCard={() => setCardOpen(true)}
      />

      {layout.isEmpty && feed.amenities ? (
        <>
          <FirstSessionBanner />
          <HomeSection title="Reserve play">
            <View style={styles.stack}>
              {feed.amenities.map((amenity) => (
                <AmenityRow key={amenity.typeCode} amenity={amenity} onBook={bookAmenity} />
              ))}
            </View>
          </HomeSection>
        </>
      ) : (
        <>
          {layout.showQuickBook && feed.quickBook ? (
            <HomeSection title="Quick book">
              <QuickBookCard suggestion={feed.quickBook} onBook={bookSuggestion} />
            </HomeSection>
          ) : null}

          {layout.hasUpcoming ? (
            <HomeSection title="Upcoming reservations">
              <View style={styles.stack}>
                {feed.pendingInvitations.map((reservation) => (
                  <InvitationCard
                    key={reservation.id}
                    reservation={reservation}
                    onRespond={respondToInvitation}
                    pendingResponse={invitationPending(reservation.id)}
                  />
                ))}
                {feed.upcomingReservations.map((reservation) => (
                  <UpcomingReservationCard
                    key={reservation.id}
                    reservation={reservation}
                    onPress={openReservation}
                  />
                ))}
              </View>
            </HomeSection>
          ) : (
            // Transient client-side gap only: the last invitation was just
            // declined optimistically and the refetch (which brings the amenity
            // empty state) has not landed yet.
            <EmptyStateView
              title="Nothing coming up"
              description="Book a court or amenity to get back on the schedule."
            />
          )}
        </>
      )}

      {layout.showClubInvitations ? (
        <HomeSection title="Club invitations">
          <View style={styles.stack}>
            {feed.clubInvitations.map((invitation) => (
              <ClubInvitationCard
                key={invitation.id}
                invitation={invitation}
                onRespond={respondToClub}
                pendingResponse={clubPending(invitation.id)}
              />
            ))}
          </View>
        </HomeSection>
      ) : null}

      {layout.showSpotlight ? (
        <HomeSection title="Spotlight events">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.railBleed}
            contentContainerStyle={styles.railContent}
            accessibilityLabel="Spotlight events"
          >
            {feed.spotlightEvents.map((event) => (
              <EventSpotlightCard key={event.id} event={event} />
            ))}
          </ScrollView>
        </HomeSection>
      ) : null}

      <MemberCardSheet
        open={cardOpen}
        onClose={() => setCardOpen(false)}
        memberName={`${feed.member.firstName} ${feed.member.lastName}`}
        memberNumber={feed.member.memberNumber}
      />
    </AppScreen>
  );
}

function GreetingHeader({
  eyebrow,
  name,
  onOpenCard,
}: {
  eyebrow: string;
  name: string;
  onOpenCard: () => void;
}) {
  return (
    <View style={styles.greeting}>
      <View style={styles.greetingText}>
        <Text style={styles.eyebrow}>{eyebrow}</Text>
        <Text style={styles.name} accessibilityRole="header" numberOfLines={1}>
          {name}
        </Text>
      </View>
      <Pressable
        onPress={onOpenCard}
        accessibilityRole="button"
        accessibilityLabel="Show membership card"
        style={({ pressed }) => [styles.qrButton, pressed ? styles.qrButtonPressed : null]}
      >
        <Ionicons name="qr-code" size={24} color={colors.textOnAccent} />
      </Pressable>
    </View>
  );
}

function HomeSkeleton() {
  return (
    <AppScreen>
      <View style={styles.greeting} accessibilityRole="progressbar" accessibilityLabel="Loading your home feed">
        <View style={styles.greetingText}>
          <Skeleton width={96} height={16} />
          <Skeleton width={168} height={34} />
        </View>
        <Skeleton width={44} height={44} borderRadius={radius.md} />
      </View>
      <Skeleton height={120} borderRadius={radius.lg} />
      <Skeleton height={140} borderRadius={radius.lg} />
      <Skeleton height={140} borderRadius={radius.lg} />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  greeting: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  greetingText: {
    flex: 1,
    gap: spacing.xs,
  },
  eyebrow: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  name: {
    color: colors.text,
    fontFamily: fonts.displayHeavy,
    fontSize: 30,
    lineHeight: 36,
  },
  qrButton: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrButtonPressed: {
    opacity: 0.9,
  },
  stack: {
    gap: spacing.md,
  },
  railBleed: {
    marginHorizontal: -spacing.md,
  },
  railContent: {
    paddingHorizontal: spacing.md,
    gap: spacing.md,
  },
  errorBox: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    alignItems: 'center',
  },
  errorText: {
    color: colors.text,
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
    textAlign: 'center',
  },
  errorAction: {
    alignSelf: 'stretch',
  },
});
