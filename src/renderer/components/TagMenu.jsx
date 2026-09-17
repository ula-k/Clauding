import { useState } from "react";
import { useTranslation } from "../i18n.js";
import { MenuLabel } from "./PopupMenu.jsx";
import { SESSION_COLOR_TOKENS } from "../sessionColors.js";
import { TAG_LABEL_MAX_LENGTH, cleanTagLabel } from "../sessionTags.js";

// The "Tags ▸" submenu, the same one for a single row and for a whole
// selection: the catalogue with a check on the tags the session (or every
// picked session) already wears, then "New tag…" and "Manage tags…".
//
// `tagState(tagId)` answers "all", "some" or "none" — "some" is the mixed
// state of a selection where only part of the rows wear it. `onToggle`
// answers how many sessions turned the tag down because they already wear
// three, and that count becomes the small note under the list; nothing else
// tells the user, because a refusal that says nothing looks like a bug.
export default function TagMenuItems({ tags = [], tagState, onToggle, onCreate, onManage }) {
  const { translate } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftColor, setDraftColor] = useState(SESSION_COLOR_TOKENS[0]);
  const [refusedCount, setRefusedCount] = useState(0);

  async function toggleTag(tag) {
    const state = tagState(tag.id);
    const refused = await onToggle(tag.id, state !== "all");
    setRefusedCount(Number(refused) || 0);
  }

  function saveNewTag() {
    const label = cleanTagLabel(draftLabel);
    setCreating(false);
    setDraftLabel("");
    if (label) {
      onCreate({ label, color: draftColor });
    }
  }

  return (
    <>
      <MenuLabel>{translate("tags.menu")}</MenuLabel>
      {tags.length === 0 && !creating && <div className="popup-menu-note is-item">{translate("tags.none")}</div>}
      {tags.map((tag) => {
        const state = tagState(tag.id);
        return (
          <button
            type="button"
            key={tag.id}
            className="popup-menu-item is-tag"
            data-menu-item={`tag-${tag.id}`}
            data-tag-state={state}
            onClick={() => toggleTag(tag)}
          >
            <span className="tag-pill" style={{ "--tag-color": `var(${tag.color})` }}>
              {tag.label}
            </span>
            {state === "all" && <span className="popup-menu-item-mark">✓</span>}
            {state === "some" && <span className="popup-menu-item-mark is-mixed">–</span>}
          </button>
        );
      })}
      {refusedCount > 0 && (
        <div className="popup-menu-note is-item is-warning" data-tag-limit-note>
          {translate("tags.limitNote", { count: refusedCount })}
        </div>
      )}
      {creating ? (
        <div className="tag-form" data-tag-form>
          <input
            type="text"
            className="tag-form-input"
            value={draftLabel}
            autoFocus
            maxLength={TAG_LABEL_MAX_LENGTH}
            placeholder={translate("tags.newPlaceholder")}
            data-tag-form-input
            onChange={(event) => setDraftLabel(event.target.value.slice(0, TAG_LABEL_MAX_LENGTH))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveNewTag();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setCreating(false);
                setDraftLabel("");
              }
            }}
          />
          <div className="tag-form-swatches">
            {SESSION_COLOR_TOKENS.map((token) => (
              <button
                type="button"
                key={token}
                className={token === draftColor ? "color-swatch is-selected" : "color-swatch"}
                style={{ "--session-color": `var(${token})` }}
                aria-label={token}
                title={token}
                data-tag-color={token}
                onClick={() => setDraftColor(token)}
              />
            ))}
          </div>
          <div className="tag-form-hint">{translate("tags.newHint", { count: TAG_LABEL_MAX_LENGTH })}</div>
        </div>
      ) : (
        <button
          type="button"
          className="popup-menu-item"
          data-menu-item="tag-new"
          onClick={() => {
            setRefusedCount(0);
            setCreating(true);
          }}
        >
          <span className="popup-menu-item-text">{translate("tags.new")}</span>
        </button>
      )}
      <button type="button" className="popup-menu-item" data-menu-item="tag-manage" onClick={onManage}>
        <span className="popup-menu-item-text">{translate("tags.manage")}</span>
      </button>
    </>
  );
}
