import type { PrismaClient, Prisma } from '@prisma/client';
import { pickCurrentMembership } from '@/lib/contexts/memberships/domain';
import { generateMemberNumber, type Member } from '../domain';

export interface MemberWithRelations {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  memberNumber: string;
  displayName: string | null;
  avatarUrl: string | null;
  deletedAt: Date | null;
  stripeCustomerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * The member's CURRENT membership (memberships is one row per Stripe
   * subscription; the repository picks the operative one), kept in the
   * historical singular shape every consumer renders.
   */
  membership: {
    id: string;
    status: string;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    plan: { id: string; name: string; amountCents: number; interval: string };
  } | null;
  notes: Array<{
    id: string;
    content: string;
    authorId: string;
    createdAt: Date;
  }>;
}

/** Directory-search / roster projection of a member. */
export interface MemberDirectoryEntry {
  id: string;
  memberNumber: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** The directory projection: names only, never emails or phone. */
const DIRECTORY_SELECT = {
  id: true,
  memberNumber: true,
  firstName: true,
  lastName: true,
  displayName: true,
  avatarUrl: true,
} as const;

const memberInclude = {
  memberships: { include: { plan: true } },
  notes: { orderBy: { createdAt: 'desc' as const } },
} as const;

function toMemberWithRelations(record: any): MemberWithRelations {
  const { memberships, ...rest } = record;
  return { ...rest, membership: pickCurrentMembership(memberships ?? []) ?? null };
}

export interface ListResult {
  data: MemberWithRelations[];
  total: number;
  page: number;
  limit: number;
}

/** How many random member numbers to try before giving up on a freak streak. */
const MEMBER_NUMBER_ATTEMPTS = 8;

function isMemberNumberCollision(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const { code, meta } = err as { code?: string; meta?: { target?: unknown } };
  if (code !== 'P2002') return false;
  const target = meta?.target;
  return Array.isArray(target) ? target.includes('memberNumber') : String(target ?? '').includes('memberNumber');
}

export class MemberRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(params: {
    search?: string;
    status?: string;
    page: number;
    limit: number;
  }): Promise<ListResult> {
    const where: Prisma.MemberWhereInput = {};

    if (params.search) {
      where.OR = [
        { firstName: { contains: params.search, mode: 'insensitive' } },
        { lastName: { contains: params.search, mode: 'insensitive' } },
        { email: { contains: params.search, mode: 'insensitive' } },
        { memberNumber: { contains: params.search.replace(/^#/, ''), mode: 'insensitive' } },
      ];
    }

    if (params.status) {
      if (params.status === 'none') {
        where.memberships = { none: {} };
      } else {
        where.memberships = { some: { status: params.status } };
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.member.findMany({
        where,
        include: memberInclude,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      this.prisma.member.count({ where }),
    ]);

    return { data: data.map(toMemberWithRelations), total, page: params.page, limit: params.limit };
  }

  /**
   * Member-directory prefix search by name or member number. Members only by
   * construction: staff live in users, never in this table. Deleted
   * (anonymized) members never surface.
   */
  async searchByNamePrefix(query: string, limit: number, offset = 0): Promise<MemberDirectoryEntry[]> {
    const terms = query.split(/\s+/).filter(Boolean);
    const nameMatch: Prisma.MemberWhereInput = {
      AND: terms.map((term) => ({
        OR: [
          { firstName: { startsWith: term, mode: 'insensitive' } },
          { lastName: { startsWith: term, mode: 'insensitive' } },
        ],
      })),
    };

    // "#A12" or "a12345" also matches the member number by prefix.
    const numberQuery = query.trim().replace(/^#/, '').toUpperCase();
    const matchers: Prisma.MemberWhereInput[] = [nameMatch];
    if (/^[A-Z0-9]{1,6}$/.test(numberQuery)) {
      matchers.push({ memberNumber: { startsWith: numberQuery } });
    }

    return this.prisma.member.findMany({
      where: { deletedAt: null, OR: matchers },
      select: DIRECTORY_SELECT,
      // The unique id tiebreaker makes the order total: without it, two
      // members sharing both names have undefined relative order and can
      // duplicate or vanish across offset-paged requests.
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: limit,
    });
  }

  /**
   * Default (pre-search) directory page: every live member alphabetically,
   * optionally excluding the caller (an invite picker lists people to
   * invite, not yourself). Same projection and exclusions as the search:
   * members only by construction, deleted members never surface.
   */
  async listDirectory(options: {
    excludeMemberId?: string;
    offset: number;
    limit: number;
  }): Promise<MemberDirectoryEntry[]> {
    return this.prisma.member.findMany({
      where: {
        deletedAt: null,
        ...(options.excludeMemberId ? { id: { not: options.excludeMemberId } } : {}),
      },
      select: DIRECTORY_SELECT,
      // Same total order as the search (unique id tiebreaker): stable
      // offset pagination among same-name members.
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
      skip: options.offset,
      take: options.limit,
    });
  }

  async getById(id: string): Promise<MemberWithRelations | null> {
    const member = await this.prisma.member.findUnique({
      where: { id },
      include: memberInclude,
    });
    return member ? toMemberWithRelations(member) : null;
  }

  async create(data: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string;
  }): Promise<Member> {
    // The random member number can collide; retry with a fresh candidate.
    // Any other unique violation (email) is the caller's to map.
    let lastError: unknown;
    for (let attempt = 0; attempt < MEMBER_NUMBER_ATTEMPTS; attempt++) {
      try {
        return (await this.prisma.member.create({
          data: { ...data, memberNumber: generateMemberNumber() },
        })) as unknown as Member;
      } catch (err) {
        if (!isMemberNumberCollision(err)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  async update(id: string, data: {
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string | null;
  }): Promise<Member> {
    return this.prisma.member.update({ where: { id }, data }) as unknown as Member;
  }

  /** Self-service profile fields (never identity/admin fields). */
  async updateProfile(id: string, data: { displayName?: string | null }): Promise<Member> {
    return this.prisma.member.update({ where: { id }, data }) as unknown as Member;
  }

  async setAvatarUrl(id: string, avatarUrl: string | null): Promise<void> {
    await this.prisma.member.update({ where: { id }, data: { avatarUrl } });
  }

  /**
   * Account-deletion PII scrub. Keeps the row (reservation/ledger FKs and
   * the retired memberNumber live here), keeps stripeCustomerId (dispute
   * windows; billing tags the customer), removes everything personal and
   * unlinks the user. Idempotent. Returns the previous avatar path so the
   * caller can delete the asset.
   */
  async scrubForAccountDeletion(id: string, now: Date = new Date()): Promise<{ previousAvatarUrl: string | null }> {
    const existing = await this.prisma.member.findUnique({
      where: { id },
      select: { avatarUrl: true, deletedAt: true },
    });
    if (!existing) return { previousAvatarUrl: null };

    await this.prisma.member.update({
      where: { id },
      data: {
        firstName: 'Deleted',
        lastName: 'Member',
        displayName: null,
        phone: null,
        email: `deleted+${id}@invalid`,
        avatarUrl: null,
        userId: null,
        deletedAt: existing.deletedAt ?? now,
      },
    });
    return { previousAvatarUrl: existing.avatarUrl };
  }

  async addNote(memberId: string, authorId: string, content: string) {
    return this.prisma.adminNote.create({
      data: { memberId, authorId, content },
    });
  }

  async setStripeCustomerId(id: string, stripeCustomerId: string): Promise<void> {
    await this.prisma.member.update({
      where: { id },
      data: { stripeCustomerId },
    });
  }

  async findByStripeCustomerId(stripeCustomerId: string): Promise<Member | null> {
    return this.prisma.member.findUnique({
      where: { stripeCustomerId },
    }) as unknown as Member | null;
  }
}
