import type { Prisma } from '@prisma/client';
import type { TransactionContext } from '../kernel/unit-of-work';

export type PrismaTransactionClient = Prisma.TransactionClient;

/** Cast opaque TransactionContext to Prisma transaction client. Infrastructure only. */
export function asPrismaTx(tx: TransactionContext): PrismaTransactionClient {
  return tx as unknown as PrismaTransactionClient;
}

export function toTransactionContext(tx: PrismaTransactionClient): TransactionContext {
  return tx as unknown as TransactionContext;
}
