import { ResendAdapter } from './resend.adapter';

// The Resend SDK resolves with { data, error } instead of throwing on
// API-level failures. The adapter MUST surface `error` as a throw: both
// dispatch paths (delivery ledger, reminder markers) detect failure only
// through a rejected send, and a swallowed error would mark the email sent
// and drop it forever.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
    constructor(public readonly apiKey: string) {}
  },
}));

describe('ResendAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const notification = { type: 'payment-failed', to: 'member@example.com', memberName: 'Alice' } as const;

  it('no-ops (logs, no API call) without an API key', async () => {
    const adapter = new ResendAdapter('');

    await adapter.send(notification);

    expect(sendMock).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalled();
  });

  it('sends through the SDK and resolves on a success response', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null });
    const adapter = new ResendAdapter('re_key');

    await expect(adapter.send(notification)).resolves.toBeUndefined();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'member@example.com',
        subject: expect.stringContaining('Payment failed'),
        html: expect.stringContaining('Alice'),
      }),
    );
  });

  it('throws when the SDK resolves with an API-level error (send failed, must retry)', async () => {
    // e.g. sending domain not verified: every send returns this shape.
    sendMock.mockResolvedValue({
      data: null,
      error: { name: 'validation_error', message: 'The seventyhospitality.com domain is not verified', statusCode: 403 },
    });
    const adapter = new ResendAdapter('re_key');

    await expect(adapter.send(notification)).rejects.toThrow(
      /Resend send failed \(validation_error\): The seventyhospitality.com domain is not verified/,
    );
  });

  it('propagates a thrown SDK error unchanged', async () => {
    sendMock.mockRejectedValue(new Error('socket hang up'));
    const adapter = new ResendAdapter('re_key');

    await expect(adapter.send(notification)).rejects.toThrow('socket hang up');
  });
});
