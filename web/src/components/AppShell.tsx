import { type ReactNode } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { SeventyLogo } from './SeventyLogo';
import styles from './AppShell.module.css';

const NAV_ITEMS = [
  { href: '/members', label: 'Members' },
  { href: '/bookings', label: 'Bookings' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  async function handleLogout() {
    await api.logout();
    navigate('/sign-in');
  }

  return (
    <div className={styles.shell}>
      <header className={styles.navbar}>
        <div className={styles.navLeft}>
          <Link to="/" className={styles.logoButton} aria-label="Home">
            <SeventyLogo size={20} className={styles.logoImage} />
          </Link>
          <nav className={styles.nav}>
            {NAV_ITEMS.map((item) => (
              <Link key={item.href} to={item.href} className={styles.navItem}>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <button className={styles.navItem} onClick={handleLogout}>
          Sign Out
        </button>
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
