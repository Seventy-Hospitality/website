import { useMemo, useState, type MutableRefObject, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link2, QrCode, Share2 } from 'lucide-react';
import { api } from '../../lib/api';
import { EMPTY_INVITE_SELECTION, type InviteSelection } from '../../lib/invites';
import { qrSvgData } from '../../lib/qr';
import { useSession } from '../../lib/session-context';
import { Button, Sheet, useToast } from '../../components';
import { clubRosterQuery } from '../reserve/booking-data';
import { ClubMemberPicker } from './ClubMemberPicker';
import { useClubInviteLink } from './clubs-data';
import styles from './clubs.module.css';

export interface InviteToClubSheetProps {
  clubId: string;
  clubName: string;
  /** Owner-only extras (rotate = revoke previous links). */
  canRotateLink: boolean;
  open: boolean;
  onClose: () => void;
}

/**
 * The "Invite to Club" modal (Figma clubs/invite-players-modal 195:17988):
 * Copy Link / QR Code / Share on top (all riding one lazily minted share
 * link), then the member picker; Add sends batch invitations, which the
 * invitees must accept. The QR encodes the join URL and shows it as text
 * for failed scans. The body mounts only while open (the MemberQrSheet
 * pattern), so the directory and roster queries never run for a closed
 * sheet and the selection resets per open; the minted link outlives the
 * body so reopening reuses it.
 */
export function InviteToClubSheet({
  clubId,
  clubName,
  canRotateLink,
  open,
  onClose,
}: InviteToClubSheetProps) {
  // The Sheet's Close/Escape must not interrupt an in-flight send.
  const sendingRef = useRef(false);
  const link = useClubInviteLink(clubId);

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!sendingRef.current) onClose();
      }}
      title="Invite to Club"
    >
      {open && (
        <InviteSheetBody
          clubId={clubId}
          clubName={clubName}
          canRotateLink={canRotateLink}
          link={link}
          sendingRef={sendingRef}
          onClose={onClose}
        />
      )}
    </Sheet>
  );
}

function InviteSheetBody({
  clubId,
  clubName,
  canRotateLink,
  link,
  sendingRef,
  onClose,
}: {
  clubId: string;
  clubName: string;
  canRotateLink: boolean;
  link: ReturnType<typeof useClubInviteLink>;
  sendingRef: MutableRefObject<boolean>;
  onClose: () => void;
}) {
  const { memberId } = useSession();
  const { toast } = useToast();
  const [selection, setSelection] = useState<InviteSelection>(EMPTY_INVITE_SELECTION);
  const [qrOpen, setQrOpen] = useState(false);

  const qr = useMemo(() => (link.url ? qrSvgData(link.url) : null), [link.url]);

  // Current members never appear in the picker.
  const roster = useQuery(clubRosterQuery(clubId));
  const excludeMemberIds = useMemo(
    () => [
      ...(memberId ? [memberId] : []),
      ...(roster.data ?? []).map((entry) => entry.memberId),
    ],
    [memberId, roster.data],
  );

  async function withLink(action: (url: string) => Promise<void> | void) {
    try {
      const url = await link.ensureUrl();
      await action(url);
    } catch {
      toast({ variant: 'error', message: 'We could not create an invite link. Try again.' });
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast({ variant: 'success', message: 'Invite link copied.' });
    } catch {
      // Clipboard access can be denied; the QR panel shows the URL as
      // selectable text instead.
      setQrOpen(true);
      toast({ variant: 'error', message: 'Copying failed. The link is shown below instead.' });
    }
  }

  async function shareUrl(url: string) {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: `Join ${clubName} on Club70`, url });
      } catch {
        // Cancelled shares are not errors; nothing to do.
      }
      return;
    }
    await copyUrl(url);
  }

  const invite = useMutation({
    mutationFn: async (memberIds: string[]) => {
      sendingRef.current = true;
      try {
        return await api.inviteClubMembers(clubId, memberIds);
      } finally {
        sendingRef.current = false;
      }
    },
    onSuccess: ({ invited }) => {
      setSelection(EMPTY_INVITE_SELECTION);
      toast({
        variant: 'success',
        message:
          invited.length === 0
            ? 'Those members are already in the club or already invited.'
            : `${invited.length === 1 ? '1 invite' : `${invited.length} invites`} sent, pending acceptance.`,
      });
      onClose();
    },
    onError: () => {
      toast({ variant: 'error', message: 'We could not send those invites. Try again.' });
    },
  });

  const rotate = useMutation({
    mutationFn: () => link.reset(),
    onSuccess: () => {
      toast({
        variant: 'success',
        message: 'New invite link created. Older links no longer work.',
      });
    },
    onError: () => {
      toast({ variant: 'error', message: 'We could not reset the invite link. Try again.' });
    },
  });

  return (
    <div>
      <div className={styles.linkActions}>
        <button
          type="button"
          className={styles.actionItem}
          disabled={link.isPending}
          onClick={() => void withLink(copyUrl)}
        >
          <span className={styles.actionCircle} aria-hidden>
            <Link2 />
          </span>
          Copy Link
        </button>
        <button
          type="button"
          className={styles.actionItem}
          aria-expanded={qrOpen}
          disabled={link.isPending}
          onClick={() => {
            if (qrOpen) {
              setQrOpen(false);
              return;
            }
            void withLink(() => setQrOpen(true));
          }}
        >
          <span className={styles.actionCircle} aria-hidden>
            <QrCode />
          </span>
          QR Code
        </button>
        <button
          type="button"
          className={styles.actionItem}
          disabled={link.isPending}
          onClick={() => void withLink(shareUrl)}
        >
          <span className={styles.actionCircle} aria-hidden>
            <Share2 />
          </span>
          Share
        </button>
      </div>

      {qrOpen && link.url && qr && (
        <div className={styles.qrPanel}>
          <div className={styles.qrFrame}>
            <svg
              className={styles.qr}
              viewBox={`0 0 ${qr.size} ${qr.size}`}
              role="img"
              aria-label={`Invite QR code for ${clubName}. The link is shown below the code.`}
            >
              <path d={qr.path} fill="currentColor" />
            </svg>
          </div>
          {/* Text fallback for failed scans; also the manual-copy path. */}
          <p className={styles.qrUrl}>{link.url}</p>
          <div className={styles.qrActions}>
            <Button variant="secondary" size="sm" onClick={() => void withLink(copyUrl)}>
              Copy link
            </Button>
            {canRotateLink && (
              <Button
                variant="ghost"
                size="sm"
                loading={rotate.isPending}
                onClick={() => rotate.mutate()}
              >
                Reset link
              </Button>
            )}
          </div>
          {canRotateLink && (
            <p className={styles.dialogHint}>
              Resetting creates a fresh link and revokes every previously shared one.
            </p>
          )}
        </div>
      )}

      <ClubMemberPicker
        selection={selection}
        onSelectionChange={setSelection}
        excludeMemberIds={excludeMemberIds}
      />

      <div className={styles.dialogActions}>
        <Button
          fullWidth
          disabled={selection.members.length === 0}
          loading={invite.isPending}
          onClick={() => invite.mutate(selection.members.map((member) => member.id))}
        >
          Add
          {selection.members.length > 0 &&
            ` (${selection.members.length} ${
              selection.members.length === 1 ? 'player' : 'players'
            })`}
        </Button>
      </div>
    </div>
  );
}
