import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { api, ApiError, resolveApiAssetUrl } from '../../lib/api';
import { EmptyStateView, PrimaryButton, Skeleton, useToast } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { memberCountLabel } from './clubs-lib';
import { clubInvitePreviewQuery } from './clubs-data';

/** A dead invite link (410 revoked/expired/exhausted, or 404 unknown) → copy. */
function deadLinkMessage(error: unknown): string | null {
  if (error instanceof ApiError) {
    if (error.status === 410) return error.message;
    if (error.status === 404) return 'This invite link is not valid.';
  }
  return null;
}

/**
 * Join a club from an invite link (Figma reuses the join card; mirrors
 * member-web's JoinClubPage). Resolves the token to a club preview, then joins.
 * An invalid/expired/revoked link (410 INVITE_LINK_INVALID) and a missing token
 * get explicit "ask for a fresh link" states; an existing member gets an "Open"
 * shortcut instead of Join.
 */
export function JoinClubScreen({ token }: { token: string | null }) {
  const trimmed = token?.trim() || '';
  if (!trimmed) {
    return (
      <JoinFrame>
        <EmptyStateView
          title="Invite link not valid"
          description="This link is missing its invite code. Ask a club member to share the link again."
        />
        <BackToClubsButton />
      </JoinFrame>
    );
  }
  return <JoinPreview token={trimmed} />;
}

function JoinPreview({ token }: { token: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const preview = useQuery(clubInvitePreviewQuery(token));

  const join = useMutation({
    mutationFn: () => api.joinClub(token),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
      void queryClient.invalidateQueries({ queryKey: ['club-invitations'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      toast({
        variant: 'success',
        message: result.alreadyMember
          ? `You are already a member of ${result.club.name}.`
          : `Welcome to ${result.club.name}!`,
      });
      router.replace(`/clubs/${result.club.id}`);
    },
    onError: (error) => {
      const dead = deadLinkMessage(error);
      toast({ variant: 'error', message: dead ?? 'We could not join the club. Try again.' });
      if (dead) void preview.refetch();
    },
  });

  if (preview.isPending) {
    return (
      <JoinFrame>
        <View accessibilityLabel="Checking your invite link">
          <Skeleton height={224} borderRadius={radius.lg} />
        </View>
      </JoinFrame>
    );
  }

  if (preview.isError) {
    const dead = deadLinkMessage(preview.error);
    if (dead) {
      return (
        <JoinFrame>
          <View accessibilityRole="alert">
            <EmptyStateView
              title="Invite link not usable"
              description={`${dead} Ask a club member for a fresh invite link.`}
            />
          </View>
          <BackToClubsButton />
        </JoinFrame>
      );
    }
    return (
      <JoinFrame>
        <View style={styles.banner} accessibilityRole="alert">
          <Text style={styles.bannerText}>We could not check this invite link.</Text>
          <PrimaryButton label="Try again" variant="secondary" onPress={() => void preview.refetch()} />
        </View>
      </JoinFrame>
    );
  }

  const { club, alreadyMember } = preview.data;

  return (
    <JoinFrame>
      <View style={styles.card}>
        {club.coverImageUrl ? (
          <Image source={resolveApiAssetUrl(club.coverImageUrl) as string} style={styles.cover} contentFit="cover" />
        ) : null}
        <Text style={styles.invitedTo}>You are invited to join</Text>
        <View style={styles.clubRow}>
          <View style={styles.clubGlyph}>
            <Ionicons name="people" size={26} color={colors.accent} />
          </View>
          <View style={styles.clubText}>
            <Text style={styles.clubName} numberOfLines={2}>
              {club.name}
            </Text>
            <Text style={styles.clubMeta}>{memberCountLabel(club.memberCount)}</Text>
          </View>
        </View>
        {club.description ? <Text style={styles.description}>{club.description}</Text> : null}

        {alreadyMember ? (
          <>
            <Text style={styles.alreadyHint}>You are already a member of this club.</Text>
            <PrimaryButton label={`Open ${club.name}`} onPress={() => router.replace(`/clubs/${club.id}`)} />
          </>
        ) : (
          <PrimaryButton label="Join club" loading={join.isPending} onPress={() => join.mutate()} />
        )}
      </View>
    </JoinFrame>
  );
}

function JoinFrame({ children }: { children: React.ReactNode }) {
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
          accessibilityLabel="Back to clubs"
          onPress={goBack}
          hitSlop={8}
          style={styles.backLink}
        >
          <Ionicons name="chevron-back" size={18} color={colors.textLink} />
          <Text style={styles.backLinkText}>Back to clubs</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>
          Join club
        </Text>
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
    fontFamily: fonts.displayHeavy,
    fontSize: 28,
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
  card: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  cover: {
    width: '100%',
    height: 150,
    borderRadius: radius.md,
    backgroundColor: colors.backgroundMuted,
  },
  invitedTo: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  clubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  clubGlyph: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceOverlay,
  },
  clubText: {
    flex: 1,
    gap: 2,
  },
  clubName: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 22,
  },
  clubMeta: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  description: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 20,
  },
  alreadyHint: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
  },
});
