import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../lib/api';
import { MemberQrSheet } from './MemberQrSheet';

/**
 * The membership QR card: fetches the short-lived token only while open,
 * renders it as a labelled QR with the member-number text fallback,
 * re-requests a fresh token before the current one expires, and never
 * shows a previous open's (likely expired) token after a reopen.
 */

vi.mock('../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api')>();
  return {
    ...original,
    api: { ...original.api, getMemberQr: vi.fn() },
  };
});

const getMemberQr = vi.mocked(api.getMemberQr);

function qrToken(token: string, ttlMs: number) {
  return {
    token,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    ttlSeconds: Math.round(ttlMs / 1000),
  };
}

function renderSheet(open: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (isOpen: boolean) => (
    <QueryClientProvider client={client}>
      <MemberQrSheet
        open={isOpen}
        onClose={() => {}}
        memberName="Olivia Zha"
        memberNumber="A12345"
      />
    </QueryClientProvider>
  );
  const view = render(ui(open));
  return { ...view, setOpen: (isOpen: boolean) => view.rerender(ui(isOpen)) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MemberQrSheet', () => {
  it('does not request a token while closed', () => {
    getMemberQr.mockResolvedValue(qrToken('t1', 60_000));
    renderSheet(false);
    expect(getMemberQr).not.toHaveBeenCalled();
  });

  it('fetches the token when opened and renders the labelled QR + number fallback', async () => {
    getMemberQr.mockResolvedValue(qrToken('club70-token-1', 60_000));
    renderSheet(true);

    const qr = await screen.findByRole('img', { name: 'Check-in QR code for member A12345' });
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
    expect(getMemberQr).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Olivia Zha')).toBeInTheDocument();
    expect(screen.getByText('#A12345')).toBeInTheDocument();
  });

  it('re-requests a fresh token before the current one expires', async () => {
    // First token "expires" almost immediately, so the refresh timer fires
    // at its 1s floor; the second token is long-lived.
    getMemberQr
      .mockResolvedValueOnce(qrToken('short-lived', 2_000))
      .mockResolvedValue(qrToken('fresh-token', 60_000));
    renderSheet(true);

    await screen.findByRole('img', { name: /Check-in QR code/ });
    expect(getMemberQr).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(getMemberQr).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    // Still exactly one QR on screen, now encoding the fresh token.
    expect(screen.getByRole('img', { name: /Check-in QR code/ })).toBeInTheDocument();
  });

  it('never shows the previous token after a close and reopen', async () => {
    // The sheet stays mounted between opens (the home page keeps it in the
    // tree), so this exercises the close-time cache removal: the reopened
    // card must show the loading skeleton, not the earlier (likely
    // expired) code, until the fresh token lands.
    getMemberQr.mockResolvedValueOnce(qrToken('previous-open-token', 60_000));
    const fresh = deferred<ReturnType<typeof qrToken>>();
    getMemberQr.mockReturnValueOnce(fresh.promise);
    const view = renderSheet(true);

    await screen.findByRole('img', { name: /Check-in QR code/ });

    view.setOpen(false);
    view.setOpen(true);

    // While the fresh token is in flight, the old QR must not be painted.
    expect(screen.queryByRole('img', { name: /Check-in QR code/ })).not.toBeInTheDocument();
    expect(screen.getByText('Loading your check-in code')).toBeInTheDocument();

    fresh.resolve(qrToken('fresh-open-token', 60_000));
    expect(await screen.findByRole('img', { name: /Check-in QR code/ })).toBeInTheDocument();
    expect(getMemberQr).toHaveBeenCalledTimes(2);
  });

  it('shows a retryable error when the token fetch fails', async () => {
    getMemberQr.mockRejectedValueOnce(new Error('offline'));
    getMemberQr.mockResolvedValueOnce(qrToken('recovered', 60_000));
    renderSheet(true);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not load your check-in code.',
    );
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(await screen.findByRole('img', { name: /Check-in QR code/ })).toBeInTheDocument();
  });
});
