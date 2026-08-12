import type { CSSProperties } from 'react';
import styles from './Skeleton.module.css';

export interface SkeletonProps {
  /** CSS width, defaults to 100%. */
  width?: string | number;
  /** CSS height, defaults to 1rem. */
  height?: string | number;
  /** Rounded rectangle by default; 'circle' for avatars, 'card' for panels. */
  shape?: 'text' | 'circle' | 'card';
  className?: string;
}

/**
 * Loading placeholder. Compose a few of these to mirror the final layout
 * (see CONVENTIONS.md: skeletons for initial loads, spinners for actions).
 * Mark the surrounding region with aria-busy while skeletons are shown.
 */
export function Skeleton({ width, height, shape = 'text', className }: SkeletonProps) {
  const style: CSSProperties = {
    width: width ?? '100%',
    height: height ?? (shape === 'circle' ? width : '1rem'),
  };

  return (
    <span
      aria-hidden
      className={[styles.skeleton, styles[shape], className ?? ''].join(' ')}
      style={style}
    />
  );
}
