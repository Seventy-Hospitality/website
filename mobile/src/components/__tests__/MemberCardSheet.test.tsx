import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api, type MemberQrToken } from '../../lib/api';
import { MemberCardSheet } from '../MemberCardSheet';

function token(secondsUntilExpiry: number): MemberQrToken {
  return {
    token: `MQR1.tok-${secondsUntilExpiry}`,
    expiresAt: new Date(Date.now() + secondsUntilExpiry * 1000).toISOString(),
    ttlSeconds: secondsUntilExpiry,
  };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <SafeAreaProvider
      initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}
    >
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </SafeAreaProvider>
  );
}

afterEach(() => jest.restoreAllMocks());

describe('MemberCardSheet', () => {
  it('fetches a QR token when opened and renders the code with a member-number label', async () => {
    const getMemberQr = jest.spyOn(api, 'getMemberQr').mockResolvedValue(token(60));
    const client = makeClient();

    render(
      <MemberCardSheet open onClose={() => undefined} memberName="Alice Chen" memberNumber="U00578" />,
      { wrapper: wrapper(client) },
    );

    await waitFor(() =>
      expect(screen.getByLabelText('Check-in QR code for member number U00578')).toBeTruthy(),
    );
    expect(getMemberQr).toHaveBeenCalledTimes(1);
    // Name (uppercased) and number fallback are always visible.
    expect(screen.getByText('ALICE CHEN')).toBeTruthy();
    expect(screen.getByText('#U00578')).toBeTruthy();
  });

  it('re-requests the token shortly before it expires (TTL refresh)', async () => {
    // A token 11s from expiry schedules the refresh at the 1s floor (10s margin),
    // so a real short wait exercises the refetch without a long delay. The
    // refreshed token sits 60s out, so it does not immediately re-refresh.
    const getMemberQr = jest
      .spyOn(api, 'getMemberQr')
      .mockResolvedValueOnce(token(11))
      .mockResolvedValue(token(60));
    const client = makeClient();

    render(
      <MemberCardSheet open onClose={() => undefined} memberName="Alice Chen" memberNumber="U00578" />,
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(getMemberQr).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getMemberQr).toHaveBeenCalledTimes(2), { timeout: 3000 });
  });

  it('drops the cached token when the sheet closes so a reopen never flashes a stale code', async () => {
    jest.spyOn(api, 'getMemberQr').mockResolvedValue(token(60));
    const client = makeClient();

    const view = render(
      <MemberCardSheet open onClose={() => undefined} memberName="Alice Chen" memberNumber="U00578" />,
      { wrapper: wrapper(client) },
    );

    await waitFor(() => expect(client.getQueryData(['member-qr'])).toBeDefined());

    view.rerender(
      <MemberCardSheet open={false} onClose={() => undefined} memberName="Alice Chen" memberNumber="U00578" />,
    );

    await waitFor(() => expect(client.getQueryData(['member-qr'])).toBeUndefined());
  });
});
