import type { PrismaClient } from '@prisma/client';
import type { Court } from '../domain';

export interface CreateCourtInput {
  name: string;
  slotDurationMinutes?: number;
  operatingHoursStart?: string;
  operatingHoursEnd?: string;
  maxAdvanceDays?: number;
  maxBookingsPerMemberPerDay?: number;
  cancellationDeadlineMinutes?: number;
}

export interface UpdateCourtInput {
  name?: string;
  slotDurationMinutes?: number;
  operatingHoursStart?: string;
  operatingHoursEnd?: string;
  maxAdvanceDays?: number;
  maxBookingsPerMemberPerDay?: number;
  cancellationDeadlineMinutes?: number;
  active?: boolean;
}

export class CourtRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listAll(): Promise<Court[]> {
    return this.prisma.court.findMany({
      orderBy: { name: 'asc' },
    }) as unknown as Court[];
  }

  async listActive(): Promise<Court[]> {
    return this.prisma.court.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
    }) as unknown as Court[];
  }

  async getById(id: string): Promise<Court | null> {
    return this.prisma.court.findUnique({ where: { id } }) as unknown as Court | null;
  }

  async create(data: CreateCourtInput): Promise<Court> {
    return this.prisma.court.create({ data }) as unknown as Court;
  }

  async update(id: string, data: UpdateCourtInput): Promise<Court> {
    return this.prisma.court.update({ where: { id }, data }) as unknown as Court;
  }
}
