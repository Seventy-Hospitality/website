import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { colors, fonts, radius, spacing } from '../theme/tokens';
import { PrimaryButton } from './PrimaryButton';
import { QRCode } from './QRCode';
import { Sheet } from './Sheet';
import { Skeleton } from './Skeleton';

export interface MemberCardSheetProps {
  open: boolean;
  onClose: () => void;
  /** Shown uppercase under the code, per the Figma member card. */
  memberName: string;
  /** Rendered as "#U00578"; doubles as the screen-reader text fallback. */
  memberNumber: string;
}

/** Refresh this many seconds before the token expires (TTL is ~60s). */
const REFRESH_MARGIN_SECONDS = 10;
const MIN_REFRESH_DELAY_MS = 1_000;

const MEMBER_QR_KEY = ['member-qr'];

/**
 * The membership QR card overlay (Figma account/member-card 107:9461): brand
 * mark, the gate check-in QR, member name and number on a dark card. Opened
 * from the home header's QR button (M2) and, later, from account's "View
 * membership card" (M6): reuse this component, do not rebuild the card.
 *
 * The QR encodes a short-lived signed token from GET /api/me/qr (never the raw
 * member id). While the sheet is open the token is re-requested shortly before
 * its `expiresAt`, so the visible code stays scannable. The token is never
 * cached across opens: the query subtree mounts only while the sheet is open
 * AND the cache entry is removed the moment it closes, so a reopened card shows
 * the loading skeleton until a fresh token lands and never flashes an expired
 * code. Ported from member-web/src/components/MemberQrSheet.tsx.
 */
export function MemberCardSheet({ open, onClose, memberName, memberNumber }: MemberCardSheetProps) {
  const queryClient = useQueryClient();

  // Drop the cached token on close. gcTime alone cannot guarantee this:
  // consumers keep the sheet mounted while it is closed (the home screen
  // does), so relying on unmount-driven garbage collection would leave the
  // previous, likely expired token in the cache for the next open. The query
  // observer lives in <MemberCardQr>, which unmounts first (child cleanups run
  // before parent effects), so this removal always sees an observer-free entry.
  useEffect(() => {
    if (!open) queryClient.removeQueries({ queryKey: MEMBER_QR_KEY });
  }, [open, queryClient]);

  return (
    <Sheet open={open} onClose={onClose} title="Membership card">
      <View style={styles.card}>
        <View style={styles.brand}>
          <View style={styles.brandMark}>
            <Text style={styles.brandMarkText}>70</Text>
          </View>
          <Text style={styles.brandUrl}>CLUB70.COM</Text>
        </View>

        {open ? <MemberCardQr memberNumber={memberNumber} /> : null}

        <Text style={styles.name}>{memberName.toUpperCase()}</Text>
        {/* Text fallback: staff can key this in when scanning fails. */}
        <Text style={styles.number}>#{memberNumber}</Text>
      </View>
    </Sheet>
  );
}

/**
 * The fetching half of the card, mounted only while the sheet is open so
 * closing really removes the query's observer. A reopen therefore always
 * starts from a pending fetch (skeleton), never from yesterday's token.
 */
function MemberCardQr({ memberNumber }: { memberNumber: string }) {
  const queryClient = useQueryClient();

  const token = useQuery({
    queryKey: MEMBER_QR_KEY,
    queryFn: api.getMemberQr,
    staleTime: 0,
    gcTime: 0,
  });

  // TTL refresh: schedule a refetch just before the current token expires.
  // Anchored on the server's expiresAt (not a fixed interval) so a screen that
  // slept re-requests immediately on the next render after waking.
  const expiresAtMs = token.data ? Date.parse(token.data.expiresAt) : null;
  useEffect(() => {
    if (expiresAtMs === null) return;
    const delay = Math.max(
      expiresAtMs - REFRESH_MARGIN_SECONDS * 1000 - Date.now(),
      MIN_REFRESH_DELAY_MS,
    );
    const timer = setTimeout(() => {
      void queryClient.refetchQueries({ queryKey: MEMBER_QR_KEY });
    }, delay);
    return () => clearTimeout(timer);
  }, [expiresAtMs, queryClient]);

  if (token.isPending) {
    return (
      <View style={styles.qrFrame} accessibilityRole="progressbar" accessibilityLabel="Loading your check-in code">
        <Skeleton width={180} height={180} borderRadius={radius.md} />
      </View>
    );
  }

  if (token.isError) {
    return (
      <View style={styles.qrFrame} accessibilityRole="alert">
        <Text style={styles.errorText}>We could not load your check-in code.</Text>
        <View style={styles.errorAction}>
          <PrimaryButton label="Try again" variant="secondary" onPress={() => void token.refetch()} />
        </View>
      </View>
    );
  }

  // White modules on the dark card, per the Figma. The gate scanner is ours
  // (POST /api/qr/verify), so the inverted code is fine.
  return (
    <View
      style={styles.qrFrame}
      accessibilityRole="image"
      accessibilityLabel={`Check-in QR code for member number ${memberNumber}`}
    >
      <QRCode value={token.data.token} size={180} color={colors.text} backgroundColor="transparent" />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.backgroundDeep,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    gap: spacing.md,
  },
  brand: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  brandMark: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMarkText: {
    color: colors.accent,
    fontFamily: fonts.displayHeavy,
    fontSize: 18,
  },
  brandUrl: {
    color: colors.textMuted,
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 3,
  },
  qrFrame: {
    minHeight: 212,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    alignSelf: 'stretch',
  },
  name: {
    color: colors.text,
    fontFamily: fonts.displayBold,
    fontSize: 18,
    letterSpacing: 1,
    textAlign: 'center',
  },
  number: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
    letterSpacing: 1,
  },
  errorText: {
    color: colors.textMuted,
    fontFamily: fonts.body,
    fontSize: 13,
    textAlign: 'center',
    maxWidth: 220,
  },
  errorAction: {
    alignSelf: 'stretch',
    paddingHorizontal: spacing.md,
  },
});
