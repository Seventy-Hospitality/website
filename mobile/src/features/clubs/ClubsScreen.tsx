import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ClubInvitation } from '../../lib/api';
import { AppScreen, PrimaryButton, Skeleton, useToast } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import { isClubInviteConflict, useRespondToClubInvitation } from '../home';
import { clubInvitationsQuery, myClubsQuery } from './clubs-data';
import { ClubCard } from './ClubCard';
import { ClubInvitationCard } from './ClubInvitationCard';

/**
 * The Clubs tab (Figma your-clubs 91:3774 / 91:3935): the member's clubs as
 * cover cards, a "Create a new club" CTA, and any pending club invitations with
 * inline Accept / Decline. Mirrors member-web's ClubsPage, native.
 */
export function ClubsScreen() {
  const router = useRouter();
  const { toast } = useToast();

  const clubs = useQuery(myClubsQuery);
  const invitations = useQuery(clubInvitationsQuery);
  const respond = useRespondToClubInvitation();

  const goCreate = () => router.push('/clubs/new');

  const refreshing = clubs.isRefetching || invitations.isRefetching;
  const onRefresh = () => {
    void clubs.refetch();
    void invitations.refetch();
  };

  function respondTo(invitation: ClubInvitation, response: 'accept' | 'decline') {
    respond.mutate(
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
  }

  const clubList = clubs.data ?? [];
  const invitationList = invitations.data ?? [];
  const hasClubs = clubList.length > 0;
  const hasInvitations = invitationList.length > 0;

  return (
    <AppScreen refreshing={refreshing} onRefresh={onRefresh}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text accessibilityRole="header" style={styles.title}>
            Your clubs
          </Text>
          <Text style={styles.subtitle}>Create clubs to book together and track stats</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create a new club"
          onPress={goCreate}
          style={({ pressed }) => [styles.addButton, pressed ? styles.pressed : null]}
        >
          <Ionicons name="add" size={24} color={colors.textOnAccent} />
        </Pressable>
      </View>

      {clubs.isPending ? (
        <View style={styles.list} accessibilityLabel="Loading your clubs">
          <Skeleton height={176} borderRadius={radius.lg} />
          <Skeleton height={72} borderRadius={radius.lg} />
        </View>
      ) : clubs.isError ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>We could not load your clubs.</Text>
          <PrimaryButton label="Try again" variant="secondary" onPress={() => void clubs.refetch()} />
        </View>
      ) : hasClubs ? (
        <View style={styles.list}>
          {clubList.map((club) => (
            <ClubCard key={club.id} club={club} onPress={() => router.push(`/clubs/${club.id}`)} />
          ))}
          <CreateClubCard onPress={goCreate} />
        </View>
      ) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>You are not in a club yet</Text>
          <Text style={styles.emptyBody}>
            {hasInvitations
              ? 'You have invitations waiting below, or create your own to book together and track stats.'
              : 'Create one to book together and track stats with your crew.'}
          </Text>
          <PrimaryButton label="Create a new club" onPress={goCreate} />
        </View>
      )}

      {hasInvitations ? (
        <View style={styles.invitations}>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            Invitations
          </Text>
          {invitationList.map((invitation) => {
            const pending =
              respond.isPending && respond.variables?.invitationId === invitation.id;
            return (
              <ClubInvitationCard
                key={invitation.id}
                invitation={invitation}
                pending={pending}
                disabled={respond.isPending}
                onAccept={() => respondTo(invitation, 'accept')}
                onDecline={() => respondTo(invitation, 'decline')}
              />
            );
          })}
        </View>
      ) : null}
    </AppScreen>
  );
}

/** The dashed "Create a new club" affordance below the club cards. */
function CreateClubCard({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Create a new club"
      onPress={onPress}
      style={({ pressed }) => [styles.createCard, pressed ? styles.pressed : null]}
    >
      <Ionicons name="add" size={20} color={colors.textMuted} />
      <Text style={styles.createLabel}>Create a new club</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  headerText: {
    flex: 1,
    gap: spacing.xs,
  },
  title: {
    color: colors.text,
    fontFamily: fonts.displayHeavy,
    fontSize: 30,
  },
  subtitle: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  pressed: {
    opacity: 0.9,
  },
  list: {
    gap: spacing.md,
  },
  createCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 64,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
  },
  createLabel: {
    color: colors.textMuted,
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
  },
  emptyState: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  emptyTitle: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 18,
  },
  emptyBody: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 20,
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
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  invitations: {
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 20,
  },
});
