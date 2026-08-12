import { evaluateInviteLink, inviteLinkExpiry, DEFAULT_INVITE_LINK_TTL_DAYS } from './invite-link';

const NOW = new Date('2026-08-10T12:00:00Z');

function link(overrides: Partial<Parameters<typeof evaluateInviteLink>[0]> = {}) {
  return {
    revokedAt: null,
    expiresAt: new Date('2026-09-09T12:00:00Z'),
    maxUses: null,
    useCount: 0,
    ...overrides,
  };
}

describe('evaluateInviteLink', () => {
  it('accepts a live link', () => {
    expect(evaluateInviteLink(link(), NOW)).toBe('valid');
  });

  it('accepts a link with no expiry and no use cap', () => {
    expect(evaluateInviteLink(link({ expiresAt: null }), NOW)).toBe('valid');
  });

  it('rejects a revoked link, and revocation beats every other state', () => {
    expect(evaluateInviteLink(link({ revokedAt: NOW }), NOW)).toBe('revoked');
    expect(
      evaluateInviteLink(
        link({ revokedAt: NOW, expiresAt: new Date('2026-01-01T00:00:00Z'), maxUses: 1, useCount: 1 }),
        NOW,
      ),
    ).toBe('revoked');
  });

  it('expires inclusively AT the expiry instant', () => {
    expect(evaluateInviteLink(link({ expiresAt: NOW }), NOW)).toBe('expired');
    expect(evaluateInviteLink(link({ expiresAt: new Date(NOW.getTime() + 1) }), NOW)).toBe('valid');
  });

  it('exhausts when useCount reaches maxUses', () => {
    expect(evaluateInviteLink(link({ maxUses: 3, useCount: 2 }), NOW)).toBe('valid');
    expect(evaluateInviteLink(link({ maxUses: 3, useCount: 3 }), NOW)).toBe('exhausted');
    expect(evaluateInviteLink(link({ maxUses: 3, useCount: 4 }), NOW)).toBe('exhausted');
  });

  it('expiry outranks exhaustion', () => {
    expect(evaluateInviteLink(link({ expiresAt: NOW, maxUses: 1, useCount: 1 }), NOW)).toBe('expired');
  });
});

describe('inviteLinkExpiry', () => {
  it('defaults to the 30-day TTL', () => {
    expect(inviteLinkExpiry(NOW).getTime()).toBe(
      NOW.getTime() + DEFAULT_INVITE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
  });

  it('honors an explicit day count', () => {
    expect(inviteLinkExpiry(NOW, 1).getTime()).toBe(NOW.getTime() + 24 * 60 * 60 * 1000);
  });
});
