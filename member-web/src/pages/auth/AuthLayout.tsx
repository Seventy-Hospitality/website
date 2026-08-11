import type { ReactNode } from 'react';
import styles from './auth.module.css';

export interface AuthLayoutProps {
  /** Big Manrope heading ("Create account", "Sign In"). */
  title: string;
  children: ReactNode;
  /** Bottom area per the Figma: the swap link ("Or login as member"). */
  footer?: ReactNode;
}

/**
 * Frame for the auth screens: the Figma phone layout 1:1 on mobile
 * (24px gutters, 354px column), centered on desktop.
 */
export function AuthLayout({ title, children, footer }: AuthLayoutProps) {
  return (
    <div className={styles.page}>
      <div className={styles.column}>
        <h1 className={styles.title}>{title}</h1>
        {children}
      </div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </div>
  );
}

/** The "── or ──" separator between OAuth and the credential form. */
export function OrDivider() {
  return (
    <div className={styles.divider} aria-hidden>
      <span className={styles.dividerLine} />
      <span className={styles.dividerText}>or</span>
      <span className={styles.dividerLine} />
    </div>
  );
}
