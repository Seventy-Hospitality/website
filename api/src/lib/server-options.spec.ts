import Fastify from 'fastify';
import { SERVER_FASTIFY_OPTIONS } from './server-options';

describe('SERVER_FASTIFY_OPTIONS', () => {
  it('trusts the reverse proxy so rate-limit keys and audit IPs are the real client', () => {
    expect(SERVER_FASTIFY_OPTIONS.trustProxy).toBe(true);
  });

  it('resolves req.ip from X-Forwarded-For under these exact options', async () => {
    // Guards the fix: without trustProxy, req.ip would be the socket peer (the
    // proxy) and every caller would share one rate-limit bucket.
    const app = Fastify({ ...SERVER_FASTIFY_OPTIONS, logger: false });
    app.get('/whoami', async (req) => ({ ip: req.ip }));
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });

    expect(res.json().ip).toBe('203.0.113.7');
    await app.close();
  });
});
