import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Camera, CircleCheck, FileImage, RefreshCw } from 'lucide-react';
import { api, ApiError, type IdVerificationView } from '../../lib/api';
import { idVerificationQuery } from './onboarding-data';
import { Button, Sheet, Skeleton, Spinner, useToast } from '../../components';
import layout from './onboarding.module.css';
import styles from './VerifyIdentityPage.module.css';

/**
 * Onboarding step 3 (Figma onboarding/upload-photo-modal 26:1037 / 40:490):
 * the government-ID upload, presented as a modal Sheet over a bare
 * backdrop as the last onboarding step.
 *
 * The photo rides the authenticated /api/me/id-verification endpoints into
 * PRIVATE encrypted storage (never the public /uploads pipeline), and the
 * API never returns it, so the preview shown here is the locally selected
 * file; a resumed session that already uploaded shows a neutral tile.
 *
 * Closing the sheet records a skip (same as "Skip for now"): the flow may
 * only be left answered, so the resume gate never traps the member in a
 * reopening modal.
 */

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function VerifyIdentityPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const status = useQuery(idVerificationQuery);
  const view = status.data ?? null;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [localPhoto, setLocalPhoto] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Derived object URL for the local preview; revoked when replaced.
  const previewUrl = useMemo(
    () => (localPhoto ? URL.createObjectURL(localPhoto) : null),
    [localPhoto],
  );
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const applyView = (next: IdVerificationView) => {
    queryClient.setQueryData(idVerificationQuery.queryKey, next);
  };

  const upload = useMutation({
    mutationFn: api.uploadIdPhoto,
    onSuccess: (next, photo) => {
      applyView(next);
      setLocalPhoto(photo);
      setUploadError(null);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ID_VERIFICATION_STATE') {
        // Stale local status (e.g. already submitted in another tab).
        void status.refetch();
        return;
      }
      setUploadError(
        error instanceof ApiError && error.code !== 'UNKNOWN'
          ? error.message
          : 'We could not upload the photo. Please try again.',
      );
    },
  });

  const submit = useMutation({
    mutationFn: api.submitIdVerification,
    onSuccess: (next) => {
      applyView(next);
      toast({ variant: 'success', message: 'ID submitted for review.' });
      navigate('/', { replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ID_VERIFICATION_STATE') {
        void status.refetch();
        return;
      }
      toast({ variant: 'error', message: 'Could not submit your ID. Please try again.' });
    },
  });

  const skip = useMutation({
    mutationFn: api.skipIdVerification,
    onSuccess: (next) => {
      applyView(next);
      navigate('/', { replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ID_VERIFICATION_STATE') {
        // The step no longer applies (submitted in another tab); refresh
        // the status and leave.
        void status.refetch();
        navigate('/', { replace: true });
        return;
      }
      toast({ variant: 'error', message: 'Could not skip right now. Please try again.' });
    },
  });

  const answered = view !== null && view.status !== 'not_submitted';
  const canUpload = view !== null && !answered;
  const busy = upload.isPending || submit.isPending || skip.isPending;

  function leave() {
    if (busy) return;
    if (canUpload) {
      // Closing is an answer too: record the skip so the resume gate does
      // not bounce straight back into this modal.
      skip.mutate();
    } else {
      navigate('/', { replace: true });
    }
  }

  function handleFile(file: File | undefined) {
    if (!file || upload.isPending) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setUploadError('Choose a JPEG, PNG, or WebP image.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError('ID photos must be 10 MB or smaller.');
      return;
    }
    setUploadError(null);
    upload.mutate(file);
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    if (canUpload) handleFile(event.dataTransfer.files[0]);
  }

  return (
    <div className={styles.backdrop}>
      <Sheet
        open
        onClose={leave}
        title="Verify Identity"
        footer={
          answered ? (
            <div className={layout.footer}>
              <Button fullWidth onClick={() => navigate('/', { replace: true })}>
                Continue
              </Button>
            </div>
          ) : (
            <div className={layout.footer}>
              <button
                type="button"
                className={layout.footerLink}
                disabled={busy}
                onClick={() => skip.mutate()}
              >
                Skip for now
              </button>
              <Button
                fullWidth
                disabled={view === null || !view.hasPhoto}
                loading={submit.isPending || skip.isPending}
                onClick={() => submit.mutate()}
              >
                Submit ID
              </Button>
            </div>
          )
        }
      >
        <div className={styles.body}>
          <h2 className={styles.welcome}>Welcome to Club70</h2>
          <p className={styles.intro}>
            One last thing to get you set up: submit a photo of your government-issued ID. Our
            staff will use it to verify your identity upon first visit.
          </p>

          {status.isPending && (
            <div className={styles.loadingZone} aria-busy="true" role="status">
              <span className="visually-hidden">Loading your verification status</span>
              <Skeleton height="13rem" shape="card" />
            </div>
          )}

          {status.isError && (
            <div className={layout.errorBox} role="alert">
              <p>We could not load your verification status.</p>
              <Button variant="secondary" size="sm" onClick={() => void status.refetch()}>
                Try again
              </Button>
            </div>
          )}

          {view !== null && answered && <AnsweredPanel view={view} />}

          {view !== null && !answered && (
            <>
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                accept={ACCEPTED_TYPES.join(',')}
                tabIndex={-1}
                aria-hidden
                onChange={(event) => {
                  handleFile(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />

              {view.hasPhoto && !upload.isPending ? (
                <div className={styles.zone} onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
                  <p className={styles.fileName}>{localPhoto?.name ?? 'ID photo on file'}</p>
                  {previewUrl ? (
                    <img className={styles.preview} src={previewUrl} alt="Preview of your ID photo" />
                  ) : (
                    <span className={styles.previewFallback} aria-hidden>
                      <FileImage />
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<RefreshCw aria-hidden />}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Replace photo
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.zoneButton}
                  disabled={upload.isPending}
                  aria-busy={upload.isPending || undefined}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleDrop}
                >
                  {upload.isPending ? (
                    <>
                      <Spinner size={28} />
                      <span className={styles.zoneLabel}>Uploading photo…</span>
                    </>
                  ) : (
                    <>
                      <span className={styles.cameraCircle} aria-hidden>
                        <Camera />
                      </span>
                      <span className={styles.zoneLabel}>Take or upload a photo of your ID</span>
                    </>
                  )}
                </button>
              )}

              {uploadError && (
                <p role="alert" className={styles.uploadError}>
                  {uploadError}
                </p>
              )}

              <ul className={styles.tips}>
                <li className={styles.tip}>
                  <CircleCheck aria-hidden className={styles.tipIcon} />
                  Ensure the text is clear and readable
                </li>
                <li className={styles.tip}>
                  <CircleCheck aria-hidden className={styles.tipIcon} />
                  Avoid glare or shadows on the document
                </li>
              </ul>
            </>
          )}
        </div>
      </Sheet>
    </div>
  );
}

/** Submitted / verified / rejected: status instead of the upload zone. */
function AnsweredPanel({ view }: { view: IdVerificationView }) {
  const copy =
    view.status === 'verified'
      ? {
          title: 'Your ID is verified',
          body: 'You are all set; nothing more to do here.',
        }
      : view.status === 'rejected'
        ? {
            title: 'Your ID needs another look',
            body:
              view.note ??
              'Our staff could not verify your ID. You can submit a new photo from your account.',
          }
        : {
            title: 'Your ID is under review',
            body: 'Our staff will verify it shortly. You can start using Club70 in the meantime.',
          };

  return (
    <div className={styles.statusPanel} role="status">
      <span className={styles.statusIcon} aria-hidden>
        <BadgeCheck />
      </span>
      <p className={styles.statusTitle}>{copy.title}</p>
      <p className={styles.statusBody}>{copy.body}</p>
    </div>
  );
}
