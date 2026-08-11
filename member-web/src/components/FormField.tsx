import {
  forwardRef,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { Eye, EyeOff } from 'lucide-react';
import styles from './FormField.module.css';

/** Props FormField injects into its control (spread them onto the input). */
export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

export interface FormFieldProps {
  /** Rendered uppercase per the Figma ("FULL NAME", "EMAIL"). */
  label: string;
  /** Validation message; announced via the control's aria-describedby. */
  error?: string;
  /** Optional helper text shown when there is no error. */
  hint?: string;
  children: (props: FieldControlProps) => ReactNode;
}

/**
 * Accessible labelled field: wires label, control, and error/hint text
 * together with generated ids. Usage:
 *
 *   <FormField label="Email" error={errors.email?.message}>
 *     {(field) => <Input type="email" {...field} {...register('email')} />}
 *   </FormField>
 */
export function FormField({ label, error, hint, children }: FormFieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const hasMessage = Boolean(error ?? hint);

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        'aria-describedby': hasMessage ? messageId : undefined,
        'aria-invalid': error ? true : undefined,
      })}
      {hasMessage && (
        <p id={messageId} className={error ? styles.error : styles.hint}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={[styles.input, className ?? ''].join(' ')} {...rest} />;
});

/** Password input with a show/hide toggle. */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputProps, 'type'>>(
  function PasswordInput({ className, ...rest }, ref) {
    const [visible, setVisible] = useState(false);

    return (
      <div className={styles.passwordWrap}>
        <input
          ref={ref}
          type={visible ? 'text' : 'password'}
          className={[styles.input, styles.passwordInput, className ?? ''].join(' ')}
          {...rest}
        />
        <button
          type="button"
          className={styles.passwordToggle}
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
        >
          {visible ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
        </button>
      </div>
    );
  },
);
