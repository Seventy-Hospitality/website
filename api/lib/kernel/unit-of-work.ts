declare const TX_BRAND: unique symbol;
export type TransactionContext = { readonly [TX_BRAND]: never };

export abstract class UnitOfWork {
  abstract execute<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
