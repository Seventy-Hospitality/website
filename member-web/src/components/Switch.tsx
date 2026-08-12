import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import styles from './Switch.module.css';

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Rendered to the left of the toggle; the whole row is the tap target. */
  label: string;
}

/**
 * Labelled toggle switch per the Figma app-preferences rows: a pill track
 * with a sliding thumb that fills with the accent color when on. The
 * native checkbox stays in the tree (visually hidden) with role="switch",
 * so keyboard behavior is the platform's own and screen readers announce
 * on/off as the state flips.
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;

  return (
    <label className={[styles.wrap, className ?? ''].join(' ')} htmlFor={inputId}>
      <span className={styles.label}>{label}</span>
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        role="switch"
        className={styles.input}
        {...rest}
      />
      <span aria-hidden className={styles.track}>
        <span className={styles.thumb} />
      </span>
    </label>
  );
});
