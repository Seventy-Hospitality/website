import type { PrismaClient } from '@prisma/client';
import type { MemberTier, Resource, ResourceType } from '../domain';

export interface CreateResourceTypeInput {
  code: string;
  name: string;
  slotDurationMinutes?: number;
  opStartMinutes: number;
  opEndMinutes: number;
  hourlyRateCents: number;
  maxAdvanceDays: number;
  maxReservationsPerMemberPerDay: number;
  cancellationDeadlineMinutes: number;
  minTier?: MemberTier;
  active?: boolean;
  displayOrder?: number;
}

export interface UpdateResourceTypeInput {
  name?: string;
  slotDurationMinutes?: number;
  opStartMinutes?: number;
  opEndMinutes?: number;
  hourlyRateCents?: number;
  maxAdvanceDays?: number;
  maxReservationsPerMemberPerDay?: number;
  cancellationDeadlineMinutes?: number;
  minTier?: MemberTier;
  active?: boolean;
  displayOrder?: number;
}

export class ResourceTypeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listAll(): Promise<ResourceType[]> {
    return this.prisma.resourceType.findMany({
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    }) as unknown as ResourceType[];
  }

  async listActive(): Promise<ResourceType[]> {
    return this.prisma.resourceType.findMany({
      where: { active: true },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    }) as unknown as ResourceType[];
  }

  async getByCode(code: string): Promise<ResourceType | null> {
    return this.prisma.resourceType.findUnique({ where: { code } }) as unknown as ResourceType | null;
  }

  async getById(id: string): Promise<ResourceType | null> {
    return this.prisma.resourceType.findUnique({ where: { id } }) as unknown as ResourceType | null;
  }

  async create(data: CreateResourceTypeInput): Promise<ResourceType> {
    return this.prisma.resourceType.create({ data }) as unknown as ResourceType;
  }

  async update(id: string, data: UpdateResourceTypeInput): Promise<ResourceType> {
    return this.prisma.resourceType.update({ where: { id }, data }) as unknown as ResourceType;
  }
}

export interface CreateResourceInput {
  typeId: string;
  name: string;
  active?: boolean;
  displayOrder?: number;
}

export interface UpdateResourceInput {
  name?: string;
  active?: boolean;
  displayOrder?: number;
}

export class ResourceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listAll(): Promise<Resource[]> {
    return this.prisma.resource.findMany({
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    }) as unknown as Resource[];
  }

  async listActiveByType(typeId: string): Promise<Resource[]> {
    return this.prisma.resource.findMany({
      where: { typeId, active: true },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    }) as unknown as Resource[];
  }

  async listByTypeIds(typeIds: string[]): Promise<Resource[]> {
    if (typeIds.length === 0) return [];
    return this.prisma.resource.findMany({
      where: { typeId: { in: typeIds } },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    }) as unknown as Resource[];
  }

  async getById(id: string): Promise<Resource | null> {
    return this.prisma.resource.findUnique({ where: { id } }) as unknown as Resource | null;
  }

  async listByIds(ids: string[]): Promise<Resource[]> {
    if (ids.length === 0) return [];
    return this.prisma.resource.findMany({
      where: { id: { in: ids } },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    }) as unknown as Resource[];
  }

  async countActiveByType(): Promise<Map<string, number>> {
    const groups = await this.prisma.resource.groupBy({
      by: ['typeId'],
      where: { active: true },
      _count: { _all: true },
    });
    return new Map(groups.map((group) => [group.typeId, group._count._all]));
  }

  async create(data: CreateResourceInput): Promise<Resource> {
    return this.prisma.resource.create({ data }) as unknown as Resource;
  }

  async update(id: string, data: UpdateResourceInput): Promise<Resource> {
    return this.prisma.resource.update({ where: { id }, data }) as unknown as Resource;
  }
}
