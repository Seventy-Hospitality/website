/**
 * Shared render harness for the account screen tests: a QueryClient (retries
 * off) with optional seeded cache entries, wrapped in the SafeAreaProvider +
 * ToastProvider the screens (AppScreen, Sheet, toasts) require.
 */
import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ToastProvider } from '../../../components';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

export function makeClient(seed: [readonly unknown[], unknown][] = []): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  for (const [key, value] of seed) client.setQueryData(key as unknown[], value);
  return client;
}

export function renderWithProviders(
  ui: ReactElement,
  seed: [readonly unknown[], unknown][] = [],
  client: QueryClient = makeClient(seed),
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return { client, ...render(ui, { wrapper }) };
}
