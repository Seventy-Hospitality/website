import { QrCode, House } from 'lucide-react';
import { PageHeader } from '../../app/AppShell';
import { useSession } from '../../lib/session-context';
import { Button, EmptyState } from '../../components';

/**
 * Home stub (package W2 builds the real feed). Demonstrates the shell
 * header contract from the Figma home: greeting eyebrow, display name,
 * QR entry button in the actions slot.
 */
export function HomePage() {
  const { principal } = useSession();
  // The Principal carries no display name; W2 swaps this for the member
  // profile's first name from the home aggregation endpoint.
  const displayName = principal?.email.split('@')[0] ?? 'there';

  return (
    <>
      <PageHeader
        eyebrow="Welcome,"
        title={displayName}
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<QrCode aria-hidden />}
            disabled
            title="Member QR arrives with the account package"
          >
            QR
          </Button>
        }
      />
      <EmptyState
        icon={<House aria-hidden />}
        title="Your home feed is on its way"
        description="Quick booking, upcoming reservations, invitations, and spotlight events land here (package W2)."
      />
    </>
  );
}
