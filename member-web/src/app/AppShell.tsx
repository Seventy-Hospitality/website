import type { ReactNode, Ref } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { House, CalendarRange, Users, CircleUserRound } from 'lucide-react';
import { BrandMark } from './BrandMark';
import styles from './AppShell.module.css';

/**
 * The four member tabs per the Figma bottom bar. Home matches only exactly;
 * the other tabs stay active across their nested routes. Reservation detail
 * (/reservations/*) highlights Reserve.
 */
const NAV_ITEMS = [
  { to: '/', label: 'Home', icon: House, end: true },
  { to: '/reserve', label: 'Reserve', icon: CalendarRange, end: false },
  { to: '/clubs', label: 'Clubs', icon: Users, end: false },
  { to: '/account', label: 'Account', icon: CircleUserRound, end: false },
] as const;

function NavItems() {
  return (
    <>
      {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            [styles.navItem, isActive ? styles.navItemActive : ''].join(' ')
          }
        >
          <Icon aria-hidden className={styles.navIcon} />
          <span>{label}</span>
        </NavLink>
      ))}
    </>
  );
}

/**
 * Responsive member shell: a bottom tab bar on mobile (1:1 with the Figma)
 * that becomes a left sidebar from the md breakpoint (768px). Pages render
 * into the centered content column via <Outlet/> and provide their own
 * header with <PageHeader>.
 */
export function AppShell() {
  return (
    <div className={styles.shell}>
      <nav className={styles.sidebar} aria-label="Primary">
        <div className={styles.sidebarBrand}>
          <BrandMark size={40} />
        </div>
        <NavItems />
      </nav>

      <div className={styles.contentArea}>
        <main className={styles.main}>
          <Outlet />
        </main>
      </div>

      <nav className={styles.bottomBar} aria-label="Primary">
        <NavItems />
      </nav>
    </div>
  );
}

export interface PageHeaderProps {
  /** Small line above the title ("Welcome," on home). */
  eyebrow?: string;
  /** Big Manrope heading ("Olivia", "Reserve", ...). */
  title: string;
  /** Right-aligned actions (the QR button on home). */
  actions?: ReactNode;
  /**
   * Programmatic focus target: when set, the h1 takes tabIndex -1 so a
   * page can park keyboard focus on its own title when a more local
   * target (a section heading, a pressed button) unmounts. See the W2
   * home respond flow.
   */
  headingRef?: Ref<HTMLHeadingElement>;
}

/** Page header per the Figma home: eyebrow + display title, actions right. */
export function PageHeader({ eyebrow, title, actions, headingRef }: PageHeaderProps) {
  return (
    <header className={styles.pageHeader}>
      <div>
        {eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}
        <h1 tabIndex={headingRef ? -1 : undefined} ref={headingRef}>
          {title}
        </h1>
      </div>
      {actions && <div className={styles.headerActions}>{actions}</div>}
    </header>
  );
}
