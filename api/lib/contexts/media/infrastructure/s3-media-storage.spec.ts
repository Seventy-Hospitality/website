import { Readable } from 'node:stream';
import { S3MediaStorage } from './s3-media-storage';

const NAME = 'ck2qwertyuiopasdfghj.png';
const PUBLIC_PATH = `/uploads/event-images/${NAME}`;
const PRIVATE_PATH = `private/id-photos/${NAME}`;

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function makeStorage(send: ReturnType<typeof vi.fn>, prefix?: string) {
  return new S3MediaStorage({
    bucket: 'seventy-media',
    region: 'us-east-1',
    prefix,
    client: { send } as any,
  });
}

describe('S3MediaStorage', () => {
  it('writes public assets under the historical event-images key layout', async () => {
    const send = vi.fn().mockResolvedValue({});
    const storage = makeStorage(send);

    await storage.put(PUBLIC_PATH, {
      bytes: Buffer.from('image-bytes'),
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    });

    const commandInput = send.mock.calls[0][0].input;
    expect(commandInput).toMatchObject({
      Bucket: 'seventy-media',
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000, immutable',
    });
    expect(commandInput.Key).toBe(`event-images/${NAME}`);
    expect(commandInput.ServerSideEncryption).toBeUndefined();
  });

  it('writes private assets under private/ with SSE, honoring the prefix', async () => {
    const send = vi.fn().mockResolvedValue({});
    const storage = makeStorage(send, 'app');

    await storage.put(PRIVATE_PATH, {
      bytes: Buffer.from('ciphertext'),
      contentType: 'application/octet-stream',
      cacheControl: 'no-store',
    });

    const commandInput = send.mock.calls[0][0].input;
    expect(commandInput.Key).toBe(`app/private/id-photos/${NAME}`);
    expect(commandInput.ServerSideEncryption).toBe('AES256');
    expect(commandInput.CacheControl).toBe('no-store');
  });

  it('reads managed assets from S3', async () => {
    const send = vi.fn().mockResolvedValue({
      Body: {
        transformToByteArray: vi.fn().mockResolvedValue(Uint8Array.from(Buffer.from('hello'))),
      },
      ContentLength: 5,
      LastModified: new Date('2026-04-04T12:00:00.000Z'),
      ETag: '"etag-1"',
    });
    const storage = makeStorage(send);

    const asset = await storage.get(PUBLIC_PATH);

    expect(asset?.contentLength).toBe(5);
    expect(asset?.etag).toBe('"etag-1"');
    expect(await streamToBuffer(asset!.body)).toEqual(Buffer.from('hello'));
  });

  it('returns null for missing objects and unmanaged paths', async () => {
    const send = vi.fn().mockRejectedValue({ name: 'NoSuchKey' });
    const storage = makeStorage(send);

    await expect(storage.get(PUBLIC_PATH)).resolves.toBeNull();
    await expect(storage.get('/uploads/event-images/../secrets.png')).resolves.toBeNull();
    await expect(storage.get(`/uploads/id-photos/${NAME}`)).resolves.toBeNull();
  });

  it('deletes managed assets from S3', async () => {
    const send = vi.fn().mockResolvedValue({});
    const storage = makeStorage(send);

    expect(await storage.delete(PUBLIC_PATH)).toBe(true);

    expect(send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'seventy-media',
      Key: `event-images/${NAME}`,
    });
  });
});
