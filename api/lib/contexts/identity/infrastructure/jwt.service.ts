import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { ACCESS_TOKEN_TTL_MINUTES } from '../domain';

/**
 * Access tokens carry identity only (sub + sid), never privileges: roles are
 * read from the DB per request, so revocation is instant and a stale token
 * can never smuggle a dead role.
 */
export interface AccessTokenPayload extends JWTPayload {
  sub: string; // userId
  sid: string; // sessionId
  typ: 'access';
}

export class JwtService {
  private readonly secret: Uint8Array;
  private readonly issuer = 'seventy';

  constructor(secretKey: string) {
    this.secret = new TextEncoder().encode(secretKey);
  }

  async signAccessToken(payload: { sub: string; sid: string }): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MINUTES * 60 * 1000);
    const token = await new SignJWT({ sub: payload.sub, sid: payload.sid, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(this.issuer)
      .setExpirationTime(expiresAt)
      .sign(this.secret);
    return { token, expiresAt };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: this.issuer,
        clockTolerance: 5,
      });
      if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        return null;
      }
      return payload as AccessTokenPayload;
    } catch {
      return null;
    }
  }
}
