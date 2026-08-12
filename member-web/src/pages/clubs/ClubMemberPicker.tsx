import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Search, UsersRound } from 'lucide-react';
import type { MemberSearchResult } from '../../lib/api';
import {
  isMemberSelected,
  memberDisplayName,
  memberNumberLabel,
  removeInviteMember,
  toggleInviteMember,
  type InviteSelection,
} from '../../lib/invites';
import { Avatar, Button, Chip, EmptyState, Skeleton } from '../../components';
// The picker is visually the booking wizard's invite step (search box,
// chips, PLAYERS rows with check toggles); reuse its styles verbatim.
import wizardStyles from '../reserve/wizard.module.css';
import { clubDirectoryQuery } from './clubs-data';

const SEARCH_DEBOUNCE_MS = 250;

export interface ClubMemberPickerProps {
  /** Individually picked members ride selection.members; clubs stay []. */
  selection: InviteSelection;
  onSelectionChange: (selection: InviteSelection) => void;
  /** Hidden from the list: the viewer plus the club's current roster. */
  excludeMemberIds?: string[];
}

/**
 * The club invite picker (Figma clubs/invite-players 95:4294 / 99:5498 and
 * the invite modal 195:17988): search by name or member ID with the
 * default member directory before any query (Wback's directory page),
 * selected players as removable chips, rows with check toggles. Same
 * selection logic as the booking wizard's picker (src/lib/invites.ts);
 * clubs invite members only, so no club chips here.
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

  const excluded = useMemo(() => new Set(excludeMemberIds), [excludeMemberIds]);
  const players: MemberSearchResult[] = useMemo(
    () => (directory.data ?? []).filter((member) => !excluded.has(member.id)),
    [directory.data, excluded],
  );

  return (
    <div>
      <div className={wizardStyles.searchBox}>
        <Search aria-hidden className={wizardStyles.searchIcon} />
        <input
          type="search"
          className={wizardStyles.searchInput}
          placeholder="Search by name or member ID"
          aria-label="Search by name or member ID"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {selection.members.length > 0 && (
        <ul className={wizardStyles.chipRow} aria-label="Selected players">
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

      <div className={wizardStyles.sectionHead}>
        <span className={wizardStyles.sectionLabel}>Players</span>
      </div>

      {directory.isPending ? (
        <div className={wizardStyles.inviteList} aria-busy="true" role="status">
          <span className="visually-hidden">Loading players</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height="3.5rem" shape="card" />
          ))}
        </div>
      ) : directory.isError ? (
        <div className={wizardStyles.errorBox} role="alert">
          <p>We could not load members.</p>
          <Button variant="secondary" size="sm" onClick={() => void directory.refetch()}>
            Try again
          </Button>
        </div>
      ) : players.length === 0 ? (
        <EmptyState
          icon={<UsersRound aria-hidden />}
          title={searching ? 'No members found' : 'No members to invite'}
          description={
            searching
              ? 'No member matches that name or ID.'
              : 'Search for members by name or member ID to invite them.'
          }
        />
      ) : (
        <>
          <p role="status" className="visually-hidden">
            {players.length === 1 ? '1 player listed' : `${players.length} players listed`}
          </p>
          <ul className={wizardStyles.inviteList}>
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
    </div>
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
    <li className={wizardStyles.inviteRow}>
      <Avatar name={name} src={member.avatarUrl} size="md" />
      <span className={wizardStyles.inviteRowText}>
        <span className={wizardStyles.inviteRowTitle}>{name}</span>
        <span className={wizardStyles.inviteRowSubtitle}>
          {memberNumberLabel(member.memberNumber)}
        </span>
      </span>
      <button
        type="button"
        className={[
          wizardStyles.inviteCheck,
          selected ? wizardStyles.inviteCheckSelected : '',
        ].join(' ')}
        aria-pressed={selected}
        aria-label={selected ? `Remove ${name}` : `Invite ${name}`}
        onClick={onToggle}
      >
        {selected && <Check aria-hidden strokeWidth={3} />}
      </button>
    </li>
  );
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}
