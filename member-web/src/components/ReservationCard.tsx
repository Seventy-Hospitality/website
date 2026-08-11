import type { ComponentType, ReactNode } from 'react';
import {
  CalendarDays,
  Feather,
  Grid3x3,
  Monitor,
  ShowerHead,
  Volleyball,
} from 'lucide-react';
import { Card } from './Card';
import { IconTile } from './ListRow';
import styles from './ReservationCard.module.css';

/**
 * Amenity-type icon by resource-type code (the backend's `icon` field is
 * the code). W2 home cards and W4 reservation detail reuse this mapping.
 */
const TYPE_ICONS: Record<string, ComponentType<{ 'aria-hidden'?: boolean }>> = {
  badminton_court: Feather,
  tennis_court: Volleyball,
  mahjong_table: Grid3x3,
  tennis_simulator: Monitor,
  shower: ShowerHead,
};

export function ResourceTypeIcon({ code }: { code: string }) {
  const Icon = TYPE_ICONS[code] ?? CalendarDays;
  return <Icon aria-hidden />;
}

export interface ReservationCardRow {
  label: string;
  value: ReactNode;
}

export interface ReservationCardProps {
  /** Resource-type code; picks the icon. */
  typeCode: string;
  /** "Badminton Court". */
  typeName: string;
  /** The assigned unit ("Court 1"); omitted while unknown. */
  resourceName?: string | null;
  /**
   * Label/value facts about the reservation. `layout="columns"` puts them
   * side by side (checkout: Date / Time / Duration); `layout="rows"` stacks
   * them with dividers (confirmation: Date / Time / Booking ref / Amount).
   */
  rows: ReservationCardRow[];
  layout?: 'columns' | 'rows';
  className?: string;
}

/**
 * The reservation summary card per the Figma checkout and confirmation
 * screens: icon tile + amenity name + assigned court, then the fact rows.
 * Shared surface: W3 checkout/confirmation now, W2 home and W4 detail later.
 */
export function ReservationCard({
  typeCode,
  typeName,
  resourceName,
  rows,
  layout = 'columns',
  className,
}: ReservationCardProps) {
  return (
    <Card className={[styles.card, className ?? ''].join(' ')}>
      <div className={styles.head}>
        <IconTile>
          <ResourceTypeIcon code={typeCode} />
        </IconTile>
        <div className={styles.headText}>
          <span className={styles.typeName}>{typeName}</span>
          {resourceName && <span className={styles.resourceName}>{resourceName}</span>}
        </div>
      </div>

      {layout === 'columns' ? (
        <dl className={styles.columns}>
          {rows.map((row) => (
            <div key={row.label} className={styles.column}>
              <dt className={styles.label}>{row.label}</dt>
              <dd className={styles.value}>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <dl className={styles.rows}>
          {rows.map((row) => (
            <div key={row.label} className={styles.row}>
              <dt className={styles.label}>{row.label}</dt>
              <dd className={styles.value}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}
