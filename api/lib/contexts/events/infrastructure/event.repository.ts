import type { Prisma, PrismaClient } from '@prisma/client';
import type { TransactionContext } from '@/lib/kernel';
import { asPrismaTx } from '@/lib/infrastructure/prisma-tx';

export interface ListClubEventsOptions {
  includeInactive?: boolean;
  includePast?: boolean;
}

/**
 * The event row without its court claims: courts live in slot_claims, owned
 * by the scheduling BC and read through the ResourceClaimPort. The service
 * composes the two.
 */
export interface ClubEventRow {
  id: string;
  title: string;
  imageUrl: string | null;
  details: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClubEventWriteData {
  title: string;
  imageUrl: string | null;
  details: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  active: boolean;
}

export class ClubEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private db(tx?: TransactionContext) {
    return tx ? asPrismaTx(tx) : this.prisma;
  }

  async list(options: ListClubEventsOptions): Promise<ClubEventRow[]> {
    const where: Prisma.ClubEventWhereInput = {};

    if (!options.includeInactive) {
      where.active = true;
    }

    if (!options.includePast) {
      where.endsAt = { gte: new Date() };
    }

    return this.prisma.clubEvent.findMany({
      where,
      orderBy: { startsAt: 'asc' },
    });
  }

  async getById(id: string, tx?: TransactionContext): Promise<ClubEventRow | null> {
    return this.db(tx).clubEvent.findUnique({ where: { id } });
  }

  async create(tx: TransactionContext, data: ClubEventWriteData): Promise<ClubEventRow> {
    return asPrismaTx(tx).clubEvent.create({ data });
  }

  async update(tx: TransactionContext, id: string, data: ClubEventWriteData): Promise<ClubEventRow> {
    return asPrismaTx(tx).clubEvent.update({ where: { id }, data });
  }
}
