import {
  AUTH_CONSTANTS,
  generateToken,
  hashToken,
  isSessionValid,
  isMagicLinkExpired,
  isMagicLinkUsed,
  InvalidTokenError,
  SessionExpiredError,
  type AuthenticatedUser,
} from '../domain';
import type { SessionRepository } from '../infrastructure/session.repository';
import type { MagicLinkRepository } from '../infrastructure/magic-link.repository';
import type { JwtService } from '../infrastructure/jwt.service';
import type { NotificationService } from '@/lib/contexts/communications/application';

export class AuthService {
  constructor(
    private readonly sessionRepo: SessionRepository,
    private readonly magicLinkRepo: MagicLinkRepository,
    private readonly jwt: JwtService,
    private readonly notifications: NotificationService,
    private readonly appUrl: string,
  ) {}

  /**
   * Send a magic link email. Creates a token and sends it.
   * Does not reveal whether the email exists — always returns success.
   */
  async sendMagicLink(email: string): Promise<void> {
    const { token, hash } = generateToken();
    const expiresAt = new Date(
      Date.now() + AUTH_CONSTANTS.MAGIC_LINK_TTL_MINUTES * 60 * 1000,
    );

    await this.magicLinkRepo.create(email, hash, expiresAt);

    const verifyUrl = `${this.appUrl}/api/auth/verify?token=${token}`;
    await this.notifications.sendMagicLink(email, verifyUrl);
  }

  /**
   * Verify a magic link token and create a session.
   * Returns a JWT token string.
   */
  async verifyMagicLink(token: string): Promise<{ jwt: string; expiresAt: Date }> {
    const hash = hashToken(token);
    const magicLink = await this.magicLinkRepo.findByHash(hash);

    if (!magicLink) throw new InvalidTokenError();
    if (isMagicLinkUsed(magicLink)) throw new InvalidTokenError();
    if (isMagicLinkExpired(magicLink)) throw new InvalidTokenError();

    // Mark token as used
    await this.magicLinkRepo.markUsed(magicLink.id);

    // Create session
    const expiresAt = new Date(
      Date.now() + AUTH_CONSTANTS.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    // Evict oldest sessions if over limit
    await this.sessionRepo.evictOldest(magicLink.email, AUTH_CONSTANTS.MAX_SESSIONS_PER_USER - 1);

    const session = await this.sessionRepo.create(magicLink.email, expiresAt);

    // Sign JWT
    const jwtToken = await this.jwt.sign({
      sub: session.userId,
      sid: session.id,
      email: session.email,
    });

    return { jwt: jwtToken, expiresAt };
  }

  /**
   * Validate a JWT and return the authenticated user.
   * Also refreshes the session's lastActiveAt.
   */
  async validateSession(jwtToken: string): Promise<AuthenticatedUser> {
    const payload = await this.jwt.verify(jwtToken);
    if (!payload) throw new SessionExpiredError();

    const session = await this.sessionRepo.findById(payload.sid);
    if (!session) throw new SessionExpiredError();
    if (!isSessionValid(session)) throw new SessionExpiredError();

    // Update last active (fire-and-forget)
    this.sessionRepo.updateLastActive(session.id).catch(() => {});

    return {
      userId: session.userId,
      sessionId: session.id,
      email: session.email,
    };
  }

  /**
   * Logout — destroy a single session.
   */
  async logout(sessionId: string): Promise<void> {
    await this.sessionRepo.delete(sessionId);
  }
}
