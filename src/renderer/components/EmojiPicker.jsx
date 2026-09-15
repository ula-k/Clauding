import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { filterEmojiGroups } from "../emojiChoices.js";

// The small popover under the agent form's emoji field: a search box and the
// built-in list of emoji in five rows. It is the fallback for the native
// macOS panel — clicking one sets the field and closes the popover.
//
// Escape and clicks outside are handled by the form around it (it already
// watches the window for both), so this component only draws.
export default function EmojiPicker({ onPick }) {
  const { translate } = useTranslation();
  const [searchText, setSearchText] = useState("");
  const searchRef = useRef(null);

  useEffect(() => {
    if (searchRef.current) {
      searchRef.current.focus();
    }
  }, []);

  const groups = filterEmojiGroups(searchText);

  return (
    <div className="emoji-picker" data-emoji-picker>
      <input
        ref={searchRef}
        type="text"
        className="emoji-picker-search"
        value={searchText}
        placeholder={translate("agents.emojiSearch")}
        onChange={(event) => setSearchText(event.target.value)}
        data-emoji-search
      />
      <div className="emoji-picker-groups">
        {groups.map((group) => (
          <div className="emoji-picker-group" key={group.labelKey}>
            <div className="emoji-picker-group-label">{translate(group.labelKey)}</div>
            <div className="emoji-picker-grid">
              {group.choices.map((choice) => (
                <button
                  type="button"
                  key={choice.emoji}
                  className="emoji-picker-choice"
                  title={choice.keywords}
                  onClick={() => onPick(choice.emoji)}
                  data-emoji-choice={choice.emoji}
                >
                  {choice.emoji}
                </button>
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 && <div className="emoji-picker-empty">{translate("agents.emojiNoMatch")}</div>}
      </div>
    </div>
  );
}
