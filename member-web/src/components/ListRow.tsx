import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import styles from './ListRow.module.css';

export interface ListRowProps {
  /** Leading visual: an icon (wrapped in the tinted tile) or an <Avatar>. */
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  /** Trailing content: a small Button, Badge, chevron, price, ... */
  trailing?: ReactNode;
  /** Makes the whole row a link. */
  to?: string;
  /** Makes the whole row a button. Ignored when `to` is set. */
  onClick?: () => void;
}

/**
 * Card list row per the Figma home "Reserve play" cards: elevated card,
 * leading icon tile, title + subtitle, trailing action.
 */
export function ListRow({ leading, title, subtitle, trailing, to, onClick }: ListRowProps) {
  const content = (
    <>
      {leading && <span className={styles.leading}>{leading}</span>}
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
      </span>
      {trailing && <span className={styles.trailing}>{trailing}</span>}
    </>
  );

  if (to) {
    return (
      <Link to={to} className={[styles.row, styles.interactive].join(' ')}>
        {content}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={[styles.row, styles.interactive].join(' ')}>
        {content}
      </button>
    );
  }

  return <div className={styles.row}>{content}</div>;
}

/** Tinted square tile for a leading icon, per the Figma activity cards. */
export function IconTile({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className={styles.iconTile}>
      {children}
    </span>
  );
}
