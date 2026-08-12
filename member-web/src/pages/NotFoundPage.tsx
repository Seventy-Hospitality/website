import { Compass } from 'lucide-react';
import { ButtonLink, EmptyState } from '../components';
import styles from './NotFoundPage.module.css';

export function NotFoundPage() {
  return (
    <div className={styles.page}>
      <div className={styles.column}>
        <EmptyState
          icon={<Compass aria-hidden />}
          title="Page not found"
          description="The page you are looking for does not exist or has moved."
          action={
            <ButtonLink to="/" variant="secondary">
              Back to home
            </ButtonLink>
          }
        />
      </div>
    </div>
  );
}
