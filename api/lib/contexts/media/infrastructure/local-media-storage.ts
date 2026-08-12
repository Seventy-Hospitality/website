import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MediaObjectStorage } from '../application';
import { parseAssetPath } from '../domain';

export function getMediaUploadsRoot(cwd = process.cwd()): string {
  return path.resolve(cwd, 'uploads');
}

/**
 * Private assets live OUTSIDE the public uploads root (no ancestor
 * relationship), so no static-file registration over uploads/ can ever
 * reach them.
 */
export function getMediaPrivateRoot(cwd = process.cwd()): string {
  const configured = process.env.MEDIA_PRIVATE_ROOT?.trim();
  return configured ? path.resolve(configured) : path.resolve(cwd, 'uploads-private');
}

export class LocalMediaStorage implements MediaObjectStorage {
  constructor(
    private readonly uploadsRoot = getMediaUploadsRoot(),
    private readonly privateRoot = getMediaPrivateRoot(),
  ) {}

  async put(storagePath: string, input: { bytes: Buffer; contentType: string; cacheControl: string }): Promise<void> {
    const filePath = this.resolveFilePath(storagePath);
    if (!filePath) throw new Error(`Unmanaged media path: ${storagePath}`);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, input.bytes);
  }

  async get(storagePath: string) {
    const filePath = this.resolveFilePath(storagePath);
    if (!filePath) return null;

    try {
      const fileStat = await stat(filePath);
      return {
        body: createReadStream(filePath),
        contentLength: fileStat.size,
        lastModifiedAt: fileStat.mtime,
      };
    } catch (readError) {
      if (isEnoent(readError)) return null;
      throw readError;
    }
  }

  async delete(storagePath: string): Promise<boolean> {
    const filePath = this.resolveFilePath(storagePath);
    if (!filePath) return false;

    try {
      await stat(filePath);
    } catch (statError) {
      if (isEnoent(statError)) return true; // already gone = effective
      throw statError;
    }
    await rm(filePath, { force: true });
    return true;
  }

  /**
   * Maps a canonical storage path to a filesystem path under the correct
   * root, with a containment guard on top of the whitelist parse.
   */
  private resolveFilePath(storagePath: string): string | null {
    const parsed = parseAssetPath(storagePath);
    if (!parsed) return null;

    const root = path.resolve(parsed.spec.visibility === 'public' ? this.uploadsRoot : this.privateRoot);
    const filePath = path.resolve(root, parsed.spec.directory, parsed.objectName);
    if (!filePath.startsWith(`${root}${path.sep}`)) return null;
    return filePath;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' && err != null && 'code' in err && (err as { code?: string }).code === 'ENOENT'
  );
}
