import { ClipboardCheck } from 'lucide-react';
import { ButtonLink, EmptyState } from '../../components';
import styles from './OnboardingPage.module.css';

/**
 * Onboarding stub (package W1): plan selection, Stripe checkout, ID
 * verification. Rendered outside the tab shell as a focused full-screen
 * flow. W1 gates entry on useSession().needsOnboarding / emailVerified.
 */
export function OnboardingPage() {
  return (
    <div className={styles.page}>
      <div className={styles.column}>
        <EmptyState
          icon={<ClipboardCheck aria-hidden />}
          title="Membership onboarding is on its way"
          description="Choose a membership, check out, and verify your ID here (package W1)."
          action={
            <ButtonLink to="/" variant="secondary">
              Back to home
            </ButtonLink>
          }
        />
      </div>
    </div>
  );
}
