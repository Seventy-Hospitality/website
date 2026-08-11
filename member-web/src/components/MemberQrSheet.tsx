import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { qrSvgData } from '../lib/qr';
import { BrandMark } from '../app/BrandMark';
import { Button } from './Button';
import { Sheet } from './Sheet';
import { Skeleton } from './Skeleton';
import styles from './MemberQrSheet.module.css';

export interface MemberQrSheetProps {
  open: boolean;
  onClose: () => void;
  /** Shown uppercase under the code, per the Figma member card. */
  memberName: string;
  /** Rendered as "#A12345"; doubles as the screen-reader text fallback. */
  memberNumber: string;
}

/** Refresh this many seconds before the token expires (TTL is 60s). */
const REFRESH_MARGIN_SECONDS = 10;
const MIN_REFRESH_DELAY_MS = 1_000;

/**
 * The membership QR card overlay (Figma account/member-card 107:9461):
 * brand mark, the gate check-in QR, member name and number. Opened from
 * the home header's QR button (W2) and from account's "View membership
 * card" (W6) — reuse this component, do not rebuild the card.
 *
 * The QR encodes a short-lived signed token from GET /api/me/qr (never the
 * raw member id). While the sheet is open the token is re-requested shortly
 * before its `expiresAt`, so the visible code stays scannable; queries are
 * not cached across opens (`gcTime: 0`) so a reopened card never flashes an
 * expired code.
 */
export function MemberQrSheet({ open, onClose, memberName, memberNumber }: MemberQrSheetProps) {
  const queryClient = useQueryClient();

  const token = useQuery({
    queryKey: ['member-qr'],
    queryFn: api.getMemberQr,
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: 'always',
  });

  // TTL refresh: schedule a refetch just before the current token expires.
  // Anchored on the server's expiresAt (not a fixed interval) so a tab that
  // slept re-requests immediately on the next render after waking.
  const expiresAtMs = token.data ? Date.parse(token.data.expiresAt) : null;
  useEffect(() => {
    if (!open || expiresAtMs === null) return;
    const delay = Math.max(
      expiresAtMs - REFRESH_MARGIN_SECONDS * 1000 - Date.now(),
      MIN_REFRESH_DELAY_MS,
    );
    const timer = window.setTimeout(() => {
      void queryClient.refetchQueries({ queryKey: ['member-qr'] });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [open, expiresAtMs, queryClient]);

  const qr = useMemo(() => (token.data ? qrSvgData(token.data.token) : null), [token.data]);

  return (
    <Sheet open={open} onClose={onClose} title="Membership card">
      <div className={styles.card}>
        <div className={styles.brand}>
          <BrandMark size={44} />
          <span className={styles.brandUrl} aria-hidden>
            CLUB70.COM
          </span>
        </div>

        {token.isPending ? (
          <div className={styles.qrFrame} role="status" aria-busy="true">
            <span className="visually-hidden">Loading your check-in code</span>
            <Skeleton width="11rem" height="11rem" shape="card" />
          </div>
        ) : token.isError ? (
          <div className={styles.qrFrame} role="alert">
            <p className={styles.errorText}>We could not load your check-in code.</p>
            <Button variant="secondary" size="sm" onClick={() => void token.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          qr && (
            <div className={styles.qrFrame}>
              <svg
                className={styles.qr}
                viewBox={`0 0 ${qr.size} ${qr.size}`}
                role="img"
                aria-label={`Check-in QR code for member ${memberNumber}`}
              >
                <path d={qr.path} fill="currentColor" />
              </svg>
            </div>
          )
        )}

        <p className={styles.name}>{memberName}</p>
        {/* Text fallback: staff can key this in when scanning fails. */}
        <p className={styles.number}>#{memberNumber}</p>
      </div>
    </Sheet>
  );
}
