import { useEffect, useRef } from "react";
import { useTranslation } from "../i18n.js";

// The one destructive confirmation in the app: the transcript itself goes.
// Same shape as the assign dialog — Escape and a click next to it are
// Cancel, and nothing happens until Delete is pressed. Cancel keeps the
// focus, so the dangerous button is never the one under the fingers by
// accident: Delete has to be aimed at.
//
// One session or a whole selection, it is the same question asked once: the
// count, the first few titles, and — for a bulk delete — the sessions that
// are running somewhere outside the app and are therefore being left alone.
export default function DeleteSessionDialog({
  count = 1,
  sessionTitles = [],
  skippedTitles = [],
  onConfirm,
  onCancel
}) {
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
        aria-label={count > 1 ? translate("row.deleteManyTitle", { count }) : translate("row.deleteTitle")}
      >
        <div className="sheet-title assign-dialog-title">
          {count > 1 ? translate("row.deleteManyTitle", { count }) : translate("row.deleteTitle")}
        </div>
        {sessionTitles.map((sessionTitle) => (
          <div className="delete-dialog-session" key={sessionTitle}>
            {sessionTitle}
          </div>
        ))}
        {count > sessionTitles.length && (
          <div className="delete-dialog-more">
            {translate("row.deleteManyMore", { count: count - sessionTitles.length })}
          </div>
        )}
        <p className="sheet-hint assign-dialog-text">
          {count > 1 ? translate("row.deleteManyText") : translate("row.deleteText")}
        </p>
        {skippedTitles.length > 0 && (
          <p className="sheet-hint delete-dialog-skipped" data-delete-skipped>
            {translate("row.deleteManySkipped", { names: skippedTitles.join(", ") })}
          </p>
        )}
        <div className="sheet-actions">
          <button type="button" className="button is-ghost" ref={cancelButtonRef} data-delete-cancel onClick={onCancel}>
            {translate("agents.assignCancel")}
          </button>
          <button type="button" className="button is-danger" data-delete-confirm onClick={onConfirm}>
            {count > 1 ? translate("row.deleteManyConfirmButton", { count }) : translate("row.deleteConfirmButton")}
          </button>
        </div>
      </div>
    </div>
  );
}
