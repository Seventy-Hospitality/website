import type { PrismaClient } from '@prisma/client';
import type { PaymentMethodData } from '../domain';

export interface PaymentMethodRecord {
  id: string;
  memberId: string;
  stripePaymentMethodId: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

export class PaymentMethodRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Mirror upsert from webhooks/reads. A member's FIRST card becomes the
   * default (matches Stripe: save_default_payment_method pins it); later
   * cards stay non-default until the set-default endpoint runs.
   */
  async upsertFromStripe(memberId: string, data: PaymentMethodData): Promise<void> {
    const hasAny = (await this.prisma.paymentMethod.count({ where: { memberId } })) > 0;
    await this.prisma.paymentMethod.upsert({
      where: { stripePaymentMethodId: data.paymentMethodId },
      create: {
        memberId,
        stripePaymentMethodId: data.paymentMethodId,
        brand: data.brand,
        last4: data.last4,
        expMonth: data.expMonth,
        expYear: data.expYear,
        isDefault: !hasAny,
      },
      update: {
        memberId,
        brand: data.brand,
        last4: data.last4,
        expMonth: data.expMonth,
        expYear: data.expYear,
      },
    }).catch((err: any) => {
      if (err?.code !== 'P2002') throw err; // lost create race: row exists now
    });
  }

  /** Exclusive default flip, both writes in one transaction. */
  async setDefault(memberId: string, stripePaymentMethodId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.paymentMethod.updateMany({
        where: { memberId, NOT: { stripePaymentMethodId } },
        data: { isDefault: false },
      }),
      this.prisma.paymentMethod.updateMany({
        where: { memberId, stripePaymentMethodId },
        data: { isDefault: true },
      }),
    ]);
  }

  async deleteByStripeId(stripePaymentMethodId: string): Promise<void> {
    await this.prisma.paymentMethod.deleteMany({ where: { stripePaymentMethodId } });
  }

  async deleteAllForMember(memberId: string): Promise<void> {
    await this.prisma.paymentMethod.deleteMany({ where: { memberId } });
  }

  async listForMember(memberId: string): Promise<PaymentMethodRecord[]> {
    return this.prisma.paymentMethod.findMany({
      where: { memberId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    }) as unknown as PaymentMethodRecord[];
  }

  async getDefaultForMember(memberId: string): Promise<PaymentMethodRecord | null> {
    return this.prisma.paymentMethod.findFirst({
      where: { memberId, isDefault: true },
    }) as unknown as PaymentMethodRecord | null;
  }

  async findByStripeId(stripePaymentMethodId: string): Promise<PaymentMethodRecord | null> {
    return this.prisma.paymentMethod.findUnique({
      where: { stripePaymentMethodId },
    }) as unknown as PaymentMethodRecord | null;
  }
}
