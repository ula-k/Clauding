import { useEffect, useRef } from "react";
import { useTranslation } from "../i18n.js";
import { CloseIcon } from "./Icons.jsx";

// "The terminal shows what it shows, but there is always the JSON file with
// everything 1:1." This is the way into it: a slim bar that slides over the
// top of the terminal pane — not a second header line, because the header is
// one line and stays one line — with the field, how many messages the word
// was found in, and ↑ / ↓ to walk them.
//
// Where the results are drawn is the side panel (SearchResults.jsx); this
// bar only asks for them and moves the marker.
//
// Enter searches when the query has changed and steps to the next hit when
// it has not; Shift+Enter steps back. Escape closes the bar.
export default function FindBar({ query, onQueryChange, onSubmit, onStep, onClose, result, currentIndex, searching }) {
  const { translate } = useTranslation();
  const inputRef = useRef(null);

  // Opening the bar puts the caret in it, and re-opening it over a query
  // that is already there selects the word so the next keystroke replaces it.
  useEffect(() => {
    const field = inputRef.current;
    if (field) {
      field.focus();
      field.select();
    }
  }, []);

  const total = result ? result.hits.length : 0;
  const askedFor = result ? result.query : null;
  const sameQuery = askedFor !== null && askedFor === query.trim();

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!sameQuery) {
        onSubmit();
      } else {
        onStep(event.shiftKey ? -1 : 1);
      }
    }
  }

  let countText = null;
  if (searching) {
    countText = translate("find.searching");
  } else if (sameQuery && total > 0) {
    countText = translate("find.position", { current: currentIndex + 1, total });
  } else if (sameQuery) {
    countText = translate("find.noMatches");
  }

  return (
    <div className="find-bar" data-find-bar>
      <input
        ref={inputRef}
        type="text"
        className="find-input"
        value={query}
        spellCheck={false}
        placeholder={translate("find.placeholder")}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        data-find-input
      />
      <span className={total === 0 && sameQuery && !searching ? "find-count is-empty" : "find-count"} data-find-count>
        {countText}
      </span>
      <button
        type="button"
        className="find-step"
        disabled={total === 0}
        title={translate("find.previous")}
        aria-label={translate("find.previous")}
        onClick={() => onStep(-1)}
        data-find-previous
      >
        ↑
      </button>
      <button
        type="button"
        className="find-step"
        disabled={total === 0}
        title={translate("find.next")}
        aria-label={translate("find.next")}
        onClick={() => onStep(1)}
        data-find-next
      >
        ↓
      </button>
      <button
        type="button"
        className="find-close"
        title={translate("find.close")}
        aria-label={translate("find.close")}
        onClick={onClose}
        data-find-close
      >
        <CloseIcon />
      </button>
    </div>
  );
}
