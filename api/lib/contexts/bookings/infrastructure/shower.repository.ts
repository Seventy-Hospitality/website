import type { PrismaClient } from '@prisma/client';
import type { Shower } from '../domain';

export interface CreateShowerInput {
  name: string;
  slotDurationMinutes?: number;
  operatingHoursStart?: string;
  operatingHoursEnd?: string;
  maxAdvanceDays?: number;
  maxBookingsPerMemberPerDay?: number;
  cancellationDeadlineMinutes?: number;
}

export interface UpdateShowerInput {
  name?: string;
  slotDurationMinutes?: number;
  operatingHoursStart?: string;
  operatingHoursEnd?: string;
  maxAdvanceDays?: number;
  maxBookingsPerMemberPerDay?: number;
  cancellationDeadlineMinutes?: number;
  active?: boolean;
}

export class ShowerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listAll(): Promise<Shower[]> {
    return this.prisma.shower.findMany({
      orderBy: { name: 'asc' },
    }) as unknown as Shower[];
  }

  async listActive(): Promise<Shower[]> {
    return this.prisma.shower.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    }) as unknown as Shower[];
  }

  async getById(id: string): Promise<Shower | null> {
    return this.prisma.shower.findUnique({ where: { id } }) as unknown as Shower | null;
  }

  async create(data: CreateShowerInput): Promise<Shower> {
    return this.prisma.shower.create({ data }) as unknown as Shower;
  }

  async update(id: string, data: UpdateShowerInput): Promise<Shower> {
    return this.prisma.shower.update({ where: { id }, data }) as unknown as Shower;
  }
}
