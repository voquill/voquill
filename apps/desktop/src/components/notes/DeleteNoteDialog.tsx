import { FormattedMessage } from "react-intl";
import { showErrorSnackbar } from "../../actions/app.actions";
import { deleteNote } from "../../actions/note.actions";
import { useAppStore } from "../../store";
import { ConfirmDialog } from "../common/ConfirmDialog";

export const DeleteNoteDialog = ({
  noteId,
  onClose,
  onDeleted,
}: {
  noteId: string | null;
  onClose: () => void;
  onDeleted?: () => void;
}) => {
  const isRecording = useAppStore((state) => {
    const status = noteId ? state.noteById[noteId]?.status : null;
    return status === "recording" || status === "paused";
  });

  const handleConfirm = () => {
    onClose();
    if (!noteId) return;
    onDeleted?.();
    deleteNote(noteId).catch(showErrorSnackbar);
  };

  return (
    <ConfirmDialog
      isOpen={noteId !== null}
      title={<FormattedMessage defaultMessage="Delete note?" />}
      content={
        isRecording ? (
          <FormattedMessage defaultMessage="Recording stops and the note, its transcript and its audio are permanently deleted." />
        ) : (
          <FormattedMessage defaultMessage="The note, its transcript and any audio still stored for it will be permanently deleted." />
        )
      }
      confirmLabel={<FormattedMessage defaultMessage="Delete" />}
      confirmButtonProps={{ color: "error" }}
      onCancel={onClose}
      onConfirm={handleConfirm}
    />
  );
};
