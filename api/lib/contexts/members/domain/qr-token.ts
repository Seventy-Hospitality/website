import { createHmac, timingSafeEqual } from 'crypto';

// ── Member QR credential ──
// The gate scanner payload is a SHORT-LIVED signed token, never the raw
// member id or number (a screenshot of the QR must go stale in a minute).
//
// Format (recorded in docs/decisions-account.md):
//   MQR1.<base64url payload>.<base64url signature>
// where payload is JSON {"m": memberId, "iat": seconds, "exp": seconds}
// and signature = HMAC-SHA256(key, "MQR1.<base64url payload>"). The key is
// a dedicated derivation, not the JWT secret itself.

export const MEMBER_QR_TOKEN_TTL_SECONDS = 60;
const PREFIX = 'MQR1';

export type QrTokenFailure = 'malformed' | 'tampered' | 'expired';

export class QrTokenError extends Error {
  constructor(public readonly reason: QrTokenFailure) {
    super(`Invalid member QR token: ${reason}`);
    this.name = 'QrTokenError';
  }
}

export interface MemberQrClaims {
  memberId: string;
  issuedAt: Date;
  expiresAt: Date;
}

export function signMemberQrToken(
  memberId: string,
  key: Buffer,
  now: Date = new Date(),
  ttlSeconds: number = MEMBER_QR_TOKEN_TTL_SECONDS,
): { token: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ m: memberId, iat, exp }), 'utf8').toString('base64url');
  const signature = hmac(key, `${PREFIX}.${payload}`);
  return { token: `${PREFIX}.${payload}.${signature}`, expiresAt: new Date(exp * 1000) };
}

/** Small tolerance for scanner/server clock skew on the iat side only. */
const CLOCK_SKEW_SECONDS = 5;

export function verifyMemberQrToken(token: string, key: Buffer, now: Date = new Date()): MemberQrClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new QrTokenError('malformed');
  const [, payloadB64, signature] = parts;

  const expected = hmac(key, `${PREFIX}.${payloadB64}`);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const presentedBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== presentedBuf.length || !timingSafeEqual(expectedBuf, presentedBuf)) {
    throw new QrTokenError('tampered');
  }

  let claims: { m?: unknown; iat?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new QrTokenError('malformed');
  }
  if (typeof claims.m !== 'string' || typeof claims.iat !== 'number' || typeof claims.exp !== 'number') {
    throw new QrTokenError('malformed');
  }

  const nowSeconds = now.getTime() / 1000;
  if (nowSeconds > claims.exp) throw new QrTokenError('expired');
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) throw new QrTokenError('tampered');

  return {
    memberId: claims.m,
    issuedAt: new Date(claims.iat * 1000),
    expiresAt: new Date(claims.exp * 1000),
  };
}

function hmac(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}
