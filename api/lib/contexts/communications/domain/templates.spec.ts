import {
  magicLinkEmail,
  welcomeEmail,
  paymentFailedEmail,
  membershipCanceledEmail,
} from './templates';

describe('magicLinkEmail', () => {
  it('addresses the recipient', () => {
    const msg = magicLinkEmail('user@test.com', 'https://app.com/verify?token=abc');
    expect(msg.to).toBe('user@test.com');
    expect(msg.subject).toContain('Sign in');
  });

  it('includes the verify URL in the body', () => {
    const url = 'https://app.com/verify?token=abc';
    const msg = magicLinkEmail('user@test.com', url);
    expect(msg.html).toContain(url);
  });
});

describe('welcomeEmail', () => {
  it('includes member name and plan', () => {
    const msg = welcomeEmail('user@test.com', 'Jane', 'Monthly Membership');
    expect(msg.to).toBe('user@test.com');
    expect(msg.html).toContain('Jane');
    expect(msg.html).toContain('Monthly Membership');
    expect(msg.subject).toContain('Welcome');
  });
});

describe('paymentFailedEmail', () => {
  it('includes member name', () => {
    const msg = paymentFailedEmail('user@test.com', 'John');
    expect(msg.html).toContain('John');
    expect(msg.subject).toContain('Payment failed');
  });
});

describe('membershipCanceledEmail', () => {
  it('includes name and end date', () => {
    const msg = membershipCanceledEmail('user@test.com', 'Jane', 'March 30, 2026');
    expect(msg.html).toContain('Jane');
    expect(msg.html).toContain('March 30, 2026');
    expect(msg.subject).toContain('cancellation');
  });
});
