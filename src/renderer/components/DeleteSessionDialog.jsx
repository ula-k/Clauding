import { useEffect, useRef } from "react";
import { useTranslation } from "../i18n.js";

// The one destructive confirmation in the app: the transcript itself goes.
// Same shape as the assign dialog — Escape and a click next to it are
// Cancel, and nothing happens until Delete is pressed. Cancel keeps the
// focus, so the dangerous button is never the one under the fingers by
// accident: Delete has to be aimed at.
export default function DeleteSessionDialog({ sessionTitle, onConfirm, onCancel }) {
  const { translate } = useTranslation();
  const cancelButtonRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    if (cancelButtonRef.current) {
      cancelButtonRef.current.focus();
    }
  }, []);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div
      className="sheet-backdrop"
      data-delete-session-dialog
      onMouseDown={(event) => {
        if (dialogRef.current && !dialogRef.current.contains(event.target)) {
          onCancel();
        }
      }}
    >
      <div
        className="sheet assign-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={translate("row.deleteTitle")}
      >
        <div className="sheet-title assign-dialog-title">{translate("row.deleteTitle")}</div>
        {sessionTitle && <div className="delete-dialog-session">{sessionTitle}</div>}
        <p className="sheet-hint assign-dialog-text">{translate("row.deleteText")}</p>
        <div className="sheet-actions">
          <button type="button" className="button is-ghost" ref={cancelButtonRef} data-delete-cancel onClick={onCancel}>
            {translate("agents.assignCancel")}
          </button>
          <button type="button" className="button is-danger" data-delete-confirm onClick={onConfirm}>
            {translate("row.deleteConfirmButton")}
          </button>
        </div>
      </div>
    </div>
  );
}
