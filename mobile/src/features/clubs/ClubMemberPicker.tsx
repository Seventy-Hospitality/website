import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import type { MemberSearchResult } from '../../lib/api';
import { Avatar, Chip, EmptyStateView, PrimaryButton, Skeleton } from '../../components';
import { colors, fonts, radius, spacing } from '../../theme/tokens';
import {
  isMemberSelected,
  removeInviteMember,
  toggleInviteMember,
  type InviteSelection,
} from '../reserve/invites';
import { clubDirectoryQuery } from './clubs-data';
import { memberDisplayName, memberNumberLabel } from './clubs-lib';

const SEARCH_DEBOUNCE_MS = 250;

interface ClubMemberPickerProps {
  selection: InviteSelection;
  onSelectionChange: (selection: InviteSelection) => void;
  /** Members already in the club (and the viewer) are not selectable. */
  excludeMemberIds?: string[];
}

/**
 * Member-only invite picker for the clubs surface (Figma invite-players
 * 95:4294 / invite modal 195:17988): search by name or member ID, removable
 * chips for the picks, and a check-toggle per directory row. Reuses the shared
 * invite-selection logic (src/features/reserve/invites) so clubs only ever
 * carry `selection.members` (no club "Add all" rows, since you invite people to
 * a club, not clubs to a club). Mirrors member-web's ClubMemberPicker, native.
 */
export function ClubMemberPicker({
  selection,
  onSelectionChange,
  excludeMemberIds = [],
}: ClubMemberPickerProps) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const searching = debouncedQuery.length > 0;

  const directory = useQuery(clubDirectoryQuery(debouncedQuery));

  const excluded = useMemo(
    () => new Set(excludeMemberIds.filter(Boolean)),
    [excludeMemberIds],
  );

  const players: MemberSearchResult[] = useMemo(
    () => (directory.data ?? []).filter((member) => !excluded.has(member.id)),
    [directory.data, excluded],
  );

  return (
    <View style={styles.root}>
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

      {selection.members.length > 0 ? (
        <View style={styles.chipRow} accessibilityLabel="Selected players">
          {selection.members.map((member) => (
            <Chip
              key={member.id}
              label={memberDisplayName(member)}
              onRemove={() => onSelectionChange(removeInviteMember(selection, member.id))}
            />
          ))}
        </View>
      ) : null}

      <Text style={styles.sectionLabel}>Players</Text>

      {directory.isPending ? (
        <View style={styles.list} accessibilityLabel="Loading players">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={58} borderRadius={radius.md} />
          ))}
        </View>
      ) : directory.isError ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text style={styles.errorText}>We could not load members.</Text>
          <PrimaryButton label="Try again" variant="secondary" onPress={() => void directory.refetch()} />
        </View>
      ) : players.length === 0 ? (
        <EmptyStateView
          title={searching ? 'No members found' : 'No members to invite'}
          description={
            searching
              ? 'No member matches that name or ID.'
              : 'Search for members by name or member ID to invite them.'
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
  root: {
    gap: spacing.md,
  },
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
  check: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderActive,
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
});
