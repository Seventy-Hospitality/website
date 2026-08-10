import type { PrismaClient, Prisma } from '@prisma/client';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';
import type { TransactionContext } from '@/lib/kernel/unit-of-work';

export interface IdentityUser {
  id: string;
  email: string;
  name: string;
  staffRole: string | null;
  status: string;
  emailVerifiedAt: Date | null;
  termsAcceptedAt: Date | null;
  termsVersion: string | null;
  /**
   * The club profile linked to this user, if any. Only the FK is read here so
   * the principal costs one query; everything else about a Member belongs to
   * the members context.
   */
  memberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Legacy admin-surface shape; `role` mirrors staffRole for the admin UI. */
export interface AppUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  staffRole: true,
  status: true,
  emailVerifiedAt: true,
  termsAcceptedAt: true,
  termsVersion: true,
  createdAt: true,
  updatedAt: true,
  member: { select: { id: true } },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

export function toIdentityUser(row: UserRow): IdentityUser {
  const { member, ...user } = row;
  return { ...user, memberId: member?.id ?? null };
}

function toAppUser(user: { id: string; email: string; name: string; staffRole: string | null }): AppUser {
  return { id: user.id, email: user.email, name: user.name, role: user.staffRole ?? 'member' };
}

/** Emails are stored and looked up lowercased; normalize defensively at the
 *  repository so no call site can reintroduce a case-only duplicate. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private client(tx?: TransactionContext) {
    return tx ? asPrismaTx(tx) : this.prisma;
  }

  async findByEmail(email: string, tx?: TransactionContext): Promise<IdentityUser | null> {
    const row = await this.client(tx).user.findUnique({
      where: { email: normalizeEmail(email) },
      select: USER_SELECT,
    });
    return row && toIdentityUser(row);
  }

  async findById(id: string, tx?: TransactionContext): Promise<IdentityUser | null> {
    const row = await this.client(tx).user.findUnique({ where: { id }, select: USER_SELECT });
    return row && toIdentityUser(row);
  }

  async createUser(
    input: { email: string; name: string; staffRole?: string | null; emailVerifiedAt?: Date | null },
    tx?: TransactionContext,
  ): Promise<IdentityUser> {
    const row = await this.client(tx).user.create({
      data: {
        email: input.email,
        name: input.name,
        staffRole: input.staffRole ?? null,
        emailVerifiedAt: input.emailVerifiedAt ?? null,
      },
      select: USER_SELECT,
    });
    return toIdentityUser(row);
  }

  async markEmailVerified(id: string, when: Date, tx?: TransactionContext): Promise<void> {
    await this.client(tx).user.updateMany({
      where: { id, emailVerifiedAt: null },
      data: { emailVerifiedAt: when },
    });
  }

  /** Terms acceptance is recorded server-side (memberships' TermsRecorder). */
  async recordTermsAcceptance(id: string, version: string, when: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { termsAcceptedAt: when, termsVersion: version },
    });
  }

  // ── Admin surface (src/routes/admin.ts) ──

  async list(): Promise<AppUser[]> {
    const users = await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' }, select: USER_SELECT });
    return users.map(toAppUser);
  }

  async listAdmins(): Promise<AppUser[]> {
    const users = await this.prisma.user.findMany({
      where: { staffRole: 'admin' },
      orderBy: { createdAt: 'asc' },
      select: USER_SELECT,
    });
    return users.map(toAppUser);
  }

  async create(email: string, name: string, staffRole?: string): Promise<AppUser> {
    const user = await this.prisma.user.create({
      data: {
        email: normalizeEmail(email),
        name,
        staffRole: staffRole === 'member' ? null : staffRole ?? null,
      },
      select: USER_SELECT,
    });
    return toAppUser(user);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.user.delete({ where: { id } });
  }
}
