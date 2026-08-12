import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarX2, ChevronRight, Lock } from 'lucide-react';
import { PageHeader } from '../../app/AppShell';
import { Badge, Button, EmptyState, IconTile, ResourceTypeIcon, Skeleton } from '../../components';
import { availabilityCountLabel } from '../../lib/booking';
import { formatAmount } from '../../lib/plan-pricing';
import type { ResourceTypeSummary } from '../../lib/api';
import { membershipQuery } from '../onboarding/onboarding-data';
import { isEntitledMembershipStatus, resourceTypesQuery } from './booking-data';
import { MembershipInactiveState } from './MembershipInactiveState';
import styles from './ReservePage.module.css';

/**
 * The Reserve tab (Figma browse-courts 7:2331): amenity types with live
 * availability counts and rates. A tier-gated amenity the member cannot
 * book renders locked with the PRO badge. Tapping a type starts the
 * booking wizard for it.
 */
export function ReservePage() {
  const types = useQuery(resourceTypesQuery);
  const membership = useQuery(membershipQuery);

  const membershipStatus = membership.data?.membership?.status ?? null;
  const lapsed = membership.isSuccess && !isEntitledMembershipStatus(membershipStatus);

  return (
    <>
      <PageHeader title="Reserve" />
      <p className={styles.subtitle}>Book courts and amenities in advance</p>

      {lapsed ? (
        <MembershipInactiveState />
      ) : types.isPending || membership.isPending ? (
        <div className={styles.list} aria-busy="true" role="status">
          <span className="visually-hidden">Loading amenities</span>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height="5rem" shape="card" />
          ))}
        </div>
      ) : types.isError || membership.isError ? (
        <div className={styles.errorBox} role="alert">
          <p>We could not load the amenities.</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              if (types.isError) void types.refetch();
              if (membership.isError) void membership.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      ) : types.data.length === 0 ? (
        <EmptyState
          icon={<CalendarX2 aria-hidden />}
          title="Nothing to book yet"
          description="The club has not opened any amenities for booking."
        />
      ) : (
        <ul className={styles.list}>
          {types.data.map((type) => (
            <li key={type.code}>
              <ResourceTypeRow type={type} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ResourceTypeRow({ type }: { type: ResourceTypeSummary }) {
  const navigate = useNavigate();

  const content = (
    <>
      <IconTile>
        <ResourceTypeIcon code={type.icon} />
      </IconTile>
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>
          {type.name}
          {type.locked && <Badge variant="accent">PRO</Badge>}
        </span>
        <span className={styles.rowSubtitle}>
          {availabilityCountLabel(type.name, type.resourceCount)}
        </span>
      </span>
      <span className={styles.rowTrailing}>
        <span className={styles.rowRate}>{formatAmount(type.hourlyRateCents)}/hr</span>
        {type.locked ? (
          <Lock aria-hidden className={styles.rowChevron} />
        ) : (
          <ChevronRight aria-hidden className={styles.rowChevron} />
        )}
      </span>
    </>
  );

  if (type.locked) {
    return (
      <div className={[styles.row, styles.rowLocked].join(' ')}>
        {content}
        <span className="visually-hidden">Requires a PRO membership</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={[styles.row, styles.rowInteractive].join(' ')}
      onClick={() => navigate(`/reserve/${encodeURIComponent(type.code)}`)}
    >
      {content}
    </button>
  );
}
