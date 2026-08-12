import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ClubInvitation, HomeAmenitySummary, QuickBookSuggestion, Reservation } from '../../lib/api';
import { Badge, IconTile, ListRow, PrimaryButton } from '../../components';
import {
  ReservationSummaryCard,
  ResourceTypeIcon,
  availabilityCountLabel,
  dateKeyToDate,
  formatAmount,
  formatDateFull,
  formatDateLong,
  formatTimeRangeCompact,
} from '../reserve';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { playerCountLabel } from './home-sections';

export type RespondResponse = 'accept' | 'decline';

/** "Sun 7/26" (weekday short + numeric month/day), the Figma card date style. */
function formatShortDate(dateKey: string): string {
  const date = dateKeyToDate(dateKey);
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });
  return `${weekday} ${date.getMonth() + 1}/${date.getDate()}`;
}

// ── Section heading ──

export function HomeSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

// ── Quick book ──

export function QuickBookCard({
  suggestion,
  onBook,
}: {
  suggestion: QuickBookSuggestion;
  onBook: (suggestion: QuickBookSuggestion) => void;
}) {
  const when = `${formatShortDate(suggestion.date)} · ${formatTimeRangeCompact(
    suggestion.startTime,
    suggestion.endTime,
  )}`;
  return (
    <ReservationSummaryCard
      typeCode={suggestion.typeCode}
      typeName={suggestion.typeName}
      resourceName={when}
      rows={[]}
      header={
        <View style={styles.aiLine}>
          <Ionicons name="sparkles" size={14} color={colors.accent} />
          <Text style={styles.aiTag}>AI SUGGESTION</Text>
          <Text style={styles.aiReason} numberOfLines={1}>
            {suggestion.reason}
          </Text>
        </View>
      }
      trailing={
        <Pressable
          onPress={() => onBook(suggestion)}
          accessibilityRole="button"
          accessibilityLabel={`Book ${suggestion.typeName} on ${formatDateFull(suggestion.date)}, ${formatTimeRangeCompact(
            suggestion.startTime,
            suggestion.endTime,
          )}`}
          style={({ pressed }) => [styles.bookNow, pressed ? styles.pressed : null]}
        >
          <Text style={styles.bookNowText}>Book now</Text>
          <Ionicons name="arrow-forward" size={15} color={colors.accent} />
        </Pressable>
      }
    />
  );
}

// ── Upcoming reservation ──

export function UpcomingReservationCard({
  reservation,
  onPress,
}: {
  reservation: Reservation;
  onPress: (id: string) => void;
}) {
  const isGuest = reservation.myParticipation?.role === 'guest';
  return (
    <Pressable
      onPress={() => onPress(reservation.id)}
      accessibilityRole="button"
      accessibilityLabel={`${reservation.typeName} on ${formatDateLong(reservation.date)}, ${formatTimeRangeCompact(
        reservation.startTime,
        reservation.endTime,
      )}`}
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      <ReservationSummaryCard
        typeCode={reservation.typeCode}
        typeName={reservation.typeName}
        resourceName={`${reservation.resource.name} · ${playerCountLabel(reservation)}`}
        trailing={
          <View style={styles.badges}>
            {isGuest ? <Badge label="Accepted" variant="success" /> : null}
            {reservation.weekly ? (
              <View style={styles.weeklyChip}>
                <Ionicons name="refresh" size={12} color={colors.accent} />
                <Text style={styles.weeklyText}>Weekly</Text>
              </View>
            ) : null}
          </View>
        }
        rows={[
          { label: 'Date', value: formatDateLong(reservation.date) },
          { label: 'Time', value: formatTimeRangeCompact(reservation.startTime, reservation.endTime) },
        ]}
      />
    </Pressable>
  );
}

// ── Pending reservation invitation (inline Accept / Decline) ──

export function InvitationCard({
  reservation,
  onRespond,
  pendingResponse,
}: {
  reservation: Reservation;
  onRespond: (reservation: Reservation, response: RespondResponse) => void;
  /** Which response is in flight for THIS card (drives the spinner). */
  pendingResponse: RespondResponse | null;
}) {
  const inviter = reservation.myParticipation?.invitedByFirstName ?? null;
  const meta = `${formatShortDate(reservation.date)} · ${formatTimeRangeCompact(
    reservation.startTime,
    reservation.endTime,
  )} · ${playerCountLabel(reservation)}`;
  return (
    <ReservationSummaryCard
      typeCode={reservation.typeCode}
      typeName={reservation.typeName}
      rows={[]}
      header={<InviterLine name={inviter} />}
    >
      <Text style={styles.inviteMeta}>{meta}</Text>
      <RespondRow
        acceptLabel="Accept invitation"
        declineLabel="Decline invitation"
        pendingResponse={pendingResponse}
        onRespond={(response) => onRespond(reservation, response)}
      />
    </ReservationSummaryCard>
  );
}

// ── Club invitation (inline Accept / Decline) ──

export function ClubInvitationCard({
  invitation,
  onRespond,
  pendingResponse,
}: {
  invitation: ClubInvitation;
  onRespond: (invitation: ClubInvitation, response: RespondResponse) => void;
  pendingResponse: RespondResponse | null;
}) {
  const inviter = invitation.invitedBy?.firstName ?? null;
  const memberCount =
    invitation.club.memberCount === 1 ? '1 member' : `${invitation.club.memberCount} members`;
  return (
    <View style={styles.clubCard}>
      <InviterLine name={inviter} />
      <View style={styles.clubHead}>
        <IconTile>
          <Ionicons name="people-outline" size={22} color={colors.accent} />
        </IconTile>
        <View style={styles.clubHeadText}>
          <Text style={styles.clubName} numberOfLines={1}>
            {invitation.club.name}
          </Text>
          <Text style={styles.clubMeta}>{memberCount}</Text>
        </View>
      </View>
      <RespondRow
        acceptLabel={`Accept the ${invitation.club.name} invitation`}
        declineLabel={`Decline the ${invitation.club.name} invitation`}
        pendingResponse={pendingResponse}
        onRespond={(response) => onRespond(invitation, response)}
      />
    </View>
  );
}

// ── Shared invitation bits ──

function InviterLine({ name }: { name: string | null }) {
  return (
    <View style={styles.inviterLine}>
      <Ionicons name="person-outline" size={13} color={colors.accent} />
      <Text style={styles.inviterName}>{(name ?? 'A member').toUpperCase()}</Text>
      <Text style={styles.inviterSuffix}>invited you</Text>
    </View>
  );
}

function RespondRow({
  acceptLabel,
  declineLabel,
  pendingResponse,
  onRespond,
}: {
  acceptLabel: string;
  declineLabel: string;
  pendingResponse: RespondResponse | null;
  onRespond: (response: RespondResponse) => void;
}) {
  const busy = pendingResponse !== null;
  return (
    <View style={styles.respondRow}>
      <View style={styles.respondButton}>
        <PrimaryButton
          label="Accept"
          accessibilityLabel={acceptLabel}
          variant="primary"
          loading={pendingResponse === 'accept'}
          disabled={busy && pendingResponse !== 'accept'}
          onPress={() => onRespond('accept')}
        />
      </View>
      <View style={styles.respondButton}>
        <PrimaryButton
          label="Decline"
          accessibilityLabel={declineLabel}
          variant="ghost"
          loading={pendingResponse === 'decline'}
          disabled={busy && pendingResponse !== 'decline'}
          onPress={() => onRespond('decline')}
        />
      </View>
    </View>
  );
}

// ── Empty state ──

export function FirstSessionBanner() {
  return (
    <View style={styles.banner}>
      <View style={styles.bannerTitleRow}>
        <Ionicons name="calendar-outline" size={16} color={colors.accent} />
        <Text style={styles.bannerTitle}>BOOK YOUR FIRST SESSION</Text>
      </View>
      <Text style={styles.bannerCopy}>
        Ready to play? Book your first session or check out upcoming club events below.
      </Text>
    </View>
  );
}

export function AmenityRow({
  amenity,
  onBook,
}: {
  amenity: HomeAmenitySummary;
  onBook: (typeCode: string) => void;
}) {
  const subtitle = `${availabilityCountLabel(amenity.typeName, amenity.resourceCount)} · ${formatAmount(
    amenity.hourlyRateCents,
  )}/hr`;
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
          <View
            style={styles.lockedTag}
            accessibilityRole="text"
            accessibilityLabel="Requires a PRO membership"
          >
            <Ionicons name="lock-closed" size={14} color={colors.textMuted} />
          </View>
        ) : (
          <Pressable
            onPress={() => onBook(amenity.typeCode)}
            accessibilityRole="button"
            accessibilityLabel={`Book ${amenity.typeName}`}
            style={({ pressed }) => [styles.bookPill, pressed ? styles.pressed : null]}
          >
            <Text style={styles.bookPillText}>Book</Text>
          </Pressable>
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 20,
  },
  // ── Quick book ──
  aiLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexWrap: 'wrap',
  },
  aiTag: {
    color: colors.accent,
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    letterSpacing: 0.8,
  },
  aiReason: {
    flexShrink: 1,
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 12,
  },
  bookNow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  bookNowText: {
    color: colors.accent,
    fontFamily: fonts.bodyBold,
    fontSize: 14,
  },
  // ── Upcoming ──
  badges: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  weeklyChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(236, 254, 170, 0.16)',
  },
  weeklyText: {
    color: colors.accent,
    fontFamily: fonts.bodyBold,
    fontSize: 11,
    letterSpacing: 0.4,
  },
  // ── Invitation ──
  inviterLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  inviterName: {
    color: colors.accent,
    fontFamily: fonts.bodyBold,
    fontSize: 12,
    letterSpacing: 0.6,
  },
  inviterSuffix: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  inviteMeta: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  respondRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  respondButton: {
    flex: 1,
  },
  // ── Club invitation ──
  clubCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.md,
  },
  clubHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  clubHeadText: {
    flex: 1,
    gap: 2,
  },
  clubName: {
    color: colors.text,
    fontFamily: fonts.displaySemibold,
    fontSize: 17,
  },
  clubMeta: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  // ── Empty state ──
  banner: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  bannerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  bannerTitle: {
    color: colors.accent,
    fontFamily: fonts.bodyBold,
    fontSize: 12,
    letterSpacing: 0.8,
  },
  bannerCopy: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 18,
  },
  lockedTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  bookPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  bookPillText: {
    color: colors.textOnAccent,
    fontFamily: fonts.bodyBold,
    fontSize: 13,
  },
  pressed: {
    opacity: 0.9,
  },
});
