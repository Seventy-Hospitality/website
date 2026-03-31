import { useState } from 'react';
import { Button, TextArea } from 'octahedron';
import { api } from '../lib/api';
import styles from './NotesList.module.css';

interface Note {
  id: string;
  content: string;
  authorId: string;
  createdAt: string;
}

export function NotesList({ memberId, initialNotes, onNoteAdded }: { memberId: string; initialNotes: Note[]; onNoteAdded?: () => void }) {
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    if (!content.trim()) return;
    setSaving(true);
    try {
      await api.addNote(memberId, content);
      setContent('');
      onNoteAdded?.();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.container}>
      <h3 className={styles.title}>Notes</h3>

      <div className={styles.addNote}>
        <TextArea
          value={content}
          onValueChange={setContent}
          placeholder="Add a note..."
        />
        <Button
          color="primary"
          variant="soft"
          onClick={handleSubmit}
          loading={saving}
          disabled={!content.trim()}
        >
          Add Note
        </Button>
      </div>

      {initialNotes.length === 0 ? (
        <p className={styles.empty}>No notes yet</p>
      ) : (
        <div className={styles.notes}>
          {initialNotes.map((note) => (
            <div key={note.id} className={styles.note}>
              <p className={styles.noteContent}>{note.content}</p>
              <span className={styles.noteMeta}>
                {new Date(note.createdAt).toLocaleDateString()} at{' '}
                {new Date(note.createdAt).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
