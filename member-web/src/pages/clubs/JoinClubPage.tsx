import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, LinkIcon, UsersRound } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Button, ButtonLink, Card, EmptyState, Skeleton, useToast } from '../../components';
import { PageHeader } from '../../app/AppShell';
import { memberCountLabel } from './clubs-lib';
import styles from './clubs.module.css';

/**
 * Landing for club invite links and QR codes (/clubs/join?token=...): the
 * token resolves to a club preview (POST /api/clubs/invite-preview), the
 * member confirms with Join club (POST /api/clubs/join). Dead links answer
 * 410 INVITE_LINK_INVALID with a human reason (revoked / expired / used
 * up), rendered as-is; existing members get a shortcut into the club
 * instead of a join button.
 */
export function JoinClubPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';

  return (
    <div className={styles.page}>
      <Link to="/clubs" className={styles.backLink}>
        <ChevronLeft aria-hidden />
        Back to clubs
      </Link>
      <PageHeader title="Join club" />
      {token ? (
        <JoinPreview token={token} />
      ) : (
        <EmptyState
          icon={<LinkIcon aria-hidden />}
          title="Invite link not valid"
          description="This link is missing its invite code. Ask a club member to share the link again."
          action={<ButtonLink to="/clubs">Back to clubs</ButtonLink>}
        />
      )}
    </div>
  );
}

/** 410 INVITE_LINK_INVALID carries the human reason; everything else is generic. */
function deadLinkMessage(error: unknown): string | null {
  if (error instanceof ApiError && error.status === 410) return error.message;
  if (error instanceof ApiError && error.status === 404) {
    return 'This invite link is not valid.';
  }
  return null;
}

function JoinPreview({ token }: { token: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const preview = useQuery({
    queryKey: ['clubs', 'invite-preview', token],
    queryFn: () => api.previewClubInvite(token),
    staleTime: 0,
    // A dead link will not heal; the shared client already skips 4xx retries.
    retry: false,
  });

  const join = useMutation({
    mutationFn: () => api.joinClub(token),
    onSuccess: ({ club, alreadyMember }) => {
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
      // Joining via link accepts any pending invitation to the same club
      // server-side, so refresh the pending list too: otherwise the clubs
      // tab keeps a phantom invite card for a club the member is now in
      // (home carries its own copy and is refreshed below).
      void queryClient.invalidateQueries({ queryKey: ['club-invitations'] });
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      toast({
        variant: 'success',
        message: alreadyMember
          ? `You are already a member of ${club.name}.`
          : `Welcome to ${club.name}!`,
      });
      navigate(`/clubs/${club.id}`, { replace: true });
    },
    onError: (error) => {
      const dead = deadLinkMessage(error);
      toast({
        variant: 'error',
        message: dead ?? 'We could not join the club. Try again.',
      });
      if (dead) {
        // Reflect the dead link in the preview panel too.
        void preview.refetch();
      }
    },
  });

  if (preview.isPending) {
    return (
      <div role="status" aria-busy="true" className={styles.section}>
        <span className="visually-hidden">Checking your invite link</span>
        <Skeleton height="14rem" shape="card" />
      </div>
    );
  }

  if (preview.isError) {
    const dead = deadLinkMessage(preview.error);
    if (dead) {
      return (
        // This replaces the pending role=status region; without a live
        // region of its own the outcome would never be announced, and the
        // dead link is the very thing this landing exists to report. Mount
        // it as an alert like the generic error branch below.
        <div role="alert">
          <EmptyState
            icon={<LinkIcon aria-hidden />}
            title="Invite link not usable"
            description={`${dead} Ask a club member for a fresh invite link.`}
            action={<ButtonLink to="/clubs">Back to clubs</ButtonLink>}
          />
        </div>
      );
    }
    return (
      <div className={styles.dialogBody} role="alert">
        <p>We could not check this invite link.</p>
        <div>
          <Button variant="secondary" size="sm" onClick={() => void preview.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const { club, alreadyMember } = preview.data;

  return (
    <Card padding="md" className={styles.joinCard}>
      {club.coverImageUrl ? (
        <img className={styles.joinCover} src={club.coverImageUrl} alt="" />
      ) : null}
      <div className={styles.joinBody}>
        <p className={styles.inviterLine}>You are invited to join</p>
        <div className={styles.inviteHead}>
          <span className={styles.actionCircle} aria-hidden>
            <UsersRound />
          </span>
          <div className={styles.inviteHeadText}>
            <span className={styles.inviteClubName}>{club.name}</span>
            <span className={styles.inviteClubMeta}>{memberCountLabel(club.memberCount)}</span>
          </div>
        </div>
        {club.description && <p className={styles.description}>{club.description}</p>}
        {alreadyMember ? (
          <>
            <p className={styles.dialogHint}>You are already a member of this club.</p>
            <ButtonLink to={`/clubs/${club.id}`} fullWidth>
              Open {club.name}
            </ButtonLink>
          </>
        ) : (
          <Button fullWidth loading={join.isPending} onClick={() => join.mutate()}>
            Join club
          </Button>
        )}
      </div>
    </Card>
  );
}
