import { useState } from 'react';
import styles from './Avatar.module.css';

export interface AvatarProps {
  /** Full name; used for the alt text and the initials fallback. */
  name: string;
  src?: string | null;
  /** xl is the account profile header (Figma 168:15494). */
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Circular avatar with an initials fallback when there is no image. */
export function Avatar({ name, src, size = 'md' }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;

  return (
    <span className={[styles.avatar, styles[size]].join(' ')}>
      {showImage ? (
        <img className={styles.image} src={src!} alt={name} onError={() => setFailed(true)} />
      ) : (
        <span aria-hidden className={styles.initials}>
          {initialsOf(name)}
        </span>
      )}
      {!showImage && <span className="visually-hidden">{name}</span>}
    </span>
  );
}
