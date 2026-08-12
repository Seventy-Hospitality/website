/**
 * Toast contract. The provider lives in Toast.tsx; this module holds the
 * context + hook so component files export only components.
 *
 * Conventions: success toasts confirm a mutation whose result is not visible
 * where the user is looking; error toasts surface unexpected failures. Form
 * validation stays inline, never in a toast.
 */
import { createContext, useContext } from 'react';

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismissal (default 3200). */
  duration?: number;
}

export interface ToastContextValue {
  toast: (options: ToastOptions) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return value;
}
