import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { api, type NotificationPreferences } from '../../lib/api';
import { PageHeader } from '../../app/AppShell';
import { Button, Card, Skeleton, Switch, useToast } from '../../components';
import { preferencesQuery } from './account-data';
import styles from './account.module.css';

const TOGGLES: { key: keyof NotificationPreferences; label: string }[] = [
  { key: 'pushNotifications', label: 'Push notifications' },
  { key: 'emailNotifications', label: 'Email notifications' },
  { key: 'bookingReminders', label: 'Booking reminders' },
];

/**
 * App preferences (Figma app-preferences 107:9789): the notification
 * toggles saved independently on change (optimistic, per-key rollback),
 * Data & privacy, Help & support, and About with the build-time version.
 *
 * The Privacy policy / Terms of Service / Contact us / Rate the app rows
 * have no destination anywhere in the product yet (no docs, routes, or
 * store listing), so they render as inert coming-soon rows rather than
 * dead links; see docs/w6-account-notes.md.
 */
export function AppPreferencesPage() {
  const preferences = useQuery(preferencesQuery);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const update = useMutation({
    mutationKey: ['preferences-update'],
    mutationFn: (patch: Partial<NotificationPreferences>) => api.updatePreferences(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: preferencesQuery.queryKey });
      const previous = queryClient.getQueryData<NotificationPreferences>(preferencesQuery.queryKey);
      queryClient.setQueryData<NotificationPreferences>(preferencesQuery.queryKey, (prev) =>
        prev ? { ...prev, ...patch } : prev,
      );
      return { previous };
    },
    // Per-KEY writes in both directions: each save carries only its own
    // toggle, so a slow response (or its rollback) must never clobber
    // another in-flight toggle's optimistic state.
    onError: (_error, patch, context) => {
      const previous = context?.previous;
      if (previous) {
        queryClient.setQueryData<NotificationPreferences>(preferencesQuery.queryKey, (prev) => {
          if (!prev) return prev;
          const next = { ...prev };
          for (const key of Object.keys(patch) as (keyof NotificationPreferences)[]) {
            next[key] = previous[key];
          }
          return next;
        });
      }
      toast({ message: 'We could not save that setting. Please try again.', variant: 'error' });
    },
    onSuccess: (server, patch) => {
      queryClient.setQueryData<NotificationPreferences>(preferencesQuery.queryKey, (prev) => {
        if (!prev) return server;
        const next = { ...prev };
        for (const key of Object.keys(patch) as (keyof NotificationPreferences)[]) {
          next[key] = server[key];
        }
        return next;
      });
    },
    onSettled: () => {
      // Converge with the server once the burst of toggles is over.
      if (queryClient.isMutating({ mutationKey: ['preferences-update'] }) === 1) {
        void queryClient.invalidateQueries({ queryKey: preferencesQuery.queryKey });
      }
    },
  });

  return (
    <div className={styles.page}>
      <Link to="/account" className={styles.backLink}>
        <ChevronLeft aria-hidden />
        Back to account
      </Link>
      <PageHeader title="App preferences" />

      <section className={styles.section} aria-labelledby="prefs-notifications-label">
        <h2 id="prefs-notifications-label" className={styles.sectionLabel}>
          Notifications
        </h2>

        {preferences.isPending && (
          <div role="status" aria-busy="true" className={styles.loadingStack}>
            <span className="visually-hidden">Loading your notification settings</span>
            {TOGGLES.map(({ key }) => (
              <Skeleton key={key} height="3.25rem" shape="card" />
            ))}
          </div>
        )}

        {preferences.isError && (
          <div className={styles.errorBox} role="alert">
            <p>We could not load your notification settings.</p>
            <Button variant="secondary" size="sm" onClick={() => void preferences.refetch()}>
              Try again
            </Button>
          </div>
        )}

        {preferences.isSuccess && (
          <Card padding="none" className={styles.menuCard}>
            {TOGGLES.map(({ key, label }) => (
              <div key={key} className={styles.toggleRow}>
                <Switch
                  label={label}
                  checked={preferences.data[key]}
                  onChange={(event) => update.mutate({ [key]: event.target.checked })}
                />
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className={styles.section} aria-labelledby="prefs-privacy-label">
        <h2 id="prefs-privacy-label" className={styles.sectionLabel}>
          Data &amp; privacy
        </h2>
        <Card padding="none" className={styles.menuCard}>
          <ComingSoonRow label="Privacy policy" />
          <Link to="/account/delete" className={[styles.menuRow, styles.menuRowAccent].join(' ')}>
            <span className={styles.menuRowLabel}>Delete my account</span>
          </Link>
        </Card>
      </section>

      <section className={styles.section} aria-labelledby="prefs-support-label">
        <h2 id="prefs-support-label" className={styles.sectionLabel}>
          Help &amp; support
        </h2>
        <Card padding="none" className={styles.menuCard}>
          <ComingSoonRow label="Contact us" />
          <ComingSoonRow label="Rate the app" />
        </Card>
      </section>

      <section className={styles.section} aria-labelledby="prefs-about-label">
        <h2 id="prefs-about-label" className={styles.sectionLabel}>
          About
        </h2>
        <Card padding="none" className={styles.menuCard}>
          <div className={styles.menuRow}>
            <span className={styles.menuRowLabel}>Version</span>
            <span className={styles.menuRowValue}>{__APP_VERSION__}</span>
          </div>
          <ComingSoonRow label="Terms of Service" />
        </Card>
      </section>
    </div>
  );
}

function ComingSoonRow({ label }: { label: string }) {
  return (
    <div className={[styles.menuRow, styles.menuRowDisabled].join(' ')}>
      <span className={styles.menuRowLabel}>{label}</span>
      <span className={styles.comingSoon}>Coming soon</span>
    </div>
  );
}
