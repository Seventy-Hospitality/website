import { type ReactNode, useId } from 'react';
import styles from './FormField.module.css';

interface FormFieldProps {
  label: string;
  fieldId?: string;
  helperText?: ReactNode;
  error?: string;
  children: (id: string) => ReactNode;
}

export function FormField({ label, fieldId, helperText, error, children }: FormFieldProps) {
  const autoId = useId();
  const id = fieldId ?? autoId;

  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <div className={styles.control}>{children(id)}</div>
      {helperText && !error && <div className={styles.helper}>{helperText}</div>}
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
