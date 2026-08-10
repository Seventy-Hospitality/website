import type { FastifyInstance } from 'fastify';
import { mediaService } from '@/lib/container';

export async function uploadAssetRoutes(app: FastifyInstance) {
  app.get<{ Params: { objectName: string } }>('/event-images/:objectName', { config: { policy: 'public' } }, async (req, reply) => {
    const publicPath = `/uploads/event-images/${req.params.objectName}`;
    const asset = await mediaService.readManagedAsset(publicPath);

    if (!asset) {
      return reply.code(404).send({ message: 'Not Found' });
    }

    reply.type(asset.contentType);

    if (asset.cacheControl) {
      reply.header('Cache-Control', asset.cacheControl);
    }
    if (asset.contentLength !== undefined) {
      reply.header('Content-Length', asset.contentLength);
    }
    if (asset.lastModifiedAt) {
      reply.header('Last-Modified', asset.lastModifiedAt.toUTCString());
    }
    if (asset.etag) {
      reply.header('ETag', asset.etag);
    }

    return reply.send(asset.body);
  });
}
