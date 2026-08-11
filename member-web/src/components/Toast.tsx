import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react';
import { ToastContext, type ToastOptions, type ToastVariant } from './toast-context';
import styles from './Toast.module.css';

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

const ICONS: Record<ToastVariant, ReactNode> = {
  success: <CheckCircle2 size={18} aria-hidden />,
  error: <CircleAlert size={18} aria-hidden />,
  info: <Info size={18} aria-hidden />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    ({ message, variant = 'info', duration }: ToastOptions) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, message, variant }]);
      const timeout = duration ?? (variant === 'error' ? 7000 : 5000);
      window.setTimeout(() => dismiss(id), timeout);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* aria-live region: new toasts are announced without stealing focus. */}
      <div className={styles.viewport} role="status" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={[styles.toast, styles[item.variant]].join(' ')}>
            <span className={styles.icon}>{ICONS[item.variant]}</span>
            <span className={styles.message}>{item.message}</span>
            <button
              type="button"
              className={styles.dismiss}
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss notification"
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
