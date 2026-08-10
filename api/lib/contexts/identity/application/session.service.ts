import type { TransactionContext, UnitOfWork } from '@/lib/kernel/unit-of-work';
import {
  SESSION_POLICIES,
  generateToken,
  hashToken,
  isSessionActive,
  sessionExpiries,
  extendedIdleExpiry,
  isWithinRotationGrace,
  InvalidTokenError,
  SessionExpiredError,
  NotAuthorizedError,
  type Client,
  type Principal,
  type StaffRole,
} from '../domain';
import type { AuthSessionRepository, AuthSessionRecord } from '../infrastructure/auth-session.repository';
import type { UserRepository, IdentityUser } from '../infrastructure/user.repository';
import type { JwtService } from '../infrastructure/jwt.service';
import type { AuditLog } from './ports';

export interface SessionMeta {
  deviceName?: string | null;
  ip?: string | null;
}

export interface IssuedSession {
  user: IdentityUser;
  sessionId: string;
  client: Client;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  /** Current idle expiry; also the natural cookie lifetime for the refresh token. */
  refreshTokenExpiresAt: Date;
}

function toStaffRole(value: string | null): StaffRole | null {
  return value === 'staff' || value === 'admin' ? value : null;
}

/** Builds the request principal from a freshly-read user row. */
export function toPrincipal(source: {
  user: IdentityUser;
  sessionId: string;
  client: Client;
}): Principal {
  return {
    userId: source.user.id,
    sessionId: source.sessionId,
    email: source.user.email,
    emailVerified: source.user.emailVerifiedAt !== null,
    staffRole: toStaffRole(source.user.staffRole),
    memberId: source.user.memberId,
    client: source.client,
  };
}

export class SessionService {
  constructor(
    private readonly sessionRepo: AuthSessionRepository,
    private readonly userRepo: UserRepository,
    private readonly jwt: JwtService,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  async issue(user: IdentityUser, client: Client, meta?: SessionMeta): Promise<IssuedSession> {
    const policy = SESSION_POLICIES[client];
    const { token: refreshToken, hash: refreshTokenHash } = generateToken();
    const now = new Date();
    const { idleExpiresAt, absoluteExpiresAt } = sessionExpiries(client, now);

    const session = await this.uow.execute(async (tx) => {
      await this.sessionRepo.evictBeyondCap(user.id, client, policy.maxSessions - 1, tx);
      return this.sessionRepo.create(
        {
          userId: user.id,
          client,
          refreshTokenHash,
          idleExpiresAt,
          absoluteExpiresAt,
          deviceName: meta?.deviceName ?? null,
          ip: meta?.ip ?? null,
        },
        tx,
      );
    });

    const access = await this.jwt.signAccessToken({ sub: user.id, sid: session.id });
    return {
      user,
      sessionId: session.id,
      client,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: idleExpiresAt,
    };
  }

  /**
   * Rotating refresh. The presented token normally matches the current hash;
   * matching the previous hash inside the grace window is a benign network
   * retry, outside it a theft signal that revokes the whole session.
   */
  async refresh(presentedToken: string): Promise<IssuedSession> {
    const presentedHash = hashToken(presentedToken);
    const now = new Date();

    const current = await this.sessionRepo.findByRefreshTokenHash(presentedHash);
    if (current) {
      if (!isSessionActive(current, now)) throw new SessionExpiredError();
      const rotated = await this.rotate(current, {
        expectedCurrentHash: presentedHash,
        previousTokenHash: presentedHash,
        rotatedAt: now,
        now,
      });
      if (rotated) return rotated;
      // Lost a concurrent rotation between read and write; the presented
      // token is now the previous one, so fall through to the grace path.
    }

    const prior = await this.sessionRepo.findByPreviousTokenHash(presentedHash);
    if (!prior) throw new InvalidTokenError();
    if (!isSessionActive(prior, now)) throw new SessionExpiredError();

    if (isWithinRotationGrace(prior.rotatedAt, now)) {
      // Retry of a lost response: rotate again but keep previousTokenHash and
      // rotatedAt anchored, so the grace window never slides.
      const rotated = await this.rotate(prior, {
        expectedCurrentHash: prior.refreshTokenHash,
        previousTokenHash: prior.previousTokenHash,
        rotatedAt: prior.rotatedAt!,
        now,
      });
      if (rotated) return rotated;
      throw new InvalidTokenError();
    }

    await this.uow.execute(async (tx) => {
      await this.sessionRepo.revoke(prior.id, 'refresh_reuse', tx);
      await this.audit.append(tx, {
        streamType: 'user',
        streamId: prior.userId,
        eventType: 'RefreshTokenReuseDetected',
        data: { sessionId: prior.id, client: prior.client },
      });
    });
    throw new InvalidTokenError();
  }

  private async rotate(
    session: AuthSessionRecord,
    params: {
      expectedCurrentHash: string;
      previousTokenHash: string | null;
      rotatedAt: Date;
      now: Date;
    },
  ): Promise<IssuedSession | null> {
    const user = await this.loadActiveUser(session);
    const { token: refreshToken, hash: refreshTokenHash } = generateToken();
    const client = session.client as Client;
    const idleExpiresAt = extendedIdleExpiry(client, session.absoluteExpiresAt, params.now);

    const applied = await this.sessionRepo.rotate(session.id, {
      expectedCurrentHash: params.expectedCurrentHash,
      refreshTokenHash,
      previousTokenHash: params.previousTokenHash,
      rotatedAt: params.rotatedAt,
      idleExpiresAt,
      lastUsedAt: params.now,
    });
    if (!applied) return null;

    const access = await this.jwt.signAccessToken({ sub: user.id, sid: session.id });
    return {
      user,
      sessionId: session.id,
      client,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: idleExpiresAt,
    };
  }

  /**
   * Access JWT -> session row + owner read (instant revocation, and staff role
   * and member profile always read fresh rather than trusted from the token).
   */
  async validateAccessToken(token: string): Promise<Principal> {
    const payload = await this.jwt.verifyAccessToken(token);
    if (!payload) throw new SessionExpiredError();

    const found = await this.sessionRepo.findByIdWithUser(payload.sid);
    if (!found || found.session.userId !== payload.sub || !isSessionActive(found.session)) {
      throw new SessionExpiredError();
    }
    void this.sessionRepo.touch(found.session.id);

    if (found.user.status !== 'active') throw new NotAuthorizedError();

    return toPrincipal({
      user: found.user,
      sessionId: found.session.id,
      client: found.session.client as Client,
    });
  }

  async revoke(sessionId: string, reason = 'signout'): Promise<void> {
    await this.sessionRepo.revoke(sessionId, reason);
  }

  async revokeAllForUser(
    userId: string,
    reason: string,
    options?: { exceptSessionId?: string; tx?: TransactionContext },
  ): Promise<number> {
    return this.sessionRepo.revokeAllForUser(
      userId,
      reason,
      options?.exceptSessionId ? { exceptSessionId: options.exceptSessionId } : undefined,
      options?.tx,
    );
  }

  private async loadActiveUser(session: AuthSessionRecord): Promise<IdentityUser> {
    const user = await this.userRepo.findById(session.userId);
    if (!user || user.status !== 'active') {
      await this.sessionRepo.revoke(session.id, 'account_unavailable');
      throw new NotAuthorizedError();
    }
    return user;
  }
}
