import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Camera } from 'lucide-react';
import { api, type ClubDetail } from '../../lib/api';
import { Button, FormField, Input, Sheet, useToast } from '../../components';
import {
  canContinueClubDetails,
  CLUB_DESCRIPTION_MAX,
  CLUB_NAME_MAX,
  COVER_ACCEPT,
  coverFileError,
} from './clubs-lib';
import styles from './clubs.module.css';

export interface EditClubSheetProps {
  club: ClubDetail;
  open: boolean;
  onClose: () => void;
}

/** Marks the cover-upload half of a save failing after the PATCH landed. */
class CoverUploadFailed extends Error {}

/**
 * Owner-only club editing (name, description, cover) in a sheet on the
 * detail page. A NEW cover uploads through the multipart endpoint after
 * the PATCH; removal rides the PATCH itself (`coverImageUrl: null`), per
 * the backend's asset lifecycle. The form mounts fresh on every open so
 * it re-seeds from the current club without effect-driven state writes.
 */
export function EditClubSheet({ club, open, onClose }: EditClubSheetProps) {
  // The Sheet's Close/Escape must not interrupt an in-flight save; the
  // form reports its pending state through this ref.
  const savingRef = useRef(false);

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!savingRef.current) onClose();
      }}
      title="Edit club"
    >
      {open && <EditClubForm club={club} onClose={onClose} savingRef={savingRef} />}
    </Sheet>
  );
}

function EditClubForm({
  club,
  onClose,
  savingRef,
}: {
  club: ClubDetail;
  onClose: () => void;
  savingRef: MutableRefObject<boolean>;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [name, setName] = useState(club.name);
  const [description, setDescription] = useState(club.description ?? '');
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [removeCover, setRemoveCover] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (coverPreview) URL.revokeObjectURL(coverPreview);
  }, [coverPreview]);

  function pickCover(file: File | null) {
    if (!file) return;
    const error = coverFileError(file);
    if (error) {
      setCoverError(error);
      return;
    }
    setCoverError(null);
    setCoverFile(file);
    setCoverPreview(URL.createObjectURL(file));
    setRemoveCover(false);
  }

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const nameChanged = trimmedName !== club.name;
  const descriptionChanged = trimmedDescription !== (club.description ?? '');
  const coverRemoved = removeCover && club.coverImageUrl !== null && coverFile === null;
  const dirty = nameChanged || descriptionChanged || coverRemoved || coverFile !== null;

  const save = useMutation({
    mutationFn: async () => {
      savingRef.current = true;
      try {
        const patch: { name?: string; description?: string | null; coverImageUrl?: null } = {};
        if (nameChanged) patch.name = trimmedName;
        if (descriptionChanged) patch.description = trimmedDescription || null;
        if (coverRemoved) patch.coverImageUrl = null;
        if (Object.keys(patch).length > 0) {
          await api.updateClub(club.id, patch);
        }
        if (coverFile) {
          try {
            await api.uploadClubCover(club.id, coverFile);
          } catch {
            throw new CoverUploadFailed();
          }
        }
      } finally {
        savingRef.current = false;
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['clubs'] });
      toast({ variant: 'success', message: 'Club updated.' });
      onClose();
    },
    onError: (error) => {
      if (error instanceof CoverUploadFailed) {
        // The text edits landed; only the upload failed.
        void queryClient.invalidateQueries({ queryKey: ['clubs'] });
        toast({
          variant: 'error',
          message: 'Your changes were saved, but the cover photo could not be uploaded.',
        });
        onClose();
        return;
      }
      toast({ variant: 'error', message: 'We could not save your changes. Try again.' });
    },
  });

  const currentCover = coverPreview ?? (removeCover ? null : club.coverImageUrl);

  return (
    <div className={styles.dialogBody}>
      {currentCover ? (
        <div>
          <div className={styles.coverPreviewWrap}>
            <img className={styles.coverPreview} src={currentCover} alt="Club cover" />
          </div>
          <div className={styles.coverActions}>
            <Button
              variant="secondary"
              size="sm"
              disabled={save.isPending}
              onClick={() => fileInputRef.current?.click()}
            >
              Replace photo
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending}
              onClick={() => {
                setCoverFile(null);
                setCoverPreview(null);
                setRemoveCover(true);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            >
              Remove photo
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={styles.coverPicker}
          disabled={save.isPending}
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
        <p role="alert" className={styles.dialogHint}>
          {coverError}
        </p>
      )}

      <FormField
        label="Group name"
        error={canContinueClubDetails(name) ? undefined : 'Enter a club name'}
      >
        {(field) => (
          <Input
            {...field}
            value={name}
            maxLength={CLUB_NAME_MAX}
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
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
          />
        )}
      </FormField>

      <div className={styles.dialogActions}>
        <Button
          fullWidth
          loading={save.isPending}
          disabled={!dirty || !canContinueClubDetails(name)}
          onClick={() => save.mutate()}
        >
          Save changes
        </Button>
      </div>
    </div>
  );
}
