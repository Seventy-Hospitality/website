import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarPlus,
  ChevronLeft,
  EllipsisVertical,
  Search,
  Share2,
  UserRoundPlus,
  UsersRound,
} from 'lucide-react';
import { api, ApiError, type ClubActivityItem, type ClubDetail, type MyClub } from '../../lib/api';
import { formatTimeRangeCompact } from '../../lib/booking';
import { Badge, Button, ButtonLink, EmptyState, Sheet, Skeleton, useToast } from '../../components';
import { clubActivityQuery, clubQuery, useClubInviteLink } from './clubs-data';
import {
  activityDayLabel,
  isUpcomingActivity,
  memberCountLabel,
  playersCountLabel,
  roleLabel,
} from './clubs-lib';
import { EditClubSheet } from './EditClubSheet';
import { InviteToClubSheet } from './InviteToClubSheet';
import styles from './clubs.module.css';

/**
 * Club detail (Figma clubs/court-review 99:5623 empty, court-booking-alt
 * 105:5927 populated; the frame names are leftovers, the content is club
 * detail): cover hero with back + overflow, name / member count / viewer
 * role / description, the Members-Invite-Share-Book action bar, and the
 * GROUP ACTIVITY feed of club-linked reservations. Actions render from the
 * backend's permission flags, never from the role directly. Desktop puts
 * info and activity side by side.
 */
export function ClubDetailPage() {
  const { clubId = '' } = useParams();
  const detail = useQuery(clubQuery(clubId));

  if (detail.isPending) {
    return (
      <div className={styles.page}>
        <BackToClubs />
        <div role="status" aria-busy="true" className={styles.detailGrid}>
          <span className="visually-hidden">Loading club</span>
          <Skeleton height="16rem" shape="card" />
          <Skeleton height="8rem" shape="card" />
        </div>
      </div>
    );
  }

  if (detail.isError) {
    const error = detail.error;
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      // The backend answers 404 for outsiders on purpose: a club you are
      // not a member of looks exactly like one that does not exist.
      return (
        <div className={styles.page}>
          <BackToClubs />
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
        <BackToClubs />
        <div className={styles.dialogBody} role="alert">
          <p>We could not load this club.</p>
          <div>
            <Button variant="secondary" size="sm" onClick={() => void detail.refetch()}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <ClubDetailView club={detail.data} />;
}

function BackToClubs() {
  return (
    <Link to="/clubs" className={styles.backLink}>
      <ChevronLeft aria-hidden />
      Back to clubs
    </Link>
  );
}

function ClubDetailView({ club }: { club: ClubDetail }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirm, setConfirm] = useState<'delete' | 'leave' | null>(null);

  const activity = useQuery(clubActivityQuery(club.id));
  const link = useClubInviteLink(club.id);

  async function share() {
    try {
      const url = await link.ensureUrl();
      if (typeof navigator.share === 'function') {
        try {
          await navigator.share({ title: `Join ${club.name} on Club70`, url });
        } catch {
          // A cancelled share is not an error.
        }
        return;
      }
      await navigator.clipboard.writeText(url);
      toast({ variant: 'success', message: 'Invite link copied.' });
    } catch {
      toast({ variant: 'error', message: 'We could not share an invite link. Try again.' });
    }
  }

  /**
   * Leaving is optimistic: the club drops out of the ['clubs'] list and
   * the member lands back on the list immediately; a failure rolls the
   * cache back. All side effects live in OPTION-level callbacks: this page
   * unmounts on the onMutate navigation, and only option callbacks (not
   * mutate-time ones) still run after unmount.
   */
  const leave = useMutation({
    mutationFn: () => api.leaveClub(club.id),
    onMutate: async () => {
      setConfirm(null);
      await queryClient.cancelQueries({ queryKey: ['clubs'], exact: true });
      const previous = queryClient.getQueryData<MyClub[]>(['clubs']);
      queryClient.setQueryData<MyClub[]>(['clubs'], (rows) =>
        rows?.filter((row) => row.id !== club.id),
      );
      navigate('/clubs');
      return { previous };
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['clubs', club.id] });
      toast({ variant: 'success', message: `You left ${club.name}.` });
    },
    onError: (error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(['clubs'], context.previous);
      }
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

  const deleteClub = useMutation({
    mutationFn: () => api.deleteClub(club.id),
    onSuccess: () => {
      setConfirm(null);
      navigate('/clubs');
      queryClient.removeQueries({ queryKey: ['clubs', club.id] });
      void queryClient.invalidateQueries({ queryKey: ['clubs'], exact: true });
      // Club reservations unlink server-side; home may render them.
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      toast({ variant: 'success', message: `${club.name} was deleted.` });
    },
    onError: () => {
      setConfirm(null);
      toast({ variant: 'error', message: 'We could not delete this club. Try again.' });
      void queryClient.invalidateQueries({ queryKey: ['clubs', club.id] });
    },
  });

  const permissions = club.permissions;
  const hasMenu = permissions.canEdit || permissions.canDelete || permissions.canLeave;

  return (
    <div className={styles.page}>
      <div className={styles.detailGrid}>
        <div className={[styles.section, styles.detailMain].join(' ')}>
          <section className={styles.hero} aria-label={`${club.name} cover`}>
            {club.coverImageUrl ? (
              <img className={styles.heroCover} src={club.coverImageUrl} alt="" />
            ) : (
              <span className={styles.heroFallback} aria-hidden>
                <UsersRound />
              </span>
            )}
            <span className={styles.heroShade} aria-hidden />
            <div className={styles.heroTop}>
              <Link to="/clubs" className={styles.heroButton} aria-label="Back to clubs">
                <ChevronLeft aria-hidden />
              </Link>
              {hasMenu && (
                <button
                  type="button"
                  className={styles.heroButton}
                  aria-label="Club actions"
                  aria-haspopup="dialog"
                  onClick={() => setMenuOpen(true)}
                >
                  <EllipsisVertical aria-hidden />
                </button>
              )}
            </div>
            <div className={styles.heroText}>
              <h1>{club.name}</h1>
              <p className={styles.heroMeta}>
                {memberCountLabel(club.memberCount)}
                <span className={styles.metaDivider} aria-hidden>
                  |
                </span>
                <span aria-label={`Your role: ${roleLabel(club.myRole)}`}>
                  {roleLabel(club.myRole)}
                </span>
              </p>
            </div>
          </section>

          {club.description && <p className={styles.description}>{club.description}</p>}

          <nav className={styles.actionBar} aria-label="Club actions">
            <Link to={`/clubs/${club.id}/members`} className={styles.actionItem}>
              <span className={styles.actionCircle} aria-hidden>
                <UsersRound />
              </span>
              Members
            </Link>
            {permissions.canInvite && (
              <button
                type="button"
                className={styles.actionItem}
                aria-haspopup="dialog"
                onClick={() => setInviteOpen(true)}
              >
                <span className={styles.actionCircle} aria-hidden>
                  <UserRoundPlus />
                </span>
                Invite
              </button>
            )}
            <button
              type="button"
              className={styles.actionItem}
              disabled={link.isPending}
              onClick={() => void share()}
            >
              <span className={styles.actionCircle} aria-hidden>
                <Share2 />
              </span>
              Share
            </button>
            <Link
              to={`/reserve?club=${encodeURIComponent(club.id)}`}
              className={styles.actionItem}
              aria-label={`Book for ${club.name}`}
            >
              <span className={styles.actionCircle} aria-hidden>
                <CalendarPlus />
              </span>
              Book
            </Link>
          </nav>
        </div>

        <section className={styles.section} aria-labelledby="club-activity">
          <h2 id="club-activity">Group activity</h2>
          {activity.isPending ? (
            <div className={styles.activityList} role="status" aria-busy="true">
              <span className="visually-hidden">Loading group activity</span>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height="4.5rem" shape="card" />
              ))}
            </div>
          ) : activity.isError ? (
            <div className={styles.dialogBody} role="alert">
              <p>We could not load the group activity.</p>
              <div>
                <Button variant="secondary" size="sm" onClick={() => void activity.refetch()}>
                  Try again
                </Button>
              </div>
            </div>
          ) : activity.data.length === 0 ? (
            <p className={styles.activityEmpty}>
              No group activity yet
              <Link
                to={`/reserve?club=${encodeURIComponent(club.id)}`}
                className={styles.activityEmptyLink}
              >
                Create an event
              </Link>
            </p>
          ) : (
            <ul className={styles.activityList}>
              {activity.data.map((item) => (
                <li key={item.id}>
                  <ActivityRow item={item} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ── Overflow menu (owner: edit/delete; member: leave) ── */}

      <Sheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={club.name}
        footer={
          <div className={styles.dialogActions}>
            {permissions.canEdit && (
              <Button
                fullWidth
                variant="secondary"
                onClick={() => {
                  setMenuOpen(false);
                  setEditOpen(true);
                }}
              >
                Edit club
              </Button>
            )}
            {permissions.canLeave && (
              <Button
                fullWidth
                variant="danger"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirm('leave');
                }}
              >
                Leave club
              </Button>
            )}
            {permissions.canDelete && (
              <Button
                fullWidth
                variant="danger"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirm('delete');
                }}
              >
                Delete club
              </Button>
            )}
          </div>
        }
      >
        <div className={styles.dialogBody}>
          {!permissions.canLeave && (
            <p className={styles.dialogHint}>
              As the owner you cannot leave this club; transfer ownership to another member
              first (Members, then the member&apos;s menu).
            </p>
          )}
        </div>
      </Sheet>

      {/* ── Leave confirmation ── */}

      <Sheet
        open={confirm === 'leave'}
        onClose={() => {
          if (!leave.isPending) setConfirm(null);
        }}
        title="Leave club"
        footer={
          <div className={styles.dialogActions}>
            <Button
              variant="danger"
              fullWidth
              loading={leave.isPending}
              onClick={() => leave.mutate()}
            >
              Leave club
            </Button>
            <Button
              variant="secondary"
              fullWidth
              disabled={leave.isPending}
              onClick={() => setConfirm(null)}
            >
              Stay in the club
            </Button>
          </div>
        }
      >
        <div className={styles.dialogBody}>
          <p className={styles.dialogText}>
            Leave {club.name}? You will need a new invitation or invite link to rejoin.
          </p>
        </div>
      </Sheet>

      {/* ── Delete confirmation ── */}

      <Sheet
        open={confirm === 'delete'}
        onClose={() => {
          if (!deleteClub.isPending) setConfirm(null);
        }}
        title="Delete club"
        footer={
          <div className={styles.dialogActions}>
            <Button
              variant="danger"
              fullWidth
              loading={deleteClub.isPending}
              onClick={() => deleteClub.mutate()}
            >
              Delete club
            </Button>
            <Button
              variant="secondary"
              fullWidth
              disabled={deleteClub.isPending}
              onClick={() => setConfirm(null)}
            >
              Keep the club
            </Button>
          </div>
        }
      >
        <div className={styles.dialogBody}>
          <p className={styles.dialogText}>
            Delete {club.name} for {memberCountLabel(club.memberCount).toLowerCase()}? Pending
            invitations and invite links stop working. This cannot be undone.
          </p>
        </div>
      </Sheet>

      {permissions.canEdit && (
        <EditClubSheet club={club} open={editOpen} onClose={() => setEditOpen(false)} />
      )}

      <InviteToClubSheet
        clubId={club.id}
        clubName={club.name}
        canRotateLink={permissions.canManageMembers}
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
      />
    </div>
  );
}

function ActivityRow({ item }: { item: ClubActivityItem }) {
  const upcoming = isUpcomingActivity(item);
  const label =
    `${activityDayLabel(item.date)}, ${formatTimeRangeCompact(item.startTime, item.endTime)}, ` +
    `${item.resource.name}, ${playersCountLabel(item.confirmedCount)}` +
    (upcoming ? ', upcoming' : item.status === 'cancelled' ? ', cancelled' : '');

  const content = (
    <>
      <span className={styles.activityText}>
        <span className={styles.activityWhen}>
          <span className={styles.activityDay}>{activityDayLabel(item.date)}</span>
          <span className={styles.activityTime}>
            {formatTimeRangeCompact(item.startTime, item.endTime)}
          </span>
        </span>
        <span className={styles.activitySub}>
          {item.resource.name} · {playersCountLabel(item.confirmedCount)}
        </span>
      </span>
      {upcoming ? (
        <Badge variant="success">Upcoming</Badge>
      ) : item.status === 'cancelled' ? (
        <Badge variant="danger">Cancelled</Badge>
      ) : null}
    </>
  );

  // The reservation detail is participant-scoped (404 for everyone else),
  // so only rows the viewer is on link through to it.
  if (item.myParticipation) {
    return (
      <Link to={`/reservations/${item.id}`} className={styles.activityRow} aria-label={label}>
        {content}
      </Link>
    );
  }
  return (
    <div className={styles.activityRow} aria-label={label}>
      {content}
    </div>
  );
}
