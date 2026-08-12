import { Readable } from 'node:stream';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { MediaObjectStorage } from '../application';
import { parseAssetPath } from '../domain';

interface S3MediaStorageOptions {
  bucket: string;
  region: string;
  prefix?: string;
  client?: S3Client;
}

function resolveStaticAwsCredentialsFromEnv() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();

  if (!accessKeyId || !secretAccessKey) {
    return undefined;
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN?.trim() || undefined,
  };
}

export class S3MediaStorage implements MediaObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3MediaStorageOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? '';
    this.client = options.client ?? new S3Client({
      region: options.region,
      credentials: resolveStaticAwsCredentialsFromEnv(),
    });
  }

  async put(storagePath: string, input: { bytes: Buffer; contentType: string; cacheControl: string }): Promise<void> {
    const mapped = this.toObjectKey(storagePath);
    if (!mapped) throw new Error(`Unmanaged media path: ${storagePath}`);

    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: mapped.objectKey,
      Body: input.bytes,
      ContentType: input.contentType,
      CacheControl: input.cacheControl,
      // App-level AES-GCM is the real control for private usages; SSE is a
      // free second layer.
      ...(mapped.isPrivate ? { ServerSideEncryption: 'AES256' as const } : {}),
    }));
  }

  async get(storagePath: string) {
    const mapped = this.toObjectKey(storagePath);
    if (!mapped) return null;

    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: mapped.objectKey,
      }));

      const bytes = response.Body ? await response.Body.transformToByteArray() : null;
      if (!bytes) {
        return null;
      }

      return {
        body: Readable.from(Buffer.from(bytes)),
        contentLength: response.ContentLength,
        lastModifiedAt: response.LastModified,
        etag: response.ETag,
      };
    } catch (readError) {
      if (isNotFound(readError)) return null;
      throw readError;
    }
  }

  async delete(storagePath: string): Promise<boolean> {
    const mapped = this.toObjectKey(storagePath);
    if (!mapped) return false;

    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: mapped.objectKey,
    }));
    return true;
  }

  /**
   * Public "/uploads/<dir>/<name>" maps to "<prefix?>/<dir>/<name>" (the
   * historical event-image layout is preserved); private
   * "private/<dir>/<name>" maps to "<prefix?>/private/<dir>/<name>".
   */
  private toObjectKey(storagePath: string): { objectKey: string; isPrivate: boolean } | null {
    const parsed = parseAssetPath(storagePath);
    if (!parsed) return null;

    const isPrivate = parsed.spec.visibility === 'private';
    const relative = isPrivate
      ? path.posix.join('private', parsed.spec.directory, parsed.objectName)
      : path.posix.join(parsed.spec.directory, parsed.objectName);
    const normalizedPrefix = this.prefix.trim().replace(/^\/+|\/+$/g, '');
    return {
      objectKey: normalizedPrefix ? path.posix.join(normalizedPrefix, relative) : relative,
      isPrivate,
    };
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err != null &&
    (
      ('name' in err && ((err as { name?: string }).name === 'NoSuchKey' || (err as { name?: string }).name === 'NotFound')) ||
      ('$metadata' in err && (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
    )
  );
}
