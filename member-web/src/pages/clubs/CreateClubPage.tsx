import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Camera, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { EMPTY_INVITE_SELECTION, type InviteSelection } from '../../lib/invites';
import { useSession } from '../../lib/session-context';
import { Button, FormField, Input, useToast } from '../../components';
import wizardStyles from '../reserve/wizard.module.css';
import { ClubMemberPicker } from './ClubMemberPicker';
import {
  canContinueClubDetails,
  CLUB_DESCRIPTION_MAX,
  CLUB_NAME_MAX,
  COVER_ACCEPT,
  coverFileError,
} from './clubs-lib';
import styles from './clubs.module.css';

type WizardStep = 1 | 2;

const STEP_NAMES: Record<WizardStep, string> = {
  1: 'Club details',
  2: 'Invite players',
};

/**
 * The 2-step create-club wizard (Figma clubs/create-club 95:4384 / 99:4980
 * and clubs/invite-players 95:4294 / 99:5498): cover photo + GROUP NAME
 * (required) + DESCRIPTION, then the invite picker for the initial
 * invitees. Full screen outside the tab shell, with the booking wizard's
 * chrome (back, close, progress segments).
 *
 * The cover is picked locally in step 1 and uploaded AFTER the club
 * exists (the upload endpoint is owner-scoped to a club id); invitees get
 * pending invitations that require acceptance, so the new club starts
 * with the creator as its only member.
 */
export function CreateClubPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { memberId } = useSession();

  const [step, setStep] = useState<WizardStep>(1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [cover, setCover] = useState<File | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [selection, setSelection] = useState<InviteSelection>(EMPTY_INVITE_SELECTION);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Step changes move focus to the heading (the wizard convention).
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  // The preview object URL lives exactly as long as the picked file.
  useEffect(() => () => {
    if (coverUrl) URL.revokeObjectURL(coverUrl);
  }, [coverUrl]);

  function pickCover(file: File | null) {
    if (!file) return;
    const error = coverFileError(file);
    if (error) {
      setCoverError(error);
      return;
    }
    setCoverError(null);
    setCover(file);
    setCoverUrl(URL.createObjectURL(file));
  }

  function removeCover() {
    setCover(null);
    setCoverUrl(null);
    setCoverError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const create = useMutation({
    mutationFn: async () => {
      const memberIds = selection.members.map((member) => member.id);
      const created = await api.createClub({
        name: name.trim(),
        description: description.trim() || undefined,
        inviteeMemberIds: memberIds.length > 0 ? memberIds : undefined,
      });
      // The cover upload is best-effort: the club exists either way, and
      // the owner can retry from Edit club.
      let coverFailed = false;
      if (cover) {
        try {
          await api.uploadClubCover(created.club.id, cover);
        } catch {
          coverFailed = true;
        }
      }
      return { ...created, coverFailed };
    },
    onSuccess: ({ club, invited, coverFailed }) => {
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
      toast({
        variant: 'success',
        message:
          invited.length > 0
            ? `${club.name} created. ${
                invited.length === 1 ? '1 invite' : `${invited.length} invites`
              } sent, pending acceptance.`
            : `${club.name} created.`,
      });
      if (coverFailed) {
        toast({
          variant: 'error',
          message: 'The cover photo could not be uploaded. You can add it from Edit club.',
        });
      }
      navigate(`/clubs/${club.id}`, { replace: true });
    },
  });

  const close = () => navigate('/clubs');
  const goBack = () => {
    if (create.isPending) return;
    if (step === 1) close();
    else setStep(1);
  };

  const createError = create.isError
    ? create.error instanceof ApiError && create.error.status === 422
      ? create.error.message
      : 'We could not create the club. Try again.'
    : null;

  return (
    <div className={wizardStyles.page}>
      <div className={wizardStyles.column}>
        <header className={wizardStyles.chrome}>
          <button
            type="button"
            className={wizardStyles.chromeButton}
            onClick={goBack}
            aria-label="Back"
            disabled={create.isPending}
          >
            <ArrowLeft aria-hidden />
          </button>
          <button
            type="button"
            className={wizardStyles.chromeButton}
            onClick={close}
            aria-label="Close club creation"
            disabled={create.isPending}
          >
            <X aria-hidden />
          </button>
        </header>

        <div
          className={wizardStyles.progress}
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={2}
          aria-valuenow={step}
          aria-valuetext={`Step ${step} of 2: ${STEP_NAMES[step]}`}
        >
          {([1, 2] as const).map((index) => (
            <span
              key={index}
              className={[
                wizardStyles.progressSegment,
                index === step ? wizardStyles.progressActive : '',
                index < step ? wizardStyles.progressDone : '',
              ].join(' ')}
            />
          ))}
        </div>

        {step === 1 ? (
          <div className={wizardStyles.step}>
            <h1 ref={headingRef} tabIndex={-1} className={wizardStyles.stepTitle}>
              Create a club
            </h1>

            <div className={styles.fieldStack}>
              {coverUrl ? (
                <div>
                  <div className={styles.coverPreviewWrap}>
                    <img className={styles.coverPreview} src={coverUrl} alt="Cover photo preview" />
                  </div>
                  <div className={styles.coverActions}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      Change photo
                    </Button>
                    <Button variant="ghost" size="sm" onClick={removeCover}>
                      Remove
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.coverPicker}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <span className={styles.coverPickerIcon} aria-hidden>
                    <Camera />
                  </span>
                  Add Cover Photo
                </button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept={COVER_ACCEPT}
                className="visually-hidden"
                aria-label="Cover photo"
                onChange={(event) => pickCover(event.target.files?.[0] ?? null)}
              />
              {coverError && (
                <p role="alert" className={wizardStyles.payAlert}>
                  {coverError}
                </p>
              )}

              <FormField label="Group name">
                {(field) => (
                  <Input
                    {...field}
                    value={name}
                    maxLength={CLUB_NAME_MAX}
                    placeholder="Enter name"
                    autoComplete="off"
                    onChange={(event) => setName(event.target.value)}
                  />
                )}
              </FormField>

              <FormField label="Description" hint="Optional">
                {(field) => (
                  <textarea
                    {...field}
                    className={styles.textarea}
                    value={description}
                    maxLength={CLUB_DESCRIPTION_MAX}
                    placeholder="Description"
                    rows={3}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                )}
              </FormField>
            </div>

            <div className={wizardStyles.stepFooter}>
              <Button
                fullWidth
                disabled={!canContinueClubDetails(name)}
                onClick={() => setStep(2)}
              >
                Continue
              </Button>
            </div>
          </div>
        ) : (
          <div className={wizardStyles.step}>
            <h1 ref={headingRef} tabIndex={-1} className={wizardStyles.stepTitle}>
              Invite players
            </h1>
            <p className={wizardStyles.stepSubtitle}>
              Invited players must accept before they join {name.trim() || 'your club'}.
            </p>

            <ClubMemberPicker
              selection={selection}
              onSelectionChange={setSelection}
              excludeMemberIds={memberId ? [memberId] : []}
            />

            {createError && (
              <p role="alert" className={wizardStyles.payAlert}>
                {createError}
              </p>
            )}

            <div className={wizardStyles.stepFooter}>
              <Button fullWidth loading={create.isPending} onClick={() => create.mutate()}>
                Create club
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
