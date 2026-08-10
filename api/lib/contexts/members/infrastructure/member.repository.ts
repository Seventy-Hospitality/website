import type { PrismaClient, Prisma } from '@prisma/client';
import type { Member } from '../domain';

export interface MemberWithRelations {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  stripeCustomerId: string | null;
  createdAt: Date;
  updatedAt: Date;
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

export interface ListResult {
  data: MemberWithRelations[];
  total: number;
  page: number;
  limit: number;
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
      ];
    }

    if (params.status) {
      if (params.status === 'none') {
        where.membership = null;
      } else {
        where.membership = { status: params.status };
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.member.findMany({
        where,
        include: { membership: { include: { plan: true } }, notes: { orderBy: { createdAt: 'desc' } } },
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      this.prisma.member.count({ where }),
    ]);

    return { data: data as unknown as MemberWithRelations[], total, page: params.page, limit: params.limit };
  }

  async getById(id: string): Promise<MemberWithRelations | null> {
    const member = await this.prisma.member.findUnique({
      where: { id },
      include: {
        membership: { include: { plan: true } },
        notes: { orderBy: { createdAt: 'desc' } },
      },
    });
    return member as unknown as MemberWithRelations | null;
  }

  async create(data: {
    email: string;
    firstName: string;
    lastName: string;
    phone?: string;
  }): Promise<Member> {
    return this.prisma.member.create({ data }) as unknown as Member;
  }

  async update(id: string, data: {
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string | null;
  }): Promise<Member> {
    return this.prisma.member.update({ where: { id }, data }) as unknown as Member;
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
