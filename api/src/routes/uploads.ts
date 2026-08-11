import type { FastifyInstance, FastifyReply } from 'fastify';
import { mediaService } from '@/lib/container';

/**
 * Serves PUBLIC managed assets only. Private usages (ID photos) live under
 * a non-URL storage prefix, are refused by readPublicAsset, and are only
 * reachable through their authenticated staff endpoint.
 */
export async function uploadAssetRoutes(app: FastifyInstance) {
  app.get<{ Params: { objectName: string } }>('/event-images/:objectName', { config: { policy: 'public' } }, (req, reply) =>
    servePublicAsset(reply, `/uploads/event-images/${req.params.objectName}`),
  );

  app.get<{ Params: { objectName: string } }>('/avatars/:objectName', { config: { policy: 'public' } }, (req, reply) =>
    servePublicAsset(reply, `/uploads/avatars/${req.params.objectName}`),
  );
}

async function servePublicAsset(reply: FastifyReply, publicPath: string) {
  const asset = await mediaService.readPublicAsset(publicPath);

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
}
