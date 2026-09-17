import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { SESSION_COLOR_TOKENS } from "../sessionColors.js";
import { TAG_LABEL_MAX_LENGTH, cleanTagLabel } from "../sessionTags.js";

// "Manage tags…" — the one place a tag is renamed, recolored or deleted.
// Everything is in place: the label is a field that saves when it loses the
// focus or on Enter, the color is the same eight swatches as everywhere
// else, and Delete asks inside the row it belongs to, naming how many
// sessions wear the tag, because deleting one takes it off all of them.
export default function ManageTagsSheet({ tags = [], sessionTags = {}, onUpdate, onDelete, onClose }) {
  const { translate } = useTranslation();
  const [confirmingId, setConfirmingId] = useState(null);
  const sheetRef = useRef(null);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function sessionsWearing(tagId) {
    return Object.values(sessionTags || {}).filter((tagIds) => (tagIds || []).includes(tagId)).length;
  }

  return (
    <div
      className="sheet-backdrop"
      data-manage-tags-sheet
      onMouseDown={(event) => {
        if (sheetRef.current && !sheetRef.current.contains(event.target)) {
          onClose();
        }
      }}
    >
      <div className="sheet manage-tags" ref={sheetRef} role="dialog" aria-modal="true" aria-label={translate("tags.manageTitle")}>
        <div className="sheet-title">{translate("tags.manageTitle")}</div>
        {tags.length === 0 && <p className="sheet-hint">{translate("tags.none")}</p>}
        {tags.map((tag) => (
          <div className="manage-tags-row" key={tag.id} data-manage-tag={tag.id}>
            <TagLabelField tag={tag} onSave={(label) => onUpdate(tag.id, { label, color: tag.color })} />
            <div className="manage-tags-swatches">
              {SESSION_COLOR_TOKENS.map((token) => (
                <button
                  type="button"
                  key={token}
                  className={token === tag.color ? "color-swatch is-selected" : "color-swatch"}
                  style={{ "--session-color": `var(${token})` }}
                  aria-label={token}
                  title={token}
                  data-manage-tag-color={token}
                  onClick={() => onUpdate(tag.id, { label: tag.label, color: token })}
                />
              ))}
            </div>
            {confirmingId === tag.id ? (
              <div className="manage-tags-confirm">
                <span className="manage-tags-confirm-text">
                  {translate("tags.deleteConfirm", { count: sessionsWearing(tag.id) })}
                </span>
                <button type="button" className="button is-ghost" onClick={() => setConfirmingId(null)}>
                  {translate("agents.assignCancel")}
                </button>
                <button
                  type="button"
                  className="button is-danger"
                  data-manage-tag-delete-confirm
                  onClick={() => {
                    setConfirmingId(null);
                    onDelete(tag.id);
                  }}
                >
                  {translate("tags.deleteButton")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="manage-tags-delete"
                data-manage-tag-delete
                onClick={() => setConfirmingId(tag.id)}
              >
                {translate("tags.deleteButton")}
              </button>
            )}
          </div>
        ))}
        <div className="sheet-actions">
          <button type="button" className="button is-primary" data-manage-tags-done onClick={onClose}>
            {translate("tags.done")}
          </button>
        </div>
      </div>
    </div>
  );
}

// One tag's label as an editable field. It keeps its own draft so typing is
// not fighting the store on every keystroke, and writes on Enter or when it
// loses the focus — an empty field is simply not a rename.
function TagLabelField({ tag, onSave }) {
  const [draft, setDraft] = useState(tag.label);

  useEffect(() => {
    setDraft(tag.label);
  }, [tag.label]);

  function commit() {
    const label = cleanTagLabel(draft);
    if (!label) {
      setDraft(tag.label);
      return;
    }
    if (label !== tag.label) {
      onSave(label);
    }
  }

  return (
    <input
      type="text"
      className="manage-tags-label"
      value={draft}
      maxLength={TAG_LABEL_MAX_LENGTH}
      style={{ "--tag-color": `var(${tag.color})` }}
      data-manage-tag-label
      onChange={(event) => setDraft(event.target.value.slice(0, TAG_LABEL_MAX_LENGTH))}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          event.target.blur();
        }
      }}
    />
  );
}
