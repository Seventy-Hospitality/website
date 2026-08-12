import { Redirect } from 'expo-router';
import { useSession } from '../src/lib/session';
import { OnboardingEntry } from '../src/features/onboarding/OnboardingGate';

export default function IndexRoute() {
  const { status } = useSession();

  if (status === 'loading') {
    return null;
  }

  // A signed-in user lands here (auth screens redirect to '/'); the onboarding
  // gate decides tabs vs. the right resume step. A not-yet-onboarded member is
  // pushed into their step, a fully onboarded one is sent to the tabs.
  if (status === 'authenticated') {
    return <OnboardingEntry />;
  }

  return <Redirect href="/auth/sign-in" />;
}
