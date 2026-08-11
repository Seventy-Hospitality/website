import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  /** Icon rendered inside the accent circle (a lucide icon works well). */
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Call to action, typically a <Button> or <ButtonLink>. */
  action?: ReactNode;
}

/**
 * First-class empty state (the Figma omits most of them; this is the
 * standard treatment, styled after the home "book your first session"
 * banner: elevated card, icon, short copy, one action).
 */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      {icon && (
        <span aria-hidden className={styles.iconCircle}>
          {icon}
        </span>
      )}
      <h2 className={styles.title}>{title}</h2>
      {description && <p className={styles.description}>{description}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
