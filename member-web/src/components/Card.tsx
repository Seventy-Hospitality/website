import type { HTMLAttributes } from 'react';
import styles from './Card.module.css';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * card: elevated surface (#2b3a2c), the default panel.
   * overlay: brighter surface (#3d5641) for nested or highlighted content.
   * outline: transparent with border, for de-emphasized groupings.
   */
  variant?: 'card' | 'overlay' | 'outline';
  padding?: 'md' | 'lg' | 'none';
}

/** Rounded surface panel per the Figma (radius 16, padding 16). */
export function Card({
  variant = 'card',
  padding = 'md',
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={[
        styles.surface,
        styles[variant],
        padding === 'lg' ? styles.padLg : padding === 'none' ? styles.padNone : styles.padMd,
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}
