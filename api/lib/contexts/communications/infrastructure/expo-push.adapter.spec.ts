import { ExpoPushAdapter } from './expo-push.adapter';

describe('ExpoPushAdapter', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('no-ops (logs, no HTTP) without a configured access token', async () => {
    const adapter = new ExpoPushAdapter('');

    await adapter.send([{ token: 'ExponentPushToken[abc]', title: 'Hi', body: 'There' }]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalled();
  });

  it('posts messages to the Expo push endpoint with the bearer token', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const adapter = new ExpoPushAdapter('expo-secret');

    await adapter.send([
      { token: 'tok-1', title: 'Invite', body: 'You are invited', data: { reservationId: 'rsv_1' } },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(init.headers.authorization).toBe('Bearer expo-secret');
    expect(JSON.parse(init.body)).toEqual([
      { to: 'tok-1', title: 'Invite', body: 'You are invited', data: { reservationId: 'rsv_1' } },
    ]);
  });

  it('chunks batches at 100 messages per request', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const adapter = new ExpoPushAdapter('expo-secret');

    const messages = Array.from({ length: 150 }, (_, i) => ({
      token: `tok-${i}`,
      title: 'T',
      body: 'B',
    }));
    await adapter.send(messages);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toHaveLength(100);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toHaveLength(50);
  });

  it('throws on a non-2xx response so the caller retries instead of dropping', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: async () => 'bad gateway' });
    const adapter = new ExpoPushAdapter('expo-secret');

    await expect(adapter.send([{ token: 'tok-1', title: 'T', body: 'B' }])).rejects.toThrow(
      /Expo push send failed \(502\)/,
    );
  });

  it('sends nothing for an empty batch', async () => {
    const adapter = new ExpoPushAdapter('expo-secret');
    await adapter.send([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
