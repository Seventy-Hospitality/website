import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import {
  api,
  ApiError,
  type Reservation,
  type ReservationParticipant,
  type ReservationParticipantStatus,
  type ReservationViewer,
} from '../../lib/api';
import { useSession } from '../../lib/session';
import {
  Avatar,
  Badge,
  EmptyStateView,
  participantStatusVariant,
  PrimaryButton,
  Sheet,
  Skeleton,
  useToast,
} from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import {
  bookingRefLabel,
  formatAmountWithCents,
  formatDateLong,
  formatDuration,
  formatTimeRangeCompact,
} from '../reserve/booking';
import { memberDisplayName } from '../reserve/invites';
import { ReservationSummaryCard } from '../reserve/ReservationSummaryCard';
import {
  cancelRefundPreview,
  hasReservationStarted,
  isActiveReservationStatus,
} from './reservation-policy';
import { reservationQuery } from './reservations-data';
import { isRespondConflict, useRespondToReservation } from './useRespondToReservation';

type ReservationDetail = Reservation & { viewer: ReservationViewer };

const STATUS_LABELS: Record<ReservationParticipantStatus, string> = {
  confirmed: 'Confirmed',
  pending: 'Pending',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

/**
 * Reservation detail (Figma reservation-details 225:3330 / 225:3586 /
 * 159:13854): the booking card, the PLAYERS roster with per-player status
 * badges, and actions driven by the backend's viewer capabilities:
 *
 * - organizer: Edit reservation / Cancel reservation / Invite, plus a
 *   per-player overflow (remove, re-invite);
 * - invited guest (own row pending): ACCEPT / DECLINE pills;
 * - accepted guest: "Decline reservation" (withdraw, with confirmation).
 */
export function ReservationDetailScreen({ reservationId }: { reservationId: string }) {
  const detail = useQuery(reservationQuery(reservationId));

  if (detail.isPending) {
    return (
      <DetailFrame>
        <View accessibilityLabel="Loading reservation" style={styles.loading}>
          <Skeleton height={132} borderRadius={radius.lg} />
          <Skeleton height={220} borderRadius={radius.lg} />
        </View>
      </DetailFrame>
    );
  }

  if (detail.isError) {
    const error = detail.error;
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      // The backend answers 404 for outsiders on purpose (a reservation you
      // are not part of looks exactly like one that does not exist).
      return (
        <DetailFrame>
          <EmptyStateView
            title="Reservation not found"
            description="This reservation does not exist, was removed, or you are not part of it."
          />
          <BackToHomeButton />
        </DetailFrame>
      );
    }
    return (
      <DetailFrame>
        <View style={styles.banner} accessibilityRole="alert">
          <Text style={styles.bannerText}>We could not load this reservation.</Text>
          <PrimaryButton label="Try again" variant="secondary" onPress={() => void detail.refetch()} />
        </View>
      </DetailFrame>
    );
  }

  return <ReservationDetailView detail={detail.data as ReservationDetail} />;
}

function DetailFrame({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const goHome = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to home"
          onPress={goHome}
          hitSlop={8}
          style={styles.backLink}
        >
          <Ionicons name="chevron-back" size={18} color={colors.textLink} />
          <Text style={styles.backLinkText}>Back to home</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>
          Reservation details
        </Text>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

function BackToHomeButton() {
  const router = useRouter();
  return (
    <View style={styles.emptyAction}>
      <PrimaryButton
        label="Back to home"
        onPress={() => router.replace('/(tabs)')}
      />
    </View>
  );
}

function ReservationDetailView({ detail }: { detail: ReservationDetail }) {
  const { memberId } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [playerMenu, setPlayerMenu] = useState<ReservationParticipant | null>(null);

  const viewer = detail.viewer;
  const active = isActiveReservationStatus(detail.status);
  const started = hasReservationStarted(detail);
  const myStatus = detail.participants.find((row) => row.memberId === memberId)?.status ?? null;

  const respond = useRespondToReservation();

  function respondWith(response: 'accept' | 'decline') {
    respond.mutate(
      { reservationId: detail.id, response },
      {
        onSuccess: ({ status }) => {
          toast({
            variant: 'success',
            message:
              status === 'confirmed'
                ? 'Invitation accepted. You are confirmed for this booking.'
                : status === 'withdrawn'
                  ? 'You have declined this booking and given up your spot.'
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
  }

  const cancelMutation = useMutation({
    mutationFn: () => api.cancelReservation(detail.id),
    onSuccess: ({ refundCents }) => {
      setCancelOpen(false);
      queryClient.setQueryData(['reservations', detail.id], {
        ...detail,
        status: 'cancelled' as const,
      });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      void queryClient.invalidateQueries({ queryKey: ['availability', detail.typeCode] });
      toast({
        variant: 'success',
        message:
          refundCents > 0
            ? `Reservation cancelled. ${formatAmountWithCents(refundCents)} will be refunded to your card.`
            : 'Reservation cancelled.',
      });
    },
    onError: (error) => {
      setCancelOpen(false);
      if (error instanceof ApiError && error.code === 'ALREADY_STARTED') {
        toast({
          variant: 'error',
          message: 'This booking has already started and can no longer be cancelled.',
        });
      } else if (error instanceof ApiError && (error.code === 'INVALID_STATUS' || error.status === 404)) {
        toast({ variant: 'error', message: 'This reservation has already been resolved.' });
        void queryClient.invalidateQueries({ queryKey: ['reservations', detail.id] });
      } else {
        toast({ variant: 'error', message: 'We could not cancel this reservation. Try again.' });
      }
    },
  });

  const removeMutation = useMutation({
    mutationFn: (target: ReservationParticipant) => api.removeParticipant(detail.id, target.memberId),
    onSuccess: (_result, target) => {
      setPlayerMenu(null);
      queryClient.setQueryData(['reservations', detail.id], {
        ...detail,
        participants: detail.participants.filter((row) => row.memberId !== target.memberId),
      });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      toast({ variant: 'success', message: `${memberDisplayName(target)} was removed.` });
    },
    onError: () => {
      setPlayerMenu(null);
      toast({ variant: 'error', message: 'We could not remove that player. Try again.' });
      void queryClient.invalidateQueries({ queryKey: ['reservations', detail.id] });
    },
  });

  const reinviteMutation = useMutation({
    mutationFn: (target: ReservationParticipant) =>
      api.addParticipants(detail.id, { memberIds: [target.memberId] }),
    onSuccess: (_result, target) => {
      setPlayerMenu(null);
      queryClient.setQueryData(['reservations', detail.id], {
        ...detail,
        participants: detail.participants.map((row) =>
          row.memberId === target.memberId ? { ...row, status: 'pending' as const } : row,
        ),
      });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      toast({ variant: 'success', message: `Invite sent to ${memberDisplayName(target)}.` });
    },
    onError: () => {
      setPlayerMenu(null);
      toast({ variant: 'error', message: 'We could not send that invite. Try again.' });
    },
  });

  const refund = cancelRefundPreview(detail);
  // Mirror the backend's own gate (canManageInvites AND isActive): an
  // optimistic status write (cancel) leaves viewer.canInvite stale-true until
  // the refetch, so re-derive the status half.
  const canInvite = viewer.canInvite && active;

  return (
    <DetailFrame>
      {detail.status === 'cancelled' ? (
        <StatusBanner tone="danger" text="This reservation was cancelled." />
      ) : null}
      {detail.status === 'expired' ? (
        <StatusBanner tone="danger" text="This booking expired before its payment was completed." />
      ) : null}
      {detail.status === 'pending_payment' ? (
        <StatusBanner tone="neutral" text="This booking is awaiting payment." />
      ) : null}
      {detail.pendingChange && viewer.canManage ? (
        <StatusBanner
          tone="neutral"
          text={`A change to ${formatDateLong(detail.pendingChange.date)}, ${formatTimeRangeCompact(
            detail.pendingChange.startTime,
            detail.pendingChange.endTime,
          )} is awaiting payment. Your current time is kept until the change is paid for.`}
        />
      ) : null}

      <ReservationSummaryCard
        typeCode={detail.typeCode}
        typeName={detail.typeName}
        resourceName={detail.resource.name}
        rows={[
          { label: 'Date', value: formatDateLong(detail.date) },
          { label: 'Time', value: formatTimeRangeCompact(detail.startTime, detail.endTime) },
          { label: 'Duration', value: formatDuration(detail.durationMinutes) },
        ]}
      />

      <View style={styles.meta}>
        <Text style={styles.metaText}>
          Booking ref <Text style={styles.metaValue}>{bookingRefLabel(detail.reference)}</Text>
        </Text>
        {detail.amountPaidCents > 0 ? (
          <Text style={styles.metaText}>
            Amount paid{' '}
            <Text style={styles.metaValue}>{formatAmountWithCents(detail.amountPaidCents)}</Text>
          </Text>
        ) : null}
      </View>

      <View style={styles.playersHead}>
        <Text style={styles.sectionLabel}>
          Players <Text style={styles.sectionCount}>{detail.participants.length}</Text>
        </Text>
        {canInvite ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Invite players"
            hitSlop={8}
            onPress={() => router.push(`/reservations/${detail.id}/invite` as never)}
          >
            <Text style={styles.sectionLink}>Invite</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.roster} accessibilityLabel="Players">
        {detail.participants.map((participant) => {
          const isSelf = participant.memberId === memberId;
          const name = memberDisplayName(participant);
          const showRespondPills = isSelf && viewer.canRespond && participant.status === 'pending';
          const showMenu = viewer.canManage && active && !isSelf && participant.role !== 'organizer';
          return (
            <View
              key={participant.memberId}
              style={styles.playerRow}
              accessibilityLabel={
                isSelf
                  ? `${name} (you), ${STATUS_LABELS[participant.status]}`
                  : `${name}, ${STATUS_LABELS[participant.status]}`
              }
            >
              <Avatar name={name} size="md" />
              <Text style={styles.playerName} numberOfLines={1}>
                {name}
                {isSelf ? <Text style={styles.playerYou}> (you)</Text> : null}
              </Text>
              {showRespondPills ? (
                <View
                  style={styles.respondActions}
                  accessibilityRole="none"
                  accessibilityLabel="Respond to this invitation"
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Accept invitation"
                    accessibilityState={{ disabled: respond.isPending }}
                    disabled={respond.isPending}
                    onPress={() => respondWith('accept')}
                    style={({ pressed }) => [
                      styles.respondPill,
                      styles.respondAccept,
                      pressed ? styles.pressed : null,
                    ]}
                  >
                    <Text style={styles.respondAcceptLabel}>Accept</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Decline invitation"
                    accessibilityState={{ disabled: respond.isPending }}
                    disabled={respond.isPending}
                    onPress={() => respondWith('decline')}
                    style={({ pressed }) => [
                      styles.respondPill,
                      styles.respondDecline,
                      pressed ? styles.pressed : null,
                    ]}
                  >
                    <Text style={styles.respondDeclineLabel}>Decline</Text>
                  </Pressable>
                </View>
              ) : (
                <Badge
                  label={STATUS_LABELS[participant.status]}
                  variant={participantStatusVariant(participant.status)}
                />
              )}
              {showMenu ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Actions for ${name}`}
                  hitSlop={8}
                  onPress={() => setPlayerMenu(participant)}
                  style={({ pressed }) => [styles.menuButton, pressed ? styles.pressed : null]}
                >
                  <Ionicons name="ellipsis-horizontal" size={18} color={colors.textMuted} />
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </View>

      {/* ── Bottom actions by role ── */}

      {viewer.canManage && !started ? (
        <View style={styles.actions}>
          {detail.status === 'confirmed' ? (
            <PrimaryButton
              label="Edit reservation"
              onPress={() => router.push(`/reservations/${detail.id}/edit` as never)}
            />
          ) : null}
          {active ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel reservation"
              onPress={() => setCancelOpen(true)}
              style={styles.textAction}
            >
              <Text style={styles.textActionLabel}>Cancel reservation</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {viewer.canRespond && myStatus === 'confirmed' && !started ? (
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Decline reservation"
            onPress={() => setWithdrawOpen(true)}
            style={styles.textAction}
          >
            <Text style={styles.textActionLabel}>Decline reservation</Text>
          </Pressable>
        </View>
      ) : null}

      {/* ── Cancel confirmation with the tiered-refund preview ── */}

      <Sheet
        open={cancelOpen}
        onClose={() => {
          if (!cancelMutation.isPending) setCancelOpen(false);
        }}
        title="Cancel reservation"
      >
        <View style={styles.dialogBody}>
          <Text style={styles.dialogText}>
            Cancel your {detail.typeName} booking on {formatDateLong(detail.date)},{' '}
            {formatTimeRangeCompact(detail.startTime, detail.endTime)}?
          </Text>
          {refund.netPaidCents > 0 ? (
            <>
              <View style={styles.refundSummary}>
                <Text style={styles.refundLabel}>Refund to your card ({refund.percent}%)</Text>
                <Text style={styles.refundAmount}>{formatAmountWithCents(refund.refundCents)}</Text>
              </View>
              <Text style={styles.dialogHint}>{refundTierHint(refund.percent)}</Text>
            </>
          ) : (
            <Text style={styles.dialogHint}>You have not been charged for this booking.</Text>
          )}
          <View style={styles.dialogActions}>
            <PrimaryButton
              label="Cancel reservation"
              variant="danger"
              loading={cancelMutation.isPending}
              onPress={() => cancelMutation.mutate()}
            />
            <PrimaryButton
              label="Keep reservation"
              variant="ghost"
              disabled={cancelMutation.isPending}
              onPress={() => setCancelOpen(false)}
            />
          </View>
        </View>
      </Sheet>

      {/* ── Withdraw (decline after accepting) confirmation ── */}

      <Sheet
        open={withdrawOpen}
        onClose={() => {
          if (!respond.isPending) setWithdrawOpen(false);
        }}
        title="Decline reservation"
      >
        <View style={styles.dialogBody}>
          <Text style={styles.dialogText}>
            You are confirmed for this booking. Declining gives up your spot, and you would need a
            new invitation to rejoin.
          </Text>
          <View style={styles.dialogActions}>
            <PrimaryButton
              label="Decline reservation"
              variant="danger"
              loading={respond.isPending}
              onPress={() => {
                respondWith('decline');
                setWithdrawOpen(false);
              }}
            />
            <PrimaryButton
              label="Keep my spot"
              variant="ghost"
              disabled={respond.isPending}
              onPress={() => setWithdrawOpen(false)}
            />
          </View>
        </View>
      </Sheet>

      {/* ── Organizer's per-player actions ── */}

      <Sheet
        open={playerMenu !== null}
        onClose={() => {
          if (!removeMutation.isPending && !reinviteMutation.isPending) setPlayerMenu(null);
        }}
        title={playerMenu ? memberDisplayName(playerMenu) : 'Player'}
      >
        {playerMenu ? (
          <View style={styles.dialogBody}>
            <Text style={styles.dialogHint}>
              {playerMenu.status === 'declined' || playerMenu.status === 'withdrawn'
                ? `${memberDisplayName(playerMenu)} declined this booking. You can invite them again or remove them from the list.`
                : `Removing ${memberDisplayName(playerMenu)} takes them off this booking; they can be invited again later.`}
            </Text>
            <View style={styles.dialogActions}>
              {playerMenu.status === 'declined' || playerMenu.status === 'withdrawn' ? (
                <PrimaryButton
                  label="Send invite again"
                  loading={reinviteMutation.isPending}
                  disabled={removeMutation.isPending}
                  onPress={() => reinviteMutation.mutate(playerMenu)}
                />
              ) : null}
              <PrimaryButton
                label="Remove from booking"
                variant="danger"
                loading={removeMutation.isPending}
                disabled={reinviteMutation.isPending}
                onPress={() => removeMutation.mutate(playerMenu)}
              />
            </View>
          </View>
        ) : null}
      </Sheet>
    </DetailFrame>
  );
}

function StatusBanner({ tone, text }: { tone: 'danger' | 'neutral'; text: string }) {
  return (
    <View
      style={[styles.statusBanner, tone === 'danger' ? styles.statusBannerDanger : null]}
      accessibilityRole="alert"
    >
      <Text style={styles.statusBannerText}>{text}</Text>
    </View>
  );
}

function refundTierHint(percent: 100 | 50 | 0): string {
  if (percent === 100) {
    return 'Cancelling more than 24 hours before the start time refunds the full amount.';
  }
  if (percent === 50) {
    return 'Cancelling between 2 and 24 hours before the start time refunds half of what you paid.';
  }
  return 'Cancelling within 2 hours of the start time is non-refundable.';
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  backLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginLeft: -4,
  },
  backLinkText: {
    color: colors.textLink,
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 28,
  },
  loading: {
    gap: spacing.md,
  },
  banner: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  bannerText: {
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  emptyAction: {
    alignSelf: 'stretch',
  },
  statusBanner: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  statusBannerDanger: {
    borderColor: colors.dangerStrong,
    backgroundColor: colors.surfaceOverlay,
  },
  statusBannerText: {
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 18,
  },
  meta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  metaText: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  metaValue: {
    color: colors.text,
    fontFamily: fonts.bodySemibold,
  },
  playersHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  sectionCount: {
    color: colors.textSubtle,
  },
  sectionLink: {
    color: colors.accent,
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
  },
  roster: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  playerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  playerName: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.bodyMedium,
    fontSize: 15,
  },
  playerYou: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  respondActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  respondPill: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  respondAccept: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  respondAcceptLabel: {
    color: colors.textOnAccent,
    fontFamily: fonts.bodyBold,
    fontSize: 13,
  },
  respondDecline: {
    backgroundColor: 'transparent',
    borderColor: colors.borderActive,
  },
  respondDeclineLabel: {
    color: colors.text,
    fontFamily: fonts.bodyBold,
    fontSize: 13,
  },
  menuButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  pressed: {
    opacity: 0.7,
  },
  actions: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  textAction: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  textActionLabel: {
    color: colors.textLink,
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
  },
  dialogBody: {
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  dialogText: {
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 21,
  },
  dialogHint: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 18,
  },
  refundSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  refundLabel: {
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  refundAmount: {
    color: colors.accent,
    fontFamily: fonts.displayBold,
    fontSize: 18,
  },
  dialogActions: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
});
