import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Ellipsis, Plus, Search } from 'lucide-react';
import { api, ApiError, type ClubDetail, type ClubRosterEntry } from '../../lib/api';
import { memberDisplayName, memberNumberLabel } from '../../lib/invites';
import { useSession } from '../../lib/session-context';
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Sheet,
  Skeleton,
  useToast,
} from '../../components';
import { PageHeader } from '../../app/AppShell';
import { clubRosterQuery } from '../reserve/booking-data';
import { clubQuery } from './clubs-data';
import { InviteToClubSheet } from './InviteToClubSheet';
import styles from './clubs.module.css';

/**
 * The club roster (Figma clubs/court-booking-group 105:6876; the frame
 * name is a leftover, the content is the Members list): avatar, name,
 * member number, the Owner badge, and, for the owner, a per-row overflow
 * with Transfer ownership / Remove from club behind confirmations. The
 * "+" opens the invite modal. All management actions render from the
 * backend's permission flags.
 */
export function ClubMembersPage() {
  const { clubId = '' } = useParams();
  const detail = useQuery(clubQuery(clubId));
  const roster = useQuery(clubRosterQuery(clubId));

  if (detail.isPending || roster.isPending) {
    return (
      <div className={styles.page}>
        <BackToClub clubId={clubId} />
        <PageHeader title="Members" />
        <div role="status" aria-busy="true" className={styles.memberList}>
          <span className="visually-hidden">Loading members</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height="3.5rem" shape="card" />
          ))}
        </div>
      </div>
    );
  }

  if (detail.isError || roster.isError) {
    const error = detail.isError ? detail.error : roster.error;
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      return (
        <div className={styles.page}>
          <PageHeader title="Members" />
          <EmptyState
            icon={<Search aria-hidden />}
            title="Club not found"
            description="This club does not exist, was deleted, or you are not a member of it."
            action={<ButtonLink to="/clubs">Back to clubs</ButtonLink>}
          />
        </div>
      );
    }
    return (
      <div className={styles.page}>
        <BackToClub clubId={clubId} />
        <PageHeader title="Members" />
        <div className={styles.dialogBody} role="alert">
          <p>We could not load the members.</p>
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (detail.isError) void detail.refetch();
                if (roster.isError) void roster.refetch();
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <MembersView clubId={clubId} roster={roster.data} detail={detail.data} />;
}

function BackToClub({ clubId }: { clubId: string }) {
  return (
    <Link to={`/clubs/${clubId}`} className={styles.backLink}>
      <ChevronLeft aria-hidden />
      Back to club
    </Link>
  );
}

function MembersView({
  clubId,
  roster,
  detail,
}: {
  clubId: string;
  roster: ClubRosterEntry[];
  detail: ClubDetail;
}) {
  const { memberId } = useSession();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<ClubRosterEntry | null>(null);
  const [confirm, setConfirm] = useState<{
    action: 'transfer' | 'remove';
    entry: ClubRosterEntry;
  } | null>(null);

  const invalidateClub = () => {
    void queryClient.invalidateQueries({ queryKey: ['clubs'] });
  };

  const transfer = useMutation({
    mutationFn: (entry: ClubRosterEntry) =>
      api.changeClubMemberRole(clubId, entry.memberId, 'owner'),
    onSuccess: (_result, entry) => {
      setConfirm(null);
      // The whole ['clubs'] prefix moved: list roles, detail permissions,
      // and the roster's Owner badge.
      invalidateClub();
      toast({
        variant: 'success',
        message: `${memberDisplayName(entry)} is now the club owner.`,
      });
    },
    onError: (error) => {
      setConfirm(null);
      toast({
        variant: 'error',
        message:
          error instanceof ApiError && (error.status === 404 || error.status === 409)
            ? 'The club changed before that could be saved. Refreshing.'
            : 'We could not transfer ownership. Try again.',
      });
      invalidateClub();
    },
  });

  const remove = useMutation({
    mutationFn: (entry: ClubRosterEntry) => api.removeClubMember(clubId, entry.memberId),
    onSuccess: (_result, entry) => {
      setConfirm(null);
      queryClient.setQueryData<ClubRosterEntry[]>(['clubs', clubId, 'members'], (rows) =>
        rows?.filter((row) => row.memberId !== entry.memberId),
      );
      invalidateClub();
      toast({
        variant: 'success',
        message: `${memberDisplayName(entry)} was removed from the club.`,
      });
    },
    onError: (error) => {
      setConfirm(null);
      toast({
        variant: 'error',
        message:
          error instanceof ApiError && (error.status === 404 || error.status === 409)
            ? 'The club changed before that could be saved. Refreshing.'
            : 'We could not remove that member. Try again.',
      });
      invalidateClub();
    },
  });

  const canManage = detail.permissions.canManageMembers;

  return (
    <div className={styles.page}>
      <BackToClub clubId={clubId} />
      <PageHeader
        title="Members"
        actions={
          detail.permissions.canInvite ? (
            <button
              type="button"
              className={styles.addButton}
              aria-label="Invite to club"
              aria-haspopup="dialog"
              onClick={() => setInviteOpen(true)}
            >
              <Plus aria-hidden />
            </button>
          ) : undefined
        }
      />

      <ul className={styles.memberList} aria-label={`Members of ${detail.name}`}>
        {roster.map((entry) => {
          const isSelf = entry.memberId === memberId;
          const name = memberDisplayName(entry);
          // The owner row is never removable/demotable directly (ownership
          // moves by transfer), and nobody manages themselves.
          const showMenu = canManage && !isSelf && entry.role !== 'owner';
          return (
            <li key={entry.memberId} className={styles.memberRow}>
              <Avatar name={name} src={entry.avatarUrl} size="md" />
              <span className={styles.memberText}>
                <span className={styles.memberName}>
                  {name}
                  {isSelf && <span className="visually-hidden"> (you)</span>}
                  {entry.role === 'owner' && (
                    <Badge variant="neutral" aria-label={`${name} is the club owner`}>
                      Owner
                    </Badge>
                  )}
                </span>
                <span className={styles.memberNumber}>
                  {memberNumberLabel(entry.memberNumber)}
                </span>
              </span>
              {showMenu && (
                <button
                  type="button"
                  className={styles.memberMenuButton}
                  aria-label={`Actions for ${name}`}
                  aria-haspopup="dialog"
                  onClick={() => setMenuFor(entry)}
                >
                  <Ellipsis aria-hidden />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {/* ── Per-member actions (owner only) ── */}

      <Sheet
        open={menuFor !== null}
        onClose={() => setMenuFor(null)}
        title={menuFor ? memberDisplayName(menuFor) : 'Member'}
        footer={
          menuFor && (
            <div className={styles.dialogActions}>
              <Button
                fullWidth
                variant="secondary"
                onClick={() => {
                  setConfirm({ action: 'transfer', entry: menuFor });
                  setMenuFor(null);
                }}
              >
                Transfer ownership
              </Button>
              <Button
                fullWidth
                variant="danger"
                onClick={() => {
                  setConfirm({ action: 'remove', entry: menuFor });
                  setMenuFor(null);
                }}
              >
                Remove from club
              </Button>
            </div>
          )
        }
      >
        {menuFor && (
          <div className={styles.dialogBody}>
            <p className={styles.dialogHint}>
              Transferring makes {memberDisplayName(menuFor)} the owner and you a regular
              member; removing takes them off the club roster.
            </p>
          </div>
        )}
      </Sheet>

      {/* ── Transfer-ownership confirmation ── */}

      <Sheet
        open={confirm?.action === 'transfer'}
        onClose={() => {
          if (!transfer.isPending) setConfirm(null);
        }}
        title="Transfer ownership"
        footer={
          confirm && (
            <div className={styles.dialogActions}>
              <Button
                fullWidth
                loading={transfer.isPending}
                onClick={() => transfer.mutate(confirm.entry)}
              >
                Make {memberDisplayName(confirm.entry)} the owner
              </Button>
              <Button
                variant="secondary"
                fullWidth
                disabled={transfer.isPending}
                onClick={() => setConfirm(null)}
              >
                Cancel
              </Button>
            </div>
          )
        }
      >
        {confirm && (
          <div className={styles.dialogBody}>
            <p className={styles.dialogText}>
              Make {memberDisplayName(confirm.entry)} the owner of {detail.name}?
            </p>
            <p className={styles.dialogHint}>
              You become a regular member and lose owner controls (editing the club, managing
              members, deleting it). Only the new owner can transfer it back.
            </p>
          </div>
        )}
      </Sheet>

      {/* ── Remove-member confirmation ── */}

      <Sheet
        open={confirm?.action === 'remove'}
        onClose={() => {
          if (!remove.isPending) setConfirm(null);
        }}
        title="Remove member"
        footer={
          confirm && (
            <div className={styles.dialogActions}>
              <Button
                variant="danger"
                fullWidth
                loading={remove.isPending}
                onClick={() => remove.mutate(confirm.entry)}
              >
                Remove from club
              </Button>
              <Button
                variant="secondary"
                fullWidth
                disabled={remove.isPending}
                onClick={() => setConfirm(null)}
              >
                Cancel
              </Button>
            </div>
          )
        }
      >
        {confirm && (
          <div className={styles.dialogBody}>
            <p className={styles.dialogText}>
              Remove {memberDisplayName(confirm.entry)} from {detail.name}? They can be
              invited again later.
            </p>
          </div>
        )}
      </Sheet>

      <InviteToClubSheet
        clubId={clubId}
        clubName={detail.name}
        canRotateLink={canManage}
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
      />
    </div>
  );
}
