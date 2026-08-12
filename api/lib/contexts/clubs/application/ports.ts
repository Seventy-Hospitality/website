import type { TransactionContext } from '@/lib/kernel';

/**
 * Same-transaction audit trail plus outbox feed (satisfied by the shared
 * EventStore). Every club mutation appends its club.* events through this
 * inside the mutating transaction; the outbox dispatcher hands undispatched
 * rows to package F's notification consumer later.
 */
export interface AuditLog {
  append(
    tx: TransactionContext,
    event: {
      streamType: string;
      streamId: string;
      eventType: string;
      data: unknown;
      actorId?: string;
      source?: string;
    },
  ): Promise<unknown>;
}

/**
 * The slice of the media context clubs needs for cover images (adapted over
 * MediaService in the container, pinned to the event-image usage so a club
 * cover call can never touch an asset of another usage): upload through the
 * ManagedMediaAsset pipeline, attach the asset to its club, drop a replaced
 * cover. Covers are public assets, so the path IS the browser URL.
 */
export interface ManagedCoverImageStore {
  uploadCoverImage(input: {
    filename: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<{ publicPath: string }>;
  attachManagedAssetToOwner(
    publicPath: string | null | undefined,
    owner: { ownerType: string; ownerId: string },
  ): Promise<void>;
  deleteManagedAsset(publicPath: string | null | undefined): Promise<void>;
}
