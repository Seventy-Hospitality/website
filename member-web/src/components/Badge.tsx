import type { HTMLAttributes } from 'react';
import styles from './Badge.module.css';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'accent' | 'success' | 'neutral' | 'danger';
}

/** Uppercase pill label ("INVITE ONLY", statuses). */
export function Badge({ variant = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span className={[styles.badge, styles[variant], className ?? ''].join(' ')} {...rest}>
      {children}
    </span>
  );
}
