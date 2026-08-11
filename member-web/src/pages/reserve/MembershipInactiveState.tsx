import { CreditCard } from 'lucide-react';
import { ButtonLink, EmptyState } from '../../components';

/**
 * Booking requires an active membership (the backend's active-member
 * policy). The onboarding gate guarantees one was purchased, so landing
 * here means it LAPSED; explain that instead of surfacing raw 403s.
 */
export function MembershipInactiveState() {
  return (
    <EmptyState
      icon={<CreditCard aria-hidden />}
      title="Your membership is not active"
      description="Booking needs an active membership. Check your billing details to get back on court."
      action={<ButtonLink to="/account">Go to account</ButtonLink>}
    />
  );
}
