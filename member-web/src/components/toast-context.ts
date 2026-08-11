/**
 * Toast contract. The provider lives in Toast.tsx; this module holds the
 * context and hook so component files export only components.
 */
import { createContext, useContext } from 'react';

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismissal. */
  duration?: number;
}

export interface ToastContextValue {
  toast: (options: ToastOptions) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Toast conventions: success toasts confirm mutations whose result is not
 * already visible on screen; error toasts surface unexpected failures
 * (validation errors belong inline on the form instead).
 */
export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return value;
}
