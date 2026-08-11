import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, type Principal } from './api';
import { MemberAuthGuard, SessionProvider } from './session';
import { useSession } from './session-context';

vi.mock('./api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./api')>();
  return {
    ...original,
    api: {
      ...original.api,
      getMe: vi.fn(),
      signOut: vi.fn(),
    },
  };
});

const getMe = vi.mocked(api.getMe);

const PRINCIPAL: Principal = {
  userId: 'u1',
  email: 'olivia@example.com',
  emailVerified: true,
  staffRole: null,
  memberId: 'm1',
  client: 'member_web',
};

function renderGuarded(initialPath = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function SessionProbe() {
    const { principal, needsOnboarding } = useSession();
    return (
      <div>
        <span>home for {principal?.email}</span>
        <span>{needsOnboarding ? 'needs onboarding' : 'onboarded'}</span>
      </div>
    );
  }

  render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route element={<MemberAuthGuard />}>
              <Route path="/" element={<SessionProbe />} />
            </Route>
            <Route path="/sign-in" element={<div>sign-in screen</div>} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MemberAuthGuard', () => {
  it('redirects anonymous visitors to /sign-in', async () => {
    getMe.mockResolvedValue(null);

    renderGuarded('/');

    expect(await screen.findByText('sign-in screen')).toBeInTheDocument();
  });

  it('renders the protected route for a signed-in principal', async () => {
    getMe.mockResolvedValue(PRINCIPAL);

    renderGuarded('/');

    expect(await screen.findByText('home for olivia@example.com')).toBeInTheDocument();
    expect(screen.getByText('onboarded')).toBeInTheDocument();
  });

  it('flags needsOnboarding when the principal has no member profile', async () => {
    getMe.mockResolvedValue({ ...PRINCIPAL, memberId: null });

    renderGuarded('/');

    expect(await screen.findByText('needs onboarding')).toBeInTheDocument();
  });
});
