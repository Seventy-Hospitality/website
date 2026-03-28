import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

export interface SessionJwtPayload extends JWTPayload {
  sub: string;  // userId
  sid: string;  // sessionId
  email: string;
}

export class JwtService {
  private readonly secret: Uint8Array;
  private readonly issuer = 'seventy';
  private readonly expiresIn = '30d';

  constructor(secretKey: string) {
    this.secret = new TextEncoder().encode(secretKey);
  }

  async sign(payload: { sub: string; sid: string; email: string }): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(this.issuer)
      .setExpirationTime(this.expiresIn)
      .sign(this.secret);
  }

  async verify(token: string): Promise<SessionJwtPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: this.issuer,
      });
      return payload as SessionJwtPayload;
    } catch {
      return null;
    }
  }
}
