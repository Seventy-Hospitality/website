import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays,
  Camera,
  ChevronRight,
  LogOut,
  MonitorPlay,
  Pencil,
  QrCode,
  SlidersHorizontal,
} from 'lucide-react';
import { api, ApiError, type HomeFeed, type MyProfile } from '../../lib/api';
import { memberDisplayName, memberNumberLabel } from '../../lib/invites';
import { useSession } from '../../lib/session-context';
import {
  Avatar,
  Button,
  Card,
  FormField,
  Input,
  MemberQrSheet,
  Skeleton,
  Spinner,
  useToast,
} from '../../components';
import { formatHours, memberSinceLabel } from './account-lib';
import { profileQuery } from './account-data';
import styles from './account.module.css';

/**
 * Account main (Figma account 168:15494): avatar with the camera-badge
 * upload, display name with inline edit, member since + number, the three
 * lifetime stat tiles, and the Account Settings menu. "Claim Clutch
 * session stats & clips" is parked backend-side and renders as an inert
 * coming-soon row. Sign out keeps F0's behavior.
 */
export function AccountPage() {
  const profile = useQuery(profileQuery);

  if (profile.isPending) {
    return (
      <div className={styles.page} role="status" aria-busy="true">
        <h1 className="visually-hidden">Account</h1>
        <span className="visually-hidden">Loading your account</span>
        <div className={styles.profileHeader}>
          <Skeleton width="5.5rem" height="5.5rem" shape="circle" />
          <Skeleton width="12rem" height="2rem" />
          <Skeleton width="9rem" />
        </div>
        <div className={styles.statRow}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height="5rem" shape="card" />
          ))}
        </div>
        <Skeleton height="18rem" shape="card" />
      </div>
    );
  }

  if (profile.isError) {
    return (
      <div className={styles.page}>
        <h1 className="visually-hidden">Account</h1>
        <div className={styles.errorBox} role="alert">
          <p>We could not load your account.</p>
          <Button variant="secondary" size="sm" onClick={() => void profile.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return <AccountView profile={profile.data} />;
}

function AccountView({ profile }: { profile: MyProfile }) {
  const { member, stats } = profile;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { signOut } = useSession();

  const [qrOpen, setQrOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const editNameButtonRef = useRef<HTMLButtonElement>(null);

  const signOutMutation = useMutation({
    mutationFn: signOut,
    onSuccess: () => navigate('/sign-in', { replace: true }),
  });

  // ── Avatar upload (replace; POST /api/me/avatar, multipart) ──

  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadAvatar = useMutation({
    mutationFn: api.uploadAvatar,
    onSuccess: ({ avatarUrl }) => {
      queryClient.setQueryData<MyProfile>(profileQuery.queryKey, (prev) =>
        prev ? { ...prev, member: { ...prev.member, avatarUrl } } : prev,
      );
      // The home header and club rosters render the same avatar.
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
      toast({ message: 'Profile photo updated', variant: 'success' });
    },
    onError: (error) => {
      const message =
        error instanceof ApiError && (error.code === 'INVALID_IMAGE' || error.code === 'FILE_TOO_LARGE')
          ? error.message
          : 'We could not update your photo. Please try again.';
      toast({ message, variant: 'error' });
    },
    onSettled: () => {
      // Allow re-selecting the same file after a failure.
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
  });

  const name = memberDisplayName(member);

  return (
    <div className={styles.page}>
      <h1 className="visually-hidden">Account</h1>

      <header className={styles.profileHeader}>
        <div className={styles.avatarWrap}>
          <Avatar name={name} src={member.avatarUrl} size="xl" />
          <button
            type="button"
            className={styles.cameraBadge}
            aria-label="Change profile photo"
            aria-busy={uploadAvatar.isPending || undefined}
            disabled={uploadAvatar.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploadAvatar.isPending ? <Spinner size={14} /> : <Camera aria-hidden />}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) uploadAvatar.mutate(file);
            }}
          />
        </div>

        {editingName ? (
          <DisplayNameForm
            currentDisplayName={member.displayName}
            fallbackName={`${member.firstName} ${member.lastName}`}
            onDone={() => {
              setEditingName(false);
              // Return focus to the control that opened the editor.
              requestAnimationFrame(() => editNameButtonRef.current?.focus());
            }}
          />
        ) : (
          <div className={styles.nameRow}>
            <p className={styles.nameHeading}>{name}</p>
            <button
              ref={editNameButtonRef}
              type="button"
              className={styles.editNameButton}
              aria-label="Edit display name"
              onClick={() => setEditingName(true)}
            >
              <Pencil aria-hidden />
            </button>
          </div>
        )}

        <p className={styles.memberMeta}>{memberSinceLabel(member.memberSince)}</p>
        <p className={styles.memberNumber}>{memberNumberLabel(member.memberNumber)}</p>
      </header>

      <section className={styles.statRow} aria-label="Lifetime activity">
        <StatTile value={String(stats.courtsBooked)} label="Courts booked" />
        <StatTile value={formatHours(stats.badmintonHours)} label="Badminton hours" />
        <StatTile value={formatHours(stats.tennisHours)} label="Tennis hours" />
      </section>

      <section className={styles.section} aria-labelledby="account-settings-label">
        <h2 id="account-settings-label" className={styles.sectionLabel}>
          Account settings
        </h2>
        <Card padding="none" className={styles.menuCard}>
          <MenuRow icon={<QrCode aria-hidden />} label="View membership card" onClick={() => setQrOpen(true)} />
          {/* Parked feature (decisions-account.md): rendered, never active. */}
          <MenuRow icon={<MonitorPlay aria-hidden />} label="Claim Clutch session stats & clips" comingSoon />
          <MenuRow icon={<CalendarDays aria-hidden />} label="Billing history" to="/account/billing" />
          <MenuRow icon={<SlidersHorizontal aria-hidden />} label="App preferences" to="/account/preferences" />
          <button
            type="button"
            className={[styles.menuRow, styles.menuRowAccent].join(' ')}
            disabled={signOutMutation.isPending}
            aria-busy={signOutMutation.isPending || undefined}
            onClick={() => signOutMutation.mutate()}
          >
            {signOutMutation.isPending ? <Spinner size={18} /> : <LogOut aria-hidden />}
            <span className={styles.menuRowLabel}>Sign out</span>
          </button>
        </Card>
      </section>

      <MemberQrSheet
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        memberName={name}
        memberNumber={member.memberNumber}
      />
    </div>
  );
}

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <Card padding="none" className={styles.statTile}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </Card>
  );
}

function MenuRow({
  icon,
  label,
  to,
  onClick,
  comingSoon = false,
}: {
  icon: ReactNode;
  label: string;
  to?: string;
  onClick?: () => void;
  comingSoon?: boolean;
}) {
  if (comingSoon) {
    return (
      <div className={[styles.menuRow, styles.menuRowDisabled].join(' ')}>
        {icon}
        <span className={styles.menuRowLabel}>{label}</span>
        <span className={styles.comingSoon}>Coming soon</span>
      </div>
    );
  }

  const content = (
    <>
      {icon}
      <span className={styles.menuRowLabel}>{label}</span>
      <ChevronRight aria-hidden className={styles.menuChevron} />
    </>
  );

  if (to) {
    return (
      <Link to={to} className={styles.menuRow}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" className={styles.menuRow} onClick={onClick}>
      {content}
    </button>
  );
}

/**
 * Inline display-name editor. Saving a blank clears the display name back
 * to the "First Last" fallback (PATCH sends displayName: null).
 */
function DisplayNameForm({
  currentDisplayName,
  fallbackName,
  onDone,
}: {
  currentDisplayName: string | null;
  fallbackName: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(currentDisplayName ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const save = useMutation({
    mutationFn: api.updateMyProfile,
    onSuccess: ({ member }) => {
      queryClient.setQueryData<MyProfile>(profileQuery.queryKey, (prev) =>
        prev ? { ...prev, member } : prev,
      );
      // The name shows on the home feed cache too; refresh both surfaces.
      queryClient.setQueryData<HomeFeed>(['home'], (prev) =>
        prev ? { ...prev, member } : prev,
      );
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
      onDone();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (save.isPending) return;
    const trimmed = value.trim();
    if ((trimmed || null) === (currentDisplayName ?? null)) {
      onDone();
      return;
    }
    save.mutate({ displayName: trimmed || null });
  }

  const errorMessage = save.isError
    ? save.error instanceof ApiError && save.error.status === 422
      ? save.error.message
      : 'We could not save your name. Please try again.'
    : undefined;

  return (
    <form className={styles.nameForm} onSubmit={submit} noValidate>
      <FormField label="Display name" error={errorMessage} hint={`Leave blank to use ${fallbackName}.`}>
        {(field) => (
          <Input
            {...field}
            ref={inputRef}
            value={value}
            maxLength={60}
            autoComplete="nickname"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onDone();
            }}
          />
        )}
      </FormField>
      <div className={styles.nameFormActions}>
        <Button type="submit" size="sm" loading={save.isPending}>
          Save
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
