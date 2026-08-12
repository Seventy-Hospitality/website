import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { MemberSearchResult, MyClub } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Avatar, Chip, EmptyStateView, PrimaryButton, Skeleton } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import {
  addInviteClub,
  clubChipLabel,
  isClubSelected,
  isMemberSelected,
  memberDisplayName,
  memberNumberLabel,
  removeInviteClub,
  removeInviteMember,
  toggleInviteMember,
  type InviteSelection,
} from './invites';
import { memberSearchQuery, myClubsQuery } from './booking-data';
import { StepShell } from './StepShell';

const SEARCH_DEBOUNCE_MS = 250;

export interface InvitePlayersStepProps {
  /** "Mon, Jul 6 · 9:30-11:30PM" under the title. */
  subtitle: string;
  selection: InviteSelection;
  onSelectionChange: (selection: InviteSelection) => void;
  /** Members already on the reservation (post-confirm invite mode). */
  excludeMemberIds?: string[];
  continueLabel: string;
  continueDisabled?: boolean;
  continuePending?: boolean;
  error?: string | null;
  onContinue: () => void;
}

/**
 * Wizard step 2 (Figma invite-players 7:2482 / 77:2117 / 77:2233): search by
 * name or member ID, a CLUB row whose "Add all" produces a removable
 * "CLUB: name (n)" chip (expanded to the club's roster server-side), and
 * individual player rows with check toggles. Inviting is optional for the
 * booking; the same component runs the post-confirmation "Invite more" flow,
 * where it requires a pick. Mirrors member-web's InvitePlayersStep.
 *
 * The mobile members/search endpoint returns a directory listing for an
 * empty query, so we use it directly for both the initial suggestions and
 * the search (member-web fell back to club rosters because that endpoint
 * did not exist there yet).
 */
export function InvitePlayersStep({
  subtitle,
  selection,
  onSelectionChange,
  excludeMemberIds = [],
  continueLabel,
  continueDisabled = false,
  continuePending = false,
  error = null,
  onContinue,
}: InvitePlayersStepProps) {
  const { memberId } = useSession();
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const searching = debouncedQuery.length > 0;

  const clubs = useQuery(myClubsQuery);
  const search = useQuery(memberSearchQuery(debouncedQuery));

  const excluded = useMemo(
    () => new Set([memberId, ...excludeMemberIds].filter(Boolean) as string[]),
    [memberId, excludeMemberIds],
  );

  const players: MemberSearchResult[] = useMemo(
    () => (search.data ?? []).filter((member) => !excluded.has(member.id)),
    [search.data, excluded],
  );

  const hasChips = selection.clubs.length > 0 || selection.members.length > 0;

  return (
    <StepShell
      title="Invite players"
      subtitle={subtitle}
      footer={
        <PrimaryButton
          label={continueLabel}
          loading={continuePending}
          onPress={continueDisabled ? undefined : onContinue}
          variant={continueDisabled ? 'ghost' : 'primary'}
        />
      }
    >
      <View style={styles.searchBox}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name or member ID"
          placeholderTextColor={colors.textSubtle}
          accessibilityLabel="Search by name or member ID"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>

      {hasChips ? (
        <View style={styles.chipRow} accessibilityLabel="Selected invites">
          {selection.clubs.map((club) => (
            <Chip
              key={club.id}
              label={clubChipLabel(club)}
              onRemove={() => onSelectionChange(removeInviteClub(selection, club.id))}
            />
          ))}
          {selection.members.map((member) => (
            <Chip
              key={member.id}
              label={memberDisplayName(member)}
              onRemove={() => onSelectionChange(removeInviteMember(selection, member.id))}
            />
          ))}
        </View>
      ) : null}

      {clubs.isSuccess && clubs.data.length > 0 ? (
        <>
          <Text style={styles.sectionLabel}>Club</Text>
          <View style={styles.list}>
            {clubs.data.map((club) => (
              <ClubRow
                key={club.id}
                club={club}
                added={isClubSelected(selection, club.id)}
                onAdd={() => onSelectionChange(addInviteClub(selection, club))}
              />
            ))}
          </View>
        </>
      ) : null}

      <Text style={styles.sectionLabel}>Players</Text>

      {search.isPending ? (
        <View style={styles.list} accessibilityLabel="Loading players">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={58} borderRadius={radius.md} />
          ))}
        </View>
      ) : search.isError ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>We could not search members.</Text>
          <PrimaryButton label="Try again" variant="secondary" onPress={() => void search.refetch()} />
        </View>
      ) : players.length === 0 ? (
        <EmptyStateView
          title={searching ? 'No members found' : 'Find your crew'}
          description={
            searching
              ? 'No member matches that name or ID.'
              : 'Search for club members by name or member ID to invite them.'
          }
        />
      ) : (
        <View style={styles.list}>
          {players.map((member) => (
            <PlayerRow
              key={member.id}
              member={member}
              selected={isMemberSelected(selection, member.id)}
              onToggle={() => onSelectionChange(toggleInviteMember(selection, member))}
            />
          ))}
        </View>
      )}

      {error ? (
        <Text accessibilityRole="alert" style={styles.formError}>
          {error}
        </Text>
      ) : null}
    </StepShell>
  );
}

function ClubRow({ club, added, onAdd }: { club: MyClub; added: boolean; onAdd: () => void }) {
  return (
    <View style={styles.row}>
      <Avatar name={club.name} size="md" />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {club.name}
        </Text>
        <Text style={styles.rowSubtitle}>
          {club.memberCount === 1 ? '1 member' : `${club.memberCount} members`}
        </Text>
      </View>
      {added ? (
        <Text style={styles.addedLabel}>Added</Text>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Add all members of ${club.name}`}
          onPress={onAdd}
          style={({ pressed }) => [styles.addAll, pressed ? styles.addAllPressed : null]}
        >
          <Text style={styles.addAllLabel}>Add all</Text>
        </Pressable>
      )}
    </View>
  );
}

function PlayerRow({
  member,
  selected,
  onToggle,
}: {
  member: MemberSearchResult;
  selected: boolean;
  onToggle: () => void;
}) {
  const name = memberDisplayName(member);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={selected ? `Remove ${name}` : `Invite ${name}`}
      onPress={onToggle}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      <Avatar name={name} src={member.avatarUrl} size="md" />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.rowSubtitle}>{memberNumberLabel(member.memberNumber)}</Text>
      </View>
      <View style={[styles.check, selected ? styles.checkSelected : null]}>
        {selected ? <Ionicons name="checkmark" size={16} color={colors.textOnAccent} /> : null}
      </View>
    </Pressable>
  );
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

const styles = StyleSheet.create({
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 15,
    paddingVertical: spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  list: {
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.sm,
    paddingRight: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowPressed: {
    opacity: 0.9,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    color: colors.text,
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
  },
  rowSubtitle: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 12,
  },
  addedLabel: {
    color: colors.textSubtle,
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
  },
  addAll: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  addAllPressed: {
    opacity: 0.9,
  },
  addAllLabel: {
    color: colors.textOnAccent,
    fontFamily: fonts.bodyBold,
    fontSize: 13,
  },
  check: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  checkSelected: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  errorBox: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  errorText: {
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  formError: {
    color: colors.danger,
    fontFamily: fonts.body,
    fontSize: 13,
  },
});
