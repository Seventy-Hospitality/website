import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronLeft, TriangleAlert } from 'lucide-react';
import { api, ApiError, type DeleteAccountProof } from '../../lib/api';
import { useSession } from '../../lib/session-context';
import { PageHeader } from '../../app/AppShell';
import {
  Button,
  Card,
  FormField,
  Input,
  PasswordInput,
  Sheet,
  Skeleton,
  useToast,
} from '../../components';
import { authIdentitiesQuery } from './account-data';
import styles from './account.module.css';

/**
 * Delete account (DELETE /api/me): the most destructive flow in the app.
 *
 * The backend requires STEP-UP re-auth to start a deletion: the current
 * password for a password account, or (for passwordless/OAuth accounts) a
 * single-use emailed code from POST /api/me/reauth-email, which the
 * backend accepts for every account. A fresh OAuth assertion is also
 * accepted server-side; the web client uses the emailed code instead so
 * the deletion flow never embeds the provider SDKs.
 *
 * What deletion does (the backend's resumable saga): cancels the
 * membership now, cancels future reservations with policy refunds,
 * releases club roles and invitations, then anonymizes the profile and
 * erases credentials. 409 DELETION_BLOCKED (open dispute / refund in
 * flight) renders the blocked state; any 202 means the saga is running
 * server-side and the client signs out locally.
 */
export function DeleteAccountPage() {
  const identities = useQuery(authIdentitiesQuery);

  return (
    <div className={styles.page}>
      <Link to="/account/preferences" className={styles.backLink}>
        <ChevronLeft aria-hidden />
        Back to preferences
      </Link>
      <PageHeader title="Delete account" />

      <Card padding="lg" className={styles.consequences}>
        <p className={styles.dialogText}>Deleting your account:</p>
        <ul>
          <li>cancels your membership immediately, with no refund for the current period,</li>
          <li>cancels your upcoming reservations (refunds follow the standard cancellation policy),</li>
          <li>removes you from your clubs and withdraws invitations you sent,</li>
          <li>anonymizes your profile and retires your member number, and</li>
          <li>signs you out everywhere and permanently disables sign-in.</li>
        </ul>
        <p className={styles.dialogText}>
          <strong>This cannot be undone.</strong>
        </p>
      </Card>

      {identities.isPending && (
        <div role="status" aria-busy="true" className={styles.loadingStack}>
          <span className="visually-hidden">Loading your confirmation options</span>
          <Skeleton height="8rem" shape="card" />
        </div>
      )}

      {identities.isError && (
        <div className={styles.errorBox} role="alert">
          <p>We could not load your confirmation options.</p>
          <Button variant="secondary" size="sm" onClick={() => void identities.refetch()}>
            Try again
          </Button>
        </div>
      )}

      {identities.isSuccess && <DeleteAccountFlow hasPassword={identities.data.hasPassword} />}
    </div>
  );
}

function DeleteAccountFlow({ hasPassword }: { hasPassword: boolean }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { principal, signOut } = useSession();

  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [blockedReasons, setBlockedReasons] = useState<string[] | null>(null);

  const sendCode = useMutation({
    mutationFn: api.requestReauthEmail,
    onSuccess: () => {
      setCodeSent(true);
      setStepUpError(null);
    },
    onError: (error) => {
      setStepUpError(
        error instanceof ApiError && error.status === 429
          ? 'Too many codes requested. Please wait 15 minutes and try again.'
          : 'We could not send the code. Please try again.',
      );
    },
  });

  const deleteAccount = useMutation({
    mutationFn: (proof: DeleteAccountProof) => api.deleteAccount(proof),
    onSuccess: async () => {
      // Any 202 means the saga is running (or done) server-side; locally
      // the account is gone either way.
      toast({ message: 'Your account has been deleted.', variant: 'success' });
      await signOut();
      navigate('/sign-in', { replace: true });
    },
    onError: (error) => {
      setConfirmOpen(false);
      if (error instanceof ApiError) {
        if (error.code === 'DELETION_BLOCKED') {
          const details = error.details as { reasons?: string[] } | undefined;
          setBlockedReasons(details?.reasons ?? []);
          return;
        }
        if (error.code === 'STEP_UP_FAILED' || error.code === 'STEP_UP_REQUIRED') {
          setStepUpError(
            hasPassword
              ? 'That password is incorrect.'
              : 'That code was not accepted. It may have expired; send yourself a new one.',
          );
          return;
        }
        if (error.status === 429) {
          setStepUpError('Too many attempts. Please wait 15 minutes and try again.');
          return;
        }
      }
      setStepUpError('Something went wrong. Please try again.');
    },
  });

  // The step-up gate: no proof text, no confirm dialog, no request.
  const proofValue = hasPassword ? password : code;
  const proofReady = proofValue.trim().length > 0;
  const proof: DeleteAccountProof = hasPassword
    ? { password }
    : { reauthToken: code.trim() };

  if (blockedReasons !== null) {
    return (
      <div className={styles.errorBox} role="alert">
        <p>
          <strong>We cannot delete your account right now.</strong>
        </p>
        {blockedReasons.length > 0 && (
          <p>
            Deletion is blocked by {formatReasons(blockedReasons)}. Once that is resolved you
            can try again.
          </p>
        )}
        <p>Contact the club if you need help resolving this.</p>
        <Button variant="secondary" size="sm" onClick={() => navigate('/account/preferences')}>
          Back to preferences
        </Button>
      </div>
    );
  }

  return (
    <>
      <form
        className={styles.stepUpForm}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (proofReady && !deleteAccount.isPending) setConfirmOpen(true);
        }}
        noValidate
      >
        {hasPassword ? (
          <FormField
            label="Current password"
            error={stepUpError ?? undefined}
            hint="Confirm it is really you before we delete anything."
          >
            {(field) => (
              <PasswordInput
                {...field}
                value={password}
                autoComplete="current-password"
                onChange={(event) => {
                  setPassword(event.target.value);
                  setStepUpError(null);
                }}
              />
            )}
          </FormField>
        ) : (
          <>
            <p className={styles.stepUpStatus}>
              {codeSent
                ? `We emailed a confirmation code to ${principal?.email ?? 'your address'}. It expires in 10 minutes.`
                : 'Your account has no password, so we confirm it is really you with an emailed code.'}
            </p>
            <div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={sendCode.isPending}
                onClick={() => sendCode.mutate()}
              >
                {codeSent ? 'Send a new code' : 'Email me a code'}
              </Button>
            </div>
            {codeSent && (
              <FormField label="Confirmation code" error={stepUpError ?? undefined}>
                {(field) => (
                  <Input
                    {...field}
                    value={code}
                    autoComplete="one-time-code"
                    inputMode="text"
                    onChange={(event) => {
                      setCode(event.target.value);
                      setStepUpError(null);
                    }}
                  />
                )}
              </FormField>
            )}
            {!codeSent && stepUpError && (
              <p role="alert" className={styles.payAlert}>
                {stepUpError}
              </p>
            )}
          </>
        )}

        <div className={styles.deleteActions}>
          <Button
            type="submit"
            variant="danger"
            disabled={!proofReady}
            loading={deleteAccount.isPending}
          >
            Delete my account
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={deleteAccount.isPending}
            onClick={() => navigate('/account/preferences')}
          >
            Keep my account
          </Button>
        </div>
      </form>

      {/* ── Final, focus-trapped confirmation ── */}
      <Sheet
        open={confirmOpen}
        onClose={() => {
          if (!deleteAccount.isPending) setConfirmOpen(false);
        }}
        title="Delete account"
        footer={
          <div className={styles.dialogActions}>
            <Button
              variant="danger"
              fullWidth
              loading={deleteAccount.isPending}
              onClick={() => deleteAccount.mutate(proof)}
            >
              Permanently delete my account
            </Button>
            <Button
              variant="secondary"
              fullWidth
              disabled={deleteAccount.isPending}
              onClick={() => setConfirmOpen(false)}
            >
              Go back
            </Button>
          </div>
        }
      >
        <div className={styles.dialogBody}>
          <p className={styles.dialogText}>
            <TriangleAlert aria-hidden className={styles.warnIcon} /> This permanently deletes
            your account, membership, and reservations.
          </p>
          <p className={styles.dialogHint}>
            There is no undo and no recovery period. Your member number is retired and your
            profile is anonymized.
          </p>
        </div>
      </Sheet>
    </>
  );
}

/** "an open payment dispute and a refund in flight" from the reason list. */
function formatReasons(reasons: string[]): string {
  if (reasons.length === 1) return reasons[0];
  return `${reasons.slice(0, -1).join(', ')} and ${reasons[reasons.length - 1]}`;
}
