// Narrow media seams for the members context, adapted over MediaService in
// the container and pinned to their usage, so a members-side call can never
// touch an asset of another usage.

export interface UploadedImage {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/** Public avatar assets (the path IS the browser URL). */
export interface MemberAvatarStore {
  uploadAvatar(input: UploadedImage): Promise<{ publicUrl: string }>;
  attachToMember(publicUrl: string, memberId: string): Promise<void>;
  deleteAvatar(publicUrl: string | null | undefined): Promise<void>;
}

/** Private, encrypted, never-publicly-served government-ID photos. */
export interface IdPhotoStore {
  uploadIdPhoto(input: UploadedImage): Promise<{ storagePath: string }>;
  attachToMember(storagePath: string, memberId: string): Promise<void>;
  deleteIdPhoto(storagePath: string | null | undefined): Promise<void>;
  readIdPhoto(storagePath: string): Promise<{
    body: NodeJS.ReadableStream;
    contentType: string;
    contentLength?: number;
  } | null>;
}
