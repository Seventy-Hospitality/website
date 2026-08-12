import { useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, UsersRound } from 'lucide-react';
import type { ClubInvitation, MyClub } from '../../lib/api';
import { Button, ButtonLink, Card, IconTile, Skeleton, useToast } from '../../components';
import { PageHeader } from '../../app/AppShell';
import {
  isClubInviteConflict,
  useRespondToClubInvitation,
} from '../home/home-data';
import { myClubsQuery } from '../reserve/booking-data';
import { myClubInvitationsQuery } from './clubs-data';
import { memberCountLabel, roleLabel } from './clubs-lib';
import styles from './clubs.module.css';

/**
 * The Clubs tab (Figma clubs/your-clubs 91:3774 / two-clubs 91:3935): the
 * member's clubs as cover cards (name, member count, their role), the
 * dashed "Create a new club" CTA, and any pending club invitations with
 * inline Accept/Decline (the same respond flow as home). Cards go
 * two-across from the md breakpoint.
 */
export function ClubsPage() {
  const clubs = useQuery(myClubsQuery);
  const invitations = useQuery(myClubInvitationsQuery);
  const { toast } = useToast();

  // Responding unmounts the pressed card (optimistic removal); park focus
  // on the section heading, or the page heading when the section empties
  // (home's pattern; see HomePage).
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const invitesHeadingRef = useRef<HTMLHeadingElement>(null);

  const respond = useRespondToClubInvitation();
  const respondToInvitation = useCallback(
    (invitation: ClubInvitation, response: 'accept' | 'decline') => {
      const emptiesSection = (invitations.data?.length ?? 0) <= 1;
      const target = emptiesSection ? pageHeadingRef : invitesHeadingRef;
      window.setTimeout(() => (target.current ?? pageHeadingRef.current)?.focus(), 0);
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
    },
    [invitations.data, respond, toast],
  );

  // The card grid fills the wide desktop column; the empty state and the
  // loading skeleton stay in the comfortable reading column so a single CTA
  // is not stranded across the full width.
  const wide = clubs.isSuccess && clubs.data.length > 0;

  return (
    <div className={[styles.page, wide ? styles.pageWide : ''].filter(Boolean).join(' ')}>
      <PageHeader
        title="Your clubs"
        headingRef={pageHeadingRef}
        actions={
          <Link to="/clubs/new" className={styles.addButton} aria-label="Create a new club">
            <Plus aria-hidden />
          </Link>
        }
      />
      <p className={styles.sublead}>Create clubs to book together and track stats</p>

      {clubs.isPending ? (
        <div className={styles.clubGrid} role="status" aria-busy="true">
          <span className="visually-hidden">Loading your clubs</span>
          <Skeleton height="13rem" shape="card" />
          <Skeleton height="4.5rem" shape="card" />
        </div>
      ) : clubs.isError ? (
        <Card role="alert" className={styles.dialogBody}>
          <p>We could not load your clubs.</p>
          <Button variant="secondary" size="sm" onClick={() => void clubs.refetch()}>
            Try again
          </Button>
        </Card>
      ) : clubs.data.length === 0 ? (
        <ClubsEmptyState hasInvitations={(invitations.data?.length ?? 0) > 0} />
      ) : (
        <ul className={styles.clubGrid}>
          {clubs.data.map((club) => (
            <li key={club.id}>
              <ClubCard club={club} />
            </li>
          ))}
          <li>
            <Link to="/clubs/new" className={styles.createCard}>
              <Plus aria-hidden />
              Create a new club
            </Link>
          </li>
        </ul>
      )}

      {invitations.isSuccess && invitations.data.length > 0 && (
        <section className={styles.section} aria-labelledby="clubs-invitations">
          <h2 id="clubs-invitations" tabIndex={-1} ref={invitesHeadingRef}>
            Invitations
          </h2>
          <ul className={styles.cardStack}>
            {invitations.data.map((invitation) => (
              <li key={invitation.id}>
                <InvitationCard
                  invitation={invitation}
                  onRespond={respondToInvitation}
                  pendingResponse={
                    respond.isPending && respond.variables.invitationId === invitation.id
                      ? respond.variables.response
                      : null
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ClubCard({ club }: { club: MyClub }) {
  return (
    <Link
      to={`/clubs/${club.id}`}
      className={styles.clubCard}
      aria-label={`${club.name}: ${memberCountLabel(club.memberCount)}, you are ${
        club.myRole === 'owner' ? 'the owner' : 'a member'
      }`}
    >
      {club.coverImageUrl ? (
        <img className={styles.clubCover} src={club.coverImageUrl} alt="" loading="lazy" />
      ) : (
        <span className={styles.clubCoverFallback} aria-hidden>
          <UsersRound />
        </span>
      )}
      <span className={styles.clubShade} aria-hidden />
      <span className={styles.clubCardText}>
        <span className={styles.clubCardName}>{club.name}</span>
        <span className={styles.clubCardMeta} aria-hidden>
          {memberCountLabel(club.memberCount)}
          <span className={styles.metaDivider}>|</span>
          {roleLabel(club.myRole)}
        </span>
      </span>
    </Link>
  );
}

function ClubsEmptyState({ hasInvitations }: { hasInvitations: boolean }) {
  return (
    <Card padding="lg" className={styles.joinBody}>
      <p className={styles.dialogText}>
        {hasInvitations
          ? 'You are not in a club yet, but you have invitations waiting below.'
          : 'You are not in a club yet. Create one to book together and track stats with your crew.'}
      </p>
      <div>
        <ButtonLink to="/clubs/new" icon={<Plus aria-hidden />}>
          Create a new club
        </ButtonLink>
      </div>
    </Card>
  );
}

function InvitationCard({
  invitation,
  onRespond,
  pendingResponse,
}: {
  invitation: ClubInvitation;
  onRespond: (invitation: ClubInvitation, response: 'accept' | 'decline') => void;
  pendingResponse: 'accept' | 'decline' | null;
}) {
  const inviter = invitation.invitedBy?.firstName ?? null;

  return (
    <Card>
      <p className={styles.inviterLine}>
        <span className={styles.inviterName}>{inviter ?? 'A member'}</span> invited you
      </p>
      <div className={styles.inviteHead}>
        <IconTile>
          <UsersRound aria-hidden />
        </IconTile>
        <div className={styles.inviteHeadText}>
          <span className={styles.inviteClubName}>{invitation.club.name}</span>
          <span className={styles.inviteClubMeta}>
            {memberCountLabel(invitation.club.memberCount)}
          </span>
        </div>
      </div>
      <div
        className={styles.respondRow}
        role="group"
        aria-label={`Respond to the ${invitation.club.name} invitation`}
      >
        <Button
          fullWidth
          loading={pendingResponse === 'accept'}
          disabled={pendingResponse !== null}
          onClick={() => onRespond(invitation, 'accept')}
        >
          Accept
        </Button>
        <Button
          variant="secondary"
          fullWidth
          loading={pendingResponse === 'decline'}
          disabled={pendingResponse !== null}
          onClick={() => onRespond(invitation, 'decline')}
        >
          Decline
        </Button>
      </div>
    </Card>
  );
}
