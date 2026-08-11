import { Construction } from 'lucide-react';
import { PageHeader } from '../app/AppShell';
import { Badge, EmptyState } from '../components';

export interface PlaceholderPageProps {
  title: string;
  /** The flow package that owns this screen (W1..W6). */
  ownerPackage: string;
  description: string;
}

/**
 * Labelled stub for a flow screen owned by another package. Navigation
 * works end to end; the owning package replaces this with the real page.
 */
export function PlaceholderPage({ title, ownerPackage, description }: PlaceholderPageProps) {
  return (
    <>
      <PageHeader title={title} actions={<Badge variant="neutral">{ownerPackage}</Badge>} />
      <EmptyState
        icon={<Construction aria-hidden />}
        title={`${title} is on its way`}
        description={`${description} (package ${ownerPackage}).`}
      />
    </>
  );
}
