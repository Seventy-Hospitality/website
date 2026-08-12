import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { api, ApiError, type ClubDetail, type ClubRosterEntry } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Avatar, Badge, EmptyStateView, PrimaryButton, Sheet, Skeleton, useToast } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { memberDisplayName, memberNumberLabel } from './clubs-lib';
import { clubMembersQuery, clubQuery } from './clubs-data';
import { InviteToClubSheet } from './InviteToClubSheet';

/**
 * The club members roster (Figma members 105:6876): a row per member with the
 * Owner badge and member number, an owner-only per-row menu (change role /
 * transfer ownership / remove), and a "+" that opens the invite modal. Actions
 * render off the backend permission flags. Mirrors member-web's ClubMembersPage.
 */
export function ClubMembersScreen({ clubId }: { clubId: string }) {
  const detail = useQuery(clubQuery(clubId));
  const roster = useQuery(clubMembersQuery(clubId));

  const pending = detail.isPending || roster.isPending;
  const notFound =
    (detail.isError &&
      detail.error instanceof ApiError &&
      (detail.error.status === 404 || detail.error.status === 403)) ||
    (roster.isError &&
      roster.error instanceof ApiError &&
      (roster.error.status === 404 || roster.error.status === 403));
  const otherError = (detail.isError || roster.isError) && !notFound;

  if (pending) {
    return (
      <MembersFrame>
        <View accessibilityLabel="Loading members" style={styles.list}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={60} borderRadius={radius.md} />
          ))}
        </View>
      </MembersFrame>
    );
  }

  if (notFound) {
    return (
      <MembersFrame>
        <EmptyStateView
          title="Club not found"
          description="This club does not exist, was deleted, or you are not a member of it."
        />
      </MembersFrame>
    );
  }

  if (otherError) {
    return (
      <MembersFrame>
        <View style={styles.banner} accessibilityRole="alert">
          <Text style={styles.bannerText}>We could not load the members.</Text>
          <PrimaryButton
            label="Try again"
            variant="secondary"
            onPress={() => {
              if (detail.isError) void detail.refetch();
              if (roster.isError) void roster.refetch();
            }}
          />
        </View>
      </MembersFrame>
    );
  }

  return <MembersView club={detail.data!} roster={roster.data!} />;
}

function MembersFrame({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  const router = useRouter();
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/clubs');
  };
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to club"
          onPress={goBack}
          hitSlop={8}
          style={styles.backLink}
        >
          <Ionicons name="chevron-back" size={18} color={colors.textLink} />
          <Text style={styles.backLinkText}>Back to club</Text>
        </Pressable>
        <View style={styles.headerRow}>
          <Text accessibilityRole="header" style={styles.title}>
            Members
          </Text>
          {action}
        </View>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

function MembersView({ club, roster }: { club: ClubDetail; roster: ClubRosterEntry[] }) {
  const { memberId } = useSession();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [memberMenu, setMemberMenu] = useState<ClubRosterEntry | null>(null);
  const [confirm, setConfirm] = useState<{ action: 'transfer' | 'remove'; entry: ClubRosterEntry } | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const canManage = club.permissions.canManageMembers;
  const canInvite = club.permissions.canInvite;

  function conflictOrGeneric(error: unknown, generic: string): string {
    if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
      return 'The club changed before that could be saved. Refreshing.';
    }
    return generic;
  }

  const transfer = useMutation({
    mutationFn: (entry: ClubRosterEntry) => api.changeClubMemberRole(club.id, entry.memberId, 'owner'),
    onSuccess: (_result, entry) => {
      setConfirm(null);
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
      toast({ variant: 'success', message: `${memberDisplayName(entry)} is now the club owner.` });
    },
    onError: (error) => {
      setConfirm(null);
      toast({ variant: 'error', message: conflictOrGeneric(error, 'We could not transfer ownership. Try again.') });
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
    },
  });

  const remove = useMutation({
    mutationFn: (entry: ClubRosterEntry) => api.removeClubMember(club.id, entry.memberId),
    onSuccess: (_result, entry) => {
      setConfirm(null);
      queryClient.setQueryData<ClubRosterEntry[]>(['clubs', club.id, 'members'], (rows) =>
        rows?.filter((row) => row.memberId !== entry.memberId),
      );
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
      toast({ variant: 'success', message: `${memberDisplayName(entry)} was removed from the club.` });
    },
    onError: (error) => {
      setConfirm(null);
      toast({ variant: 'error', message: conflictOrGeneric(error, 'We could not remove that member. Try again.') });
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
    },
  });

  const busy = transfer.isPending || remove.isPending;

  return (
    <MembersFrame
      action={
        canInvite ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Invite to club"
            onPress={() => setInviteOpen(true)}
            style={({ pressed }) => [styles.addButton, pressed ? styles.pressedLight : null]}
          >
            <Ionicons name="add" size={22} color={colors.textOnAccent} />
          </Pressable>
        ) : undefined
      }
    >
      <View style={styles.roster} accessibilityLabel={`Members of ${club.name}`}>
        {roster.map((entry) => {
          const isSelf = entry.memberId === memberId;
          const name = memberDisplayName(entry);
          const showMenu = canManage && !isSelf && entry.role !== 'owner';
          return (
            <View key={entry.memberId} style={styles.row}>
              <Avatar name={name} src={entry.avatarUrl} size="md" />
              <View style={styles.rowText}>
                <View style={styles.rowTitleLine}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {name}
                    {isSelf ? <Text style={styles.rowYou}> (you)</Text> : null}
                  </Text>
                  {entry.role === 'owner' ? (
                    <Badge label="Owner" variant="neutral" style={styles.ownerBadge} />
                  ) : null}
                </View>
                <Text style={styles.rowSubtitle}>{memberNumberLabel(entry.memberNumber)}</Text>
              </View>
              {showMenu ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Actions for ${name}`}
                  hitSlop={8}
                  onPress={() => setMemberMenu(entry)}
                  style={({ pressed }) => [styles.menuButton, pressed ? styles.pressed : null]}
                >
                  <Ionicons name="ellipsis-horizontal" size={18} color={colors.textMuted} />
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </View>

      {/* ── Per-member action menu ── */}
      <Sheet
        open={memberMenu !== null}
        onClose={() => setMemberMenu(null)}
        title={memberMenu ? memberDisplayName(memberMenu) : 'Member'}
      >
        {memberMenu ? (
          <View style={styles.dialogBody}>
            <Text style={styles.dialogHint}>
              Transferring makes {memberDisplayName(memberMenu)} the owner and you a regular member;
              removing takes them off the club roster.
            </Text>
            <View style={styles.dialogActions}>
              <PrimaryButton
                label="Transfer ownership"
                variant="secondary"
                onPress={() => {
                  const entry = memberMenu;
                  setMemberMenu(null);
                  setConfirm({ action: 'transfer', entry });
                }}
              />
              <PrimaryButton
                label="Remove from club"
                variant="danger"
                onPress={() => {
                  const entry = memberMenu;
                  setMemberMenu(null);
                  setConfirm({ action: 'remove', entry });
                }}
              />
            </View>
          </View>
        ) : null}
      </Sheet>

      {/* ── Transfer ownership confirm ── */}
      <Sheet
        open={confirm?.action === 'transfer'}
        onClose={() => {
          if (!busy) setConfirm(null);
        }}
        title="Transfer ownership"
      >
        {confirm?.action === 'transfer' ? (
          <View style={styles.dialogBody}>
            <Text style={styles.dialogText}>
              Make {memberDisplayName(confirm.entry)} the owner of {club.name}?
            </Text>
            <Text style={styles.dialogHint}>
              You become a regular member and lose owner controls (editing the club, managing
              members, deleting it). Only the new owner can transfer it back.
            </Text>
            <View style={styles.dialogActions}>
              <PrimaryButton
                label={`Make ${memberDisplayName(confirm.entry)} the owner`}
                loading={transfer.isPending}
                onPress={() => transfer.mutate(confirm.entry)}
              />
              <PrimaryButton
                label="Cancel"
                variant="ghost"
                disabled={busy}
                onPress={() => setConfirm(null)}
              />
            </View>
          </View>
        ) : null}
      </Sheet>

      {/* ── Remove member confirm ── */}
      <Sheet
        open={confirm?.action === 'remove'}
        onClose={() => {
          if (!busy) setConfirm(null);
        }}
        title="Remove member"
      >
        {confirm?.action === 'remove' ? (
          <View style={styles.dialogBody}>
            <Text style={styles.dialogText}>
              Remove {memberDisplayName(confirm.entry)} from {club.name}? They can be invited again
              later.
            </Text>
            <View style={styles.dialogActions}>
              <PrimaryButton
                label="Remove from club"
                variant="danger"
                loading={remove.isPending}
                onPress={() => remove.mutate(confirm.entry)}
              />
              <PrimaryButton
                label="Cancel"
                variant="ghost"
                disabled={busy}
                onPress={() => setConfirm(null)}
              />
            </View>
          </View>
        ) : null}
      </Sheet>

      <InviteToClubSheet
        clubId={club.id}
        clubName={club.name}
        canRotateLink={canManage}
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
      />
    </MembersFrame>
  );
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
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    color: colors.text,
    fontFamily: fonts.displayHeavy,
    fontSize: 28,
  },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  pressedLight: {
    opacity: 0.9,
  },
  pressed: {
    opacity: 0.7,
  },
  list: {
    gap: spacing.sm,
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
  roster: {
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  rowTitle: {
    flexShrink: 1,
    color: colors.text,
    fontFamily: fonts.bodySemibold,
    fontSize: 16,
  },
  rowYou: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  ownerBadge: {
    backgroundColor: 'rgba(190, 206, 133, 0.18)',
  },
  rowSubtitle: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  menuButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
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
  dialogActions: {
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
});
