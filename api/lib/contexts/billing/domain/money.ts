/** Single-currency USD; currency + tax are stored anyway (see the ledger). */
export const CURRENCY = 'usd';

/**
 * Stripe's minimum USD charge. A positive delta below it cannot be charged
 * (refunds have no minimum); the settled decision is to BLOCK such a charge
 * with a clear error rather than silently absorb court time.
 */
export const MINIMUM_CHARGE_CENTS = 50;

export class MinimumChargeNotMetError extends Error {
  constructor(public readonly amountCents: number) {
    super(
      `Amount of ${amountCents} cents is below the ${MINIMUM_CHARGE_CENTS}-cent card minimum`,
    );
    this.name = 'MinimumChargeNotMetError';
  }
}

export function assertChargeableAmount(amountCents: number): void {
  if (amountCents < MINIMUM_CHARGE_CENTS) throw new MinimumChargeNotMetError(amountCents);
}
