import { useEffect, useId, useRef, type ReactNode } from 'react';
import styles from './Sheet.module.css';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Centered header title per the Figma modals. */
  title: string;
  children: ReactNode;
  /** Pinned below the scrollable body (primary action, skip link, ...). */
  footer?: ReactNode;
}

/**
 * Modal surface: a bottom sheet on mobile that becomes a centered dialog on
 * desktop (min-width: 768px). Built on the native <dialog> element, which
 * provides focus trapping, Escape-to-close, and an inert background for
 * free. Figma reference: onboarding/upload-photo-modal (header with Close
 * on the left, centered title).
 */
export function Sheet({ open, onClose, title, children, footer }: SheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className={styles.sheet}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape key: route through onClose so `open` stays the source of truth.
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop targets the dialog element itself.
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className={styles.inner}>
        <header className={styles.header}>
          <button type="button" className={styles.close} onClick={onClose}>
            Close
          </button>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
        </header>
        <div className={styles.body}>{children}</div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </dialog>
  );
}
