/**
 * Account tab (Figma account main 168:15494), native. Replaces the M0
 * placeholder with the real surface: avatar + camera badge, inline display-name
 * edit, member-since, three lifetime stat tiles, and the account-settings menu
 * (membership card, Claim Clutch coming-soon, billing, preferences, sign out).
 * Mirrors member-web's AccountPage.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { api, type HomeMember, type LifetimeStats } from '../../lib/api';
import { useSession } from '../../lib/session';
import { AppScreen, Avatar, MemberCardSheet, PrimaryButton, Skeleton, useToast } from '../../components';
import { useVenueTimezone } from '../reserve';
import { colors, fonts, radius, spacing, typography } from '../../theme/tokens';
import { profileQuery } from './account-data';
import {
  formatHours,
  memberDisplayName,
  memberNumberLabel,
  memberSinceLabel,
} from './account-lib';
import { SettingsGroup, SettingsRow } from './SettingsList';
import { DisplayNameEditor } from './DisplayNameEditor';
import { useAvatarUpload } from './useAvatarUpload';

export function AccountScreen() {
  const profile = useQuery(profileQuery);

  return (
    <AppScreen
      contentStyle={styles.content}
      refreshing={profile.isRefetching && !profile.isPending}
      onRefresh={() => void profile.refetch()}
    >
      {profile.isPending ? (
        <View accessibilityLabel="Loading your account" style={styles.loading}>
          <Skeleton width={96} height={96} borderRadius={radius.pill} />
          <Skeleton width={180} height={26} borderRadius={radius.sm} />
          <Skeleton width={140} height={16} borderRadius={radius.sm} />
          <Skeleton height={80} borderRadius={radius.lg} />
          <Skeleton height={260} borderRadius={radius.lg} />
        </View>
      ) : profile.isError ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>We could not load your account.</Text>
          <PrimaryButton label="Try again" variant="secondary" onPress={() => void profile.refetch()} />
        </View>
      ) : (
        <AccountView member={profile.data.member} stats={profile.data.stats} />
      )}
    </AppScreen>
  );
}

function AccountView({ member, stats }: { member: HomeMember; stats: LifetimeStats }) {
  const router = useRouter();
  const timezone = useVenueTimezone();
  const { toast } = useToast();
  const { signOut } = useSession();
  const avatar = useAvatarUpload();

  const [editingName, setEditingName] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  const name = memberDisplayName(member);

  const signOutMutation = useMutation({
    mutationFn: signOut,
    onError: () => toast({ variant: 'error', message: 'We could not sign you out. Please try again.' }),
  });

  return (
    <>
      {/* ── Profile header ── */}
      <View style={styles.header}>
        <View style={styles.avatarWrap}>
          <Avatar name={name} src={member.avatarUrl} size="xl" />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Change profile photo"
            accessibilityState={{ busy: avatar.isUploading }}
            onPress={avatar.choose}
            disabled={avatar.isUploading}
            hitSlop={8}
            style={styles.cameraBadge}
          >
            <Ionicons
              name={avatar.isUploading ? 'hourglass-outline' : 'camera'}
              size={16}
              color={colors.textOnAccent}
            />
          </Pressable>
        </View>

        {editingName ? (
          <DisplayNameEditor member={member} onDone={() => setEditingName(false)} />
        ) : (
          <View style={styles.nameRow}>
            <Text style={styles.name}>{name}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit display name"
              onPress={() => setEditingName(true)}
              hitSlop={8}
            >
              <Ionicons name="pencil" size={18} color={colors.textMuted} />
            </Pressable>
          </View>
        )}

        <Text style={styles.memberSince}>{memberSinceLabel(member.memberSince, timezone)}</Text>
        <Text style={styles.memberNumber}>{memberNumberLabel(member.memberNumber)}</Text>
      </View>

      {/* ── Lifetime stat tiles ── */}
      <View style={styles.statRow} accessibilityLabel="Lifetime activity">
        <StatTile value={String(stats.courtsBooked)} label="Courts booked" />
        <StatTile value={formatHours(stats.badmintonHours)} label="Badminton hours" />
        <StatTile value={formatHours(stats.tennisHours)} label="Tennis hours" />
      </View>

      {/* ── Account settings menu ── */}
      <SettingsGroup label="Account settings">
        <SettingsRow icon="qr-code-outline" label="View membership card" onPress={() => setQrOpen(true)} />
        <SettingsRow
          icon="videocam-outline"
          label="Claim Clutch session stats & clips"
          comingSoon
        />
        <SettingsRow
          icon="calendar-outline"
          label="Billing history"
          onPress={() => router.push('/account/billing')}
        />
        <SettingsRow
          icon="options-outline"
          label="App preferences"
          onPress={() => router.push('/account/preferences')}
        />
        <SettingsRow
          icon="log-out-outline"
          label="Sign out"
          accent
          loading={signOutMutation.isPending}
          onPress={() => signOutMutation.mutate()}
        />
      </SettingsGroup>

      <MemberCardSheet
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        memberName={name}
        memberNumber={member.memberNumber}
      />
    </>
  );
}

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.statTile} accessibilityLabel={`${value} ${label}`}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.xl,
  },
  loading: {
    alignItems: 'center',
    gap: spacing.md,
    alignSelf: 'stretch',
  },
  errorBox: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  errorText: {
    ...typography.body,
    color: colors.text,
  },
  header: {
    alignItems: 'center',
    gap: spacing.xs,
  },
  avatarWrap: {
    position: 'relative',
    marginBottom: spacing.xs,
  },
  cameraBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  name: {
    ...typography.h1,
    color: colors.text,
    textAlign: 'center',
  },
  memberSince: {
    ...typography.body,
    color: colors.textMuted,
  },
  memberNumber: {
    fontFamily: fonts.body,
    fontSize: 12,
    letterSpacing: 1,
    color: colors.textSubtle,
  },
  statRow: {
    flexDirection: 'row',
    alignSelf: 'stretch',
  },
  statTile: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  statValue: {
    fontFamily: fonts.displayBold,
    fontSize: 24,
    color: colors.text,
  },
  statLabel: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
