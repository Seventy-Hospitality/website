import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import styles from './Checkbox.module.css';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Rendered to the right of the box; may contain links. */
  label: ReactNode;
}

/**
 * Labelled checkbox per the Figma checkout ("I agree to the Terms and
 * Conditions"): a 20px rounded box that fills with the accent color when
 * checked. The native input stays in the tree (visually hidden) so
 * keyboard, form, and screen-reader behavior are the platform's own.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;

  return (
    <label className={[styles.wrap, className ?? ''].join(' ')} htmlFor={inputId}>
      <input ref={ref} id={inputId} type="checkbox" className={styles.input} {...rest} />
      <span aria-hidden className={styles.box}>
        <Check className={styles.check} strokeWidth={3} />
      </span>
      <span className={styles.label}>{label}</span>
    </label>
  );
});
