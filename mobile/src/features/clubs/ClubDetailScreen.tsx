import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { api, ApiError, type ClubDetail, type MyClub } from '../../lib/api';
import { EmptyStateView, PrimaryButton, Sheet, Skeleton, useToast } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { memberCountLabel, roleLabel } from './clubs-lib';
import { clubActivityQuery, clubQuery, useClubInviteLink } from './clubs-data';
import { ClubActivityRow } from './ClubActivityRow';
import { InviteToClubSheet } from './InviteToClubSheet';
import { EditClubSheet } from './EditClubSheet';

/**
 * Club detail (Figma club-detail 99:5623 / 105:5927): the cover hero, the
 * Members / Invite / Share / Book action bar, and the group-activity feed.
 * Owner/member actions render off the backend permission flags, never off the
 * role directly. Outsiders get the backend's 404 shape (a club you are not in
 * looks identical to one that does not exist). Mirrors member-web's
 * ClubDetailPage, native.
 */
export function ClubDetailScreen({ clubId }: { clubId: string }) {
  const detail = useQuery(clubQuery(clubId));

  if (detail.isPending) {
    return (
      <DetailFrame>
        <View accessibilityLabel="Loading club" style={styles.loading}>
          <Skeleton height={240} borderRadius={radius.lg} />
          <Skeleton height={120} borderRadius={radius.lg} />
        </View>
      </DetailFrame>
    );
  }

  if (detail.isError) {
    const error = detail.error;
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      return (
        <DetailFrame>
          <EmptyStateView
            title="Club not found"
            description="This club does not exist, was deleted, or you are not a member of it."
          />
          <BackToClubsButton />
        </DetailFrame>
      );
    }
    return (
      <DetailFrame>
        <View style={styles.banner} accessibilityRole="alert">
          <Text style={styles.bannerText}>We could not load this club.</Text>
          <PrimaryButton label="Try again" variant="secondary" onPress={() => void detail.refetch()} />
        </View>
      </DetailFrame>
    );
  }

  return <ClubDetailView club={detail.data} />;
}

/** A minimal framed shell for the loading / error / not-found states. */
function DetailFrame({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/clubs');
  };
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.frameContent} showsVerticalScrollIndicator={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to clubs"
          onPress={goBack}
          hitSlop={8}
          style={styles.backLink}
        >
          <Ionicons name="chevron-back" size={18} color={colors.textLink} />
          <Text style={styles.backLinkText}>Back to clubs</Text>
        </Pressable>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

function BackToClubsButton() {
  const router = useRouter();
  return (
    <View style={styles.emptyAction}>
      <PrimaryButton label="Back to clubs" onPress={() => router.replace('/(tabs)/clubs')} />
    </View>
  );
}

function ClubDetailView({ club }: { club: ClubDetail }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const activity = useQuery(clubActivityQuery(club.id));
  const link = useClubInviteLink(club.id);

  const [menuOpen, setMenuOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const { canEdit, canDelete, canInvite, canLeave, canManageMembers } = club.permissions;
  const hasMenu = canEdit || canDelete || canLeave;

  const goToClubs = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/clubs');
  }, [router]);

  const share = useCallback(async () => {
    try {
      const url = await link.ensureUrl();
      await Share.share({ title: `Join ${club.name} on Club70`, message: url, url });
    } catch {
      toast({ variant: 'error', message: 'We could not share an invite link. Try again.' });
    }
  }, [link, club.name, toast]);

  const leave = useMutation({
    mutationFn: () => api.leaveClub(club.id),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['clubs'], exact: true });
      const previous = queryClient.getQueryData<MyClub[]>(['clubs']);
      queryClient.setQueryData<MyClub[]>(['clubs'], (rows) =>
        rows?.filter((row) => row.id !== club.id),
      );
      return { previous };
    },
    onSuccess: () => {
      setLeaveOpen(false);
      queryClient.removeQueries({ queryKey: ['clubs', club.id] });
      toast({ variant: 'success', message: `You left ${club.name}.` });
      goToClubs();
    },
    onError: (error, _vars, context) => {
      setLeaveOpen(false);
      if (context?.previous) queryClient.setQueryData(['clubs'], context.previous);
      toast({
        variant: 'error',
        message:
          error instanceof ApiError && error.code === 'OWNER_MUST_TRANSFER'
            ? 'Transfer ownership to another member before leaving.'
            : `We could not remove you from ${club.name}. Try again.`,
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['clubs'], exact: true });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteClub(club.id),
    onSuccess: () => {
      setDeleteOpen(false);
      queryClient.removeQueries({ queryKey: ['clubs', club.id] });
      void queryClient.invalidateQueries({ queryKey: ['clubs'], exact: true });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      toast({ variant: 'success', message: `${club.name} was deleted.` });
      goToClubs();
    },
    onError: () => {
      setDeleteOpen(false);
      toast({ variant: 'error', message: 'We could not delete this club. Try again.' });
      void queryClient.invalidateQueries({ queryKey: ['clubs', club.id] });
    },
  });

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* ── Cover hero ── */}
        <View style={styles.hero}>
          {club.coverImageUrl ? (
            <Image source={club.coverImageUrl} style={styles.cover} contentFit="cover" />
          ) : (
            <View style={[styles.cover, styles.coverFallback]}>
              <Ionicons name="people" size={64} color={colors.surfaceMuted} />
            </View>
          )}
          <View style={styles.heroShade} />

          <View style={[styles.heroChrome, { paddingTop: insets.top + spacing.xs }]}>
            <HeroButton icon="chevron-back" label="Back to clubs" onPress={goToClubs} />
            {hasMenu ? (
              <HeroButton icon="ellipsis-vertical" label="Club actions" onPress={() => setMenuOpen(true)} />
            ) : (
              <View style={styles.heroButtonSpacer} />
            )}
          </View>

          <View style={styles.heroText}>
            <Text style={styles.heroName} numberOfLines={2}>
              {club.name}
            </Text>
            <Text
              style={styles.heroMeta}
              accessibilityLabel={`${memberCountLabel(club.memberCount)}, your role: ${roleLabel(
                club.myRole,
              )}`}
            >
              {memberCountLabel(club.memberCount)}
              <Text style={styles.heroMetaSep}>{'   |   '}</Text>
              {roleLabel(club.myRole)}
            </Text>
          </View>
        </View>

        <View style={styles.body}>
          {club.description ? <Text style={styles.description}>{club.description}</Text> : null}

          {/* ── Action bar ── */}
          <View style={styles.actionBar} accessibilityLabel="Club quick actions">
            <ActionButton icon="people-outline" label="Members" onPress={() => router.push(`/clubs/${club.id}/members`)} />
            {canInvite ? (
              <ActionButton icon="person-add-outline" label="Invite" onPress={() => setInviteOpen(true)} />
            ) : null}
            <ActionButton icon="share-social-outline" label="Share" disabled={link.isPending} onPress={() => void share()} />
            <ActionButton
              icon="calendar-outline"
              label="Book"
              accessibilityLabel={`Book for ${club.name}`}
              onPress={() => router.push('/(tabs)/reserve')}
            />
          </View>

          {/* ── Group activity ── */}
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Group activity
          </Text>

          {activity.isPending ? (
            <View style={styles.list} accessibilityLabel="Loading group activity">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height={64} borderRadius={radius.md} />
              ))}
            </View>
          ) : activity.isError ? (
            <View style={styles.banner} accessibilityRole="alert">
              <Text style={styles.bannerText}>We could not load the group activity.</Text>
              <PrimaryButton label="Try again" variant="secondary" onPress={() => void activity.refetch()} />
            </View>
          ) : activity.data.length === 0 ? (
            <View style={styles.emptyActivity}>
              <Text style={styles.emptyActivityText}>No group activity yet</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Create an event"
                onPress={() => router.push('/(tabs)/reserve')}
                hitSlop={8}
              >
                <Text style={styles.emptyActivityLink}>Create an event</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.list}>
              {activity.data.map((item) => (
                <ClubActivityRow
                  key={item.id}
                  item={item}
                  onPress={() => router.push(`/reservations/${item.id}`)}
                />
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* ── Overflow menu ── */}
      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title={club.name}>
        <View style={styles.menu}>
          {canEdit ? (
            <PrimaryButton
              label="Edit club"
              variant="secondary"
              onPress={() => {
                setMenuOpen(false);
                setEditOpen(true);
              }}
            />
          ) : null}
          {canLeave ? (
            <PrimaryButton
              label="Leave club"
              variant="danger"
              onPress={() => {
                setMenuOpen(false);
                setLeaveOpen(true);
              }}
            />
          ) : null}
          {canDelete ? (
            <PrimaryButton
              label="Delete club"
              variant="danger"
              onPress={() => {
                setMenuOpen(false);
                setDeleteOpen(true);
              }}
            />
          ) : null}
          {!canLeave ? (
            <Text style={styles.menuHint}>
              As the owner you cannot leave this club; transfer ownership to another member first
              (Members, then the member&apos;s menu).
            </Text>
          ) : null}
        </View>
      </Sheet>

      {/* ── Leave confirm ── */}
      <Sheet
        open={leaveOpen}
        onClose={() => {
          if (!leave.isPending) setLeaveOpen(false);
        }}
        title="Leave club"
      >
        <View style={styles.dialogBody}>
          <Text style={styles.dialogText}>
            Leave {club.name}? You will need a new invitation or invite link to rejoin.
          </Text>
          <View style={styles.dialogActions}>
            <PrimaryButton
              label="Leave club"
              variant="danger"
              loading={leave.isPending}
              onPress={() => leave.mutate()}
            />
            <PrimaryButton
              label="Stay in the club"
              variant="ghost"
              disabled={leave.isPending}
              onPress={() => setLeaveOpen(false)}
            />
          </View>
        </View>
      </Sheet>

      {/* ── Delete confirm ── */}
      <Sheet
        open={deleteOpen}
        onClose={() => {
          if (!remove.isPending) setDeleteOpen(false);
        }}
        title="Delete club"
      >
        <View style={styles.dialogBody}>
          <Text style={styles.dialogText}>
            Delete {club.name} for {memberCountLabel(club.memberCount).toLowerCase()}? Pending
            invitations and invite links stop working. This cannot be undone.
          </Text>
          <View style={styles.dialogActions}>
            <PrimaryButton
              label="Delete club"
              variant="danger"
              loading={remove.isPending}
              onPress={() => remove.mutate()}
            />
            <PrimaryButton
              label="Keep the club"
              variant="ghost"
              disabled={remove.isPending}
              onPress={() => setDeleteOpen(false)}
            />
          </View>
        </View>
      </Sheet>

      {canEdit ? <EditClubSheet club={club} open={editOpen} onClose={() => setEditOpen(false)} /> : null}
      <InviteToClubSheet
        clubId={club.id}
        clubName={club.name}
        canRotateLink={canManageMembers}
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
      />
    </View>
  );
}

function HeroButton({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.heroButton, pressed ? styles.pressed : null]}
    >
      <Ionicons name={icon} size={20} color={colors.text} />
    </Pressable>
  );
}

function ActionButton({
  icon,
  label,
  accessibilityLabel,
  disabled,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && !disabled ? styles.pressed : null]}
    >
      <View style={styles.actionCircle}>
        <Ionicons name={icon} size={20} color={colors.text} />
      </View>
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  frameContent: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  scrollContent: {
    paddingBottom: spacing.xxl,
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
  loading: {
    gap: spacing.md,
  },
  emptyAction: {
    alignSelf: 'stretch',
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
  hero: {
    height: 288,
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  cover: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
  },
  coverFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceOverlay,
  },
  heroShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(12, 18, 13, 0.34)',
  },
  heroChrome: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
  },
  heroButton: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(12, 18, 13, 0.5)',
  },
  heroButtonSpacer: {
    width: 40,
    height: 40,
  },
  heroText: {
    padding: spacing.md,
    gap: 2,
  },
  heroName: {
    color: colors.text,
    fontFamily: fonts.displayHeavy,
    fontSize: 34,
  },
  heroMeta: {
    color: colors.text,
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
  },
  heroMetaSep: {
    color: colors.textMuted,
  },
  body: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    gap: spacing.lg,
  },
  description: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: 21,
  },
  actionBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    gap: spacing.sm,
  },
  action: {
    alignItems: 'center',
    gap: spacing.xs,
    flex: 1,
  },
  actionCircle: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceOverlay,
  },
  actionLabel: {
    color: colors.textMuted,
    fontFamily: fonts.bodyMedium,
    fontSize: 12,
  },
  sectionTitle: {
    color: colors.text,
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  list: {
    gap: spacing.sm,
  },
  emptyActivity: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  emptyActivityText: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 15,
  },
  emptyActivityLink: {
    color: colors.accent,
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
  },
  pressed: {
    opacity: 0.75,
  },
  menu: {
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  menuHint: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 18,
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
  dialogActions: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
});
