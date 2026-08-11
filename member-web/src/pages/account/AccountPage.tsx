import { useNavigate } from 'react-router-dom';
import { CircleUserRound } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { PageHeader } from '../../app/AppShell';
import { useSession } from '../../lib/session-context';
import { Badge, Button, EmptyState } from '../../components';

/**
 * Account stub (package W6 builds profile, stats, QR card, billing,
 * notification preferences). Sign-out lives here already: it is part of
 * the auth foundation.
 */
export function AccountPage() {
  const navigate = useNavigate();
  const { principal, signOut } = useSession();

  const signOutMutation = useMutation({
    mutationFn: signOut,
    onSuccess: () => navigate('/sign-in', { replace: true }),
  });

  return (
    <>
      <PageHeader title="Account" actions={<Badge variant="neutral">W6</Badge>} />
      <EmptyState
        icon={<CircleUserRound aria-hidden />}
        title="Your account area is on its way"
        description={`Signed in as ${principal?.email ?? ''}. Profile, stats, member QR, billing, and preferences land here (package W6).`}
        action={
          <Button
            variant="danger"
            loading={signOutMutation.isPending}
            onClick={() => signOutMutation.mutate()}
          >
            Sign out
          </Button>
        }
      />
    </>
  );
}
