import styles from './Spinner.module.css';

export interface SpinnerProps {
  /** Diameter in px. */
  size?: number;
  className?: string;
}

/** Indeterminate spinner. Wrap in role="status" (or use FullScreenLoader). */
export function Spinner({ size = 24, className }: SpinnerProps) {
  return (
    <svg
      className={[styles.spinner, className ?? ''].join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        className={styles.track}
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className={styles.head}
        d="M12 2 a 10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Centered full-screen loading state (session bootstrap, route guards). */
export function FullScreenLoader({ label }: { label: string }) {
  return (
    <div className={styles.fullScreen} role="status">
      <Spinner size={32} className={styles.accent} />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}
