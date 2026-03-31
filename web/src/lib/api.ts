// In dev, Vite proxies /api/* to the API server (see vite.config.ts)
// In production, configure your reverse proxy to do the same
const API_URL = import.meta.env.VITE_API_URL ?? '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });

  const json = await res.json();

  if (!res.ok) {
    throw new ApiError(json.error?.code ?? 'UNKNOWN', json.error?.message ?? 'Request failed', res.status);
  }

  return json.data;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const api = {
  // Auth
  sendMagicLink: (email: string) =>
    request('/api/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }) }),
  getMe: () => request<{ userId: string; email: string } | null>('/api/auth/me'),
  logout: () => request('/api/auth/logout', { method: 'POST' }),

  // Members
  listMembers: (params?: { search?: string; status?: string; page?: number; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.search) query.set('search', params.search);
    if (params?.status) query.set('status', params.status);
    if (params?.page) query.set('page', String(params.page));
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return request<any>(`/api/members${qs ? `?${qs}` : ''}`);
  },
  getMember: (id: string) => request<any>(`/api/members/${id}`),
  createMember: (data: { email: string; firstName: string; lastName: string; phone?: string }) =>
    request<any>('/api/members', { method: 'POST', body: JSON.stringify(data) }),
  updateMember: (id: string, data: Record<string, unknown>) =>
    request<any>(`/api/members/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  addNote: (memberId: string, content: string) =>
    request<any>(`/api/members/${memberId}/notes`, { method: 'POST', body: JSON.stringify({ content }) }),

  // Stripe
  createCheckoutSession: (memberId: string, planId: string) =>
    request<{ url: string }>('/api/stripe/create-checkout-session', {
      method: 'POST',
      body: JSON.stringify({ memberId, planId }),
    }),
  createPortalSession: (memberId: string) =>
    request<{ url: string }>('/api/stripe/create-portal-session', {
      method: 'POST',
      body: JSON.stringify({ memberId }),
    }),
  // Plans
  listPlans: () => request<any[]>('/api/plans'),

  // Courts
  listCourts: () => request<any[]>('/api/courts'),
  getCourtAvailability: (courtId: string, date: string) =>
    request<any[]>(`/api/courts/${courtId}/availability?date=${date}`),
  bookCourt: (courtId: string, date: string, startTime: string, memberId: string) =>
    request<any>(`/api/courts/${courtId}/bookings`, {
      method: 'POST',
      body: JSON.stringify({ date, startTime, memberId }),
    }),
  cancelCourtBooking: (courtId: string, bookingId: string) =>
    request<any>(`/api/courts/${courtId}/bookings/${bookingId}`, { method: 'DELETE' }),

  // Showers
  listShowers: () => request<any[]>('/api/showers'),
  getShowerAvailability: (showerId: string, date: string) =>
    request<any[]>(`/api/showers/${showerId}/availability?date=${date}`),
  bookShower: (showerId: string, date: string, startTime: string, memberId: string) =>
    request<any>(`/api/showers/${showerId}/bookings`, {
      method: 'POST',
      body: JSON.stringify({ date, startTime, memberId }),
    }),
  cancelShowerBooking: (showerId: string, bookingId: string) =>
    request<any>(`/api/showers/${showerId}/bookings/${bookingId}`, { method: 'DELETE' }),

  // Bookings (admin)
  listBookings: (date?: string) => {
    const qs = date ? `?date=${date}` : '';
    return request<any[]>(`/api/bookings${qs}`);
  },

  // Facility booking count
  getFacilityBookingCount: (type: 'court' | 'shower', id: string) =>
    request<{ count: number }>(`/api/facilities/${type}/${id}/booking-count`),

  // Court admin
  listAllCourts: () => request<any[]>('/api/courts/all'),
  createCourt: (data: { name: string }) =>
    request<any>('/api/courts', { method: 'POST', body: JSON.stringify(data) }),
  updateCourt: (id: string, data: Record<string, unknown>) =>
    request<any>(`/api/courts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Shower admin
  listAllShowers: () => request<any[]>('/api/showers/all'),
  createShower: (data: { name: string }) =>
    request<any>('/api/showers', { method: 'POST', body: JSON.stringify(data) }),
  updateShower: (id: string, data: Record<string, unknown>) =>
    request<any>(`/api/showers/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
};
