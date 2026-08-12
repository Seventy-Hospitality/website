import { useEffect, useMemo, useState, type Ref } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Check, Search, UsersRound } from 'lucide-react';
import type { ClubRosterEntry, MemberSearchResult } from '../../lib/api';
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
  type InviteClub,
  type InviteSelection,
} from '../../lib/invites';
import { useSession } from '../../lib/session-context';
import { Avatar, Button, Chip, EmptyState, Skeleton } from '../../components';
import { clubRosterQuery, memberSearchQuery, myClubsQuery } from './booking-data';
import styles from './wizard.module.css';

const SEARCH_DEBOUNCE_MS = 250;

export interface InvitePlayersStepProps {
  headingRef: Ref<HTMLHeadingElement>;
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
 * Wizard step 2 (Figma invite-players 7:2482 / 77:2117 / 77:2233): search
 * by name or member ID, a CLUB row whose "Add all" produces a removable
 * "CLUB: name (n)" chip (expanded to the club's current roster
 * server-side), and individual player rows with check toggles. Inviting is
 * optional for the booking itself; the same component runs the
 * post-confirmation "Invite more players" flow, where it requires a pick.
 */
export function InvitePlayersStep({
  headingRef,
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
  const search = useQuery({ ...memberSearchQuery(debouncedQuery), enabled: searching });

  // With no search query the player list suggests the rosters of the
  // member's clubs (the Figma shows players before any search; there is no
  // member-directory listing endpoint, so club mates are the pool we have).
  const rosters = useQueries({
    queries: (clubs.data ?? []).map((club) => clubRosterQuery(club.id)),
  });

  const excluded = useMemo(
    () => new Set([memberId, ...excludeMemberIds].filter(Boolean) as string[]),
    [memberId, excludeMemberIds],
  );

  const players: MemberSearchResult[] = useMemo(() => {
    if (searching) {
      return (search.data ?? []).filter((member) => !excluded.has(member.id));
    }
    const seen = new Map<string, MemberSearchResult>();
    for (const roster of rosters) {
      for (const entry of roster.data ?? []) {
        if (excluded.has(entry.memberId) || seen.has(entry.memberId)) continue;
        seen.set(entry.memberId, rosterEntryToMember(entry));
      }
    }
    return [...seen.values()].sort((a, b) =>
      memberDisplayName(a).localeCompare(memberDisplayName(b)),
    );
  }, [searching, search.data, rosters, excluded]);

  const playersPending = searching
    ? search.isPending
    : clubs.isPending || rosters.some((roster) => roster.isPending && roster.fetchStatus !== 'idle');

  return (
    <div className={styles.step}>
      <h1 ref={headingRef} tabIndex={-1} className={styles.stepTitle}>
        Invite players
      </h1>
      <p className={styles.stepSubtitle}>{subtitle}</p>

      <div className={styles.searchBox}>
        <Search aria-hidden className={styles.searchIcon} />
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search by name or member ID"
          aria-label="Search by name or member ID"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {(selection.clubs.length > 0 || selection.members.length > 0) && (
        <ul className={styles.chipRow} aria-label="Selected invites">
          {selection.clubs.map((club) => (
            <li key={club.id}>
              <Chip
                label={clubChipLabel(club)}
                onRemove={() => onSelectionChange(removeInviteClub(selection, club.id))}
              />
            </li>
          ))}
          {selection.members.map((member) => (
            <li key={member.id}>
              <Chip
                label={memberDisplayName(member)}
                onRemove={() => onSelectionChange(removeInviteMember(selection, member.id))}
              />
            </li>
          ))}
        </ul>
      )}

      {clubs.isSuccess && clubs.data.length > 0 && (
        <>
          <div className={styles.sectionHead}>
            <span className={styles.sectionLabel}>Club</span>
          </div>
          <ul className={styles.inviteList}>
            {clubs.data.map((club) => (
              <ClubRow
                key={club.id}
                club={club}
                added={isClubSelected(selection, club.id)}
                onAdd={() => onSelectionChange(addInviteClub(selection, club))}
              />
            ))}
          </ul>
        </>
      )}

      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>Players</span>
      </div>

      {playersPending ? (
        <div className={styles.inviteList} aria-busy="true" role="status">
          <span className="visually-hidden">Loading players</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height="3.5rem" shape="card" />
          ))}
        </div>
      ) : searching && search.isError ? (
        <div className={styles.errorBox} role="alert">
          <p>We could not search members.</p>
          <Button variant="secondary" size="sm" onClick={() => void search.refetch()}>
            Try again
          </Button>
        </div>
      ) : players.length === 0 ? (
        <EmptyState
          icon={<UsersRound aria-hidden />}
          title={searching ? 'No members found' : 'Find your crew'}
          description={
            searching
              ? 'No member matches that name or ID.'
              : 'Search for club members by name or member ID to invite them.'
          }
        />
      ) : (
        <>
          <p role="status" className="visually-hidden">
            {players.length === 1 ? '1 player listed' : `${players.length} players listed`}
          </p>
          <ul className={styles.inviteList}>
            {players.map((member) => (
              <PlayerRow
                key={member.id}
                member={member}
                selected={isMemberSelected(selection, member.id)}
                onToggle={() => onSelectionChange(toggleInviteMember(selection, member))}
              />
            ))}
          </ul>
        </>
      )}

      {error && (
        <p role="alert" className={styles.payAlert}>
          {error}
        </p>
      )}

      <div className={styles.stepFooter}>
        <Button
          fullWidth
          disabled={continueDisabled}
          loading={continuePending}
          onClick={onContinue}
        >
          {continueLabel}
        </Button>
      </div>
    </div>
  );
}

function ClubRow({
  club,
  added,
  onAdd,
}: {
  club: InviteClub;
  added: boolean;
  onAdd: () => void;
}) {
  return (
    <li className={styles.inviteRow}>
      <Avatar name={club.name} size="md" />
      <span className={styles.inviteRowText}>
        <span className={styles.inviteRowTitle}>{club.name}</span>
        <span className={styles.inviteRowSubtitle}>
          {club.memberCount === 1 ? '1 member' : `${club.memberCount} members`}
        </span>
      </span>
      {added ? (
        <span className={styles.inviteRowAdded}>Added</span>
      ) : (
        <Button size="sm" onClick={onAdd}>
          Add all
        </Button>
      )}
    </li>
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
    <li className={styles.inviteRow}>
      <Avatar name={name} src={member.avatarUrl} size="md" />
      <span className={styles.inviteRowText}>
        <span className={styles.inviteRowTitle}>{name}</span>
        <span className={styles.inviteRowSubtitle}>{memberNumberLabel(member.memberNumber)}</span>
      </span>
      <button
        type="button"
        className={[styles.inviteCheck, selected ? styles.inviteCheckSelected : ''].join(' ')}
        aria-pressed={selected}
        aria-label={selected ? `Remove ${name}` : `Invite ${name}`}
        onClick={onToggle}
      >
        {selected && <Check aria-hidden strokeWidth={3} />}
      </button>
    </li>
  );
}

function rosterEntryToMember(entry: ClubRosterEntry): MemberSearchResult {
  return {
    id: entry.memberId,
    memberNumber: entry.memberNumber,
    firstName: entry.firstName,
    lastName: entry.lastName,
    displayName: entry.displayName,
    avatarUrl: entry.avatarUrl,
  };
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}
