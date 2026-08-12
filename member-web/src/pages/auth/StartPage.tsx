import { ButtonLink } from '../../components';
import { BrandMark } from '../../app/BrandMark';
import styles from './auth.module.css';

/** Splash entry per the Figma onboarding/start: brand mark, two actions. */
export function StartPage() {
  return (
    <div className={styles.start}>
      <div className={styles.startBrand}>
        <BrandMark size={96} />
      </div>
      <div className={styles.startActions}>
        <ButtonLink to="/sign-up" variant="primary" fullWidth>
          Sign up
        </ButtonLink>
        <ButtonLink to="/sign-in" variant="secondary" fullWidth>
          Member sign in
        </ButtonLink>
      </div>
    </div>
  );
}
