import type { PrismaClient } from '@prisma/client';
import type {
  ManagedMediaAssetRecord,
  ManagedMediaAssetRepository,
  MediaAssetOwner,
} from '../application';
import {
  type ManagedMediaAsset,
  type MediaAsset,
  type MediaUsage,
  MEDIA_ASSET_STATUS_ATTACHED,
  MEDIA_ASSET_STATUS_DISCARDED,
  MEDIA_ASSET_STATUS_PENDING,
  publicUrlFor,
} from '../domain';

/**
 * Owner-reference registry: for each usage, which columns may point at an
 * asset. The cleanup sweeper refuses to collect a pending asset something
 * still references even when its attach write was lost. `satisfies
 * Record<MediaUsage, ...>` makes adding a usage without declaring its
 * back-reference a compile error, so the sweeper can never silently start
 * deleting a live asset class.
 */
type ReferenceLookup = (prisma: PrismaClient, paths: string[]) => Promise<(string | null)[]>;

const OWNER_REFERENCES = {
  'event-image': async (prisma, paths) => {
    const [events, clubs] = await Promise.all([
      prisma.clubEvent.findMany({ where: { imageUrl: { in: paths } }, select: { imageUrl: true } }),
      prisma.club.findMany({ where: { coverImageUrl: { in: paths } }, select: { coverImageUrl: true } }),
    ]);
    return [...events.map((row) => row.imageUrl), ...clubs.map((row) => row.coverImageUrl)];
  },
  avatar: async (prisma, paths) => {
    const members = await prisma.member.findMany({
      where: { avatarUrl: { in: paths } },
      select: { avatarUrl: true },
    });
    return members.map((row) => row.avatarUrl);
  },
  'id-photo': async (prisma, paths) => {
    const verifications = await prisma.idVerification.findMany({
      where: { imageAssetRef: { in: paths } },
      select: { imageAssetRef: true },
    });
    return verifications.map((row) => row.imageAssetRef);
  },
} satisfies Record<MediaUsage, ReferenceLookup>;

const ASSET_SELECT = {
  storagePath: true,
  usage: true,
  status: true,
  contentType: true,
  sizeBytes: true,
  originalFilename: true,
  encryption: true,
  ownerType: true,
  ownerId: true,
  createdAt: true,
  attachedAt: true,
  discardedAt: true,
  purgedAt: true,
} as const;

type AssetRow = {
  storagePath: string;
  usage: string;
  status: string;
  contentType: string;
  sizeBytes: number;
  originalFilename: string;
  encryption: string | null;
  ownerType: string | null;
  ownerId: string | null;
  createdAt: Date;
  attachedAt: Date | null;
  discardedAt: Date | null;
  purgedAt: Date | null;
};

function toManagedMediaAsset(record: AssetRow): ManagedMediaAsset {
  return {
    storagePath: record.storagePath,
    publicUrl: publicUrlFor(record.storagePath),
    usage: record.usage as MediaUsage,
    status: record.status as ManagedMediaAsset['status'],
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    originalFilename: record.originalFilename,
    encryption: record.encryption,
    ownerType: record.ownerType,
    ownerId: record.ownerId,
    createdAt: record.createdAt,
    attachedAt: record.attachedAt,
    discardedAt: record.discardedAt,
    purgedAt: record.purgedAt,
  };
}

export class PrismaManagedMediaAssetRepository implements ManagedMediaAssetRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createPending(asset: MediaAsset, usage: MediaUsage, encryption: string | null): Promise<void> {
    await this.prisma.managedMediaAsset.create({
      data: {
        storagePath: asset.storagePath,
        usage,
        status: MEDIA_ASSET_STATUS_PENDING,
        contentType: asset.contentType,
        sizeBytes: asset.sizeBytes,
        originalFilename: asset.originalFilename,
        encryption,
      },
    });
  }

  async getByPath(storagePath: string): Promise<ManagedMediaAssetRecord | null> {
    return this.prisma.managedMediaAsset.findUnique({
      where: { storagePath },
      select: {
        storagePath: true,
        usage: true,
        status: true,
        contentType: true,
        sizeBytes: true,
        encryption: true,
        ownerType: true,
        ownerId: true,
      },
    });
  }

  async attachManagedAsset(storagePath: string, owner: MediaAssetOwner, attachedAt = new Date()): Promise<void> {
    await this.prisma.managedMediaAsset.updateMany({
      where: { storagePath, discardedAt: null },
      data: {
        status: MEDIA_ASSET_STATUS_ATTACHED,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        attachedAt,
      },
    });
  }

  async markManagedAssetDiscarded(storagePath: string, discardedAt = new Date()): Promise<void> {
    await this.prisma.managedMediaAsset.updateMany({
      where: { storagePath, discardedAt: null },
      data: {
        status: MEDIA_ASSET_STATUS_DISCARDED,
        ownerType: null,
        ownerId: null,
        discardedAt,
      },
    });
  }

  async markManagedAssetPurged(storagePath: string, purgedAt = new Date()): Promise<void> {
    await this.prisma.managedMediaAsset.updateMany({
      where: { storagePath, purgedAt: null },
      data: { purgedAt },
    });
  }

  async listStalePendingAssets(cutoffs: Record<MediaUsage, Date>, limit: number): Promise<ManagedMediaAsset[]> {
    const candidates: AssetRow[] = [];
    for (const [usage, cutoff] of Object.entries(cutoffs)) {
      candidates.push(
        ...(await this.prisma.managedMediaAsset.findMany({
          where: {
            usage,
            status: MEDIA_ASSET_STATUS_PENDING,
            discardedAt: null,
            createdAt: { lt: cutoff },
          },
          orderBy: { createdAt: 'asc' },
          take: Math.max(limit * 4, limit),
          select: ASSET_SELECT,
        })),
      );
    }
    if (candidates.length === 0) return [];

    // Safety net: never collect an asset an owner column still points at,
    // even when the attach write was lost.
    const referenced = new Set<string>();
    for (const usage of Object.keys(OWNER_REFERENCES) as MediaUsage[]) {
      const paths = candidates.filter((row) => row.usage === usage).map((row) => row.storagePath);
      if (paths.length === 0) continue;
      for (const path of await OWNER_REFERENCES[usage](this.prisma, paths)) {
        if (path) referenced.add(path);
      }
    }

    return candidates
      .filter((row) => !referenced.has(row.storagePath))
      .slice(0, limit)
      .map(toManagedMediaAsset);
  }

  async listDiscardedUnpurged(limit: number): Promise<ManagedMediaAsset[]> {
    const rows = await this.prisma.managedMediaAsset.findMany({
      where: { discardedAt: { not: null }, purgedAt: null },
      orderBy: { discardedAt: 'asc' },
      take: limit,
      select: ASSET_SELECT,
    });
    return rows.map(toManagedMediaAsset);
  }

  async listAttachedForOwner(owner: MediaAssetOwner): Promise<ManagedMediaAsset[]> {
    const rows = await this.prisma.managedMediaAsset.findMany({
      where: {
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        status: MEDIA_ASSET_STATUS_ATTACHED,
        discardedAt: null,
      },
      select: ASSET_SELECT,
    });
    return rows.map(toManagedMediaAsset);
  }
}
