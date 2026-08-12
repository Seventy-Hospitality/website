import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import styles from './Chip.module.css';

export interface ChipProps {
  label: string;
  /** Optional leading content (e.g. a small Avatar for invite chips). */
  leading?: ReactNode;
  /** When set, renders a labelled remove button. */
  onRemove?: () => void;
}

/** Compact removable token, e.g. selected players on a booking invite. */
export function Chip({ label, leading, onRemove }: ChipProps) {
  return (
    <span className={styles.chip}>
      {leading && <span className={styles.leading}>{leading}</span>}
      <span className={styles.label}>{label}</span>
      {onRemove && (
        <button
          type="button"
          className={styles.remove}
          onClick={onRemove}
          aria-label={`Remove ${label}`}
        >
          <X size={14} aria-hidden />
        </button>
      )}
    </span>
  );
}
