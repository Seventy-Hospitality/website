import type { PrismaClient } from '@prisma/client';
import { UnitOfWork, type TransactionContext } from '../kernel/unit-of-work';

export class PrismaUnitOfWork extends UnitOfWork {
  constructor(private readonly prisma: PrismaClient) {
    super();
  }

  async execute<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      (ptx) => fn(ptx as unknown as TransactionContext),
      { timeout: 30_000 },
    );
  }
}
