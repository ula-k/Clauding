import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import PopupMenu from "./PopupMenu.jsx";
import { GearIcon } from "./Icons.jsx";
import { EXTRA_FLAGS_PLACEHOLDER, checkExtraArguments } from "../../../electron/lib/extraFlags.js";
import { handlePlaceholderKey } from "../placeholderAccept.js";

// The one window-wide button in the top-right of the middle column, next to
// "Show panel": the settings gear. It does not belong to a session — it is
// about the machine, not about the conversation — but this is the corner of
// the window the eye goes to.
//
// **Skills are not here any more.** They had a button, then a popover
// hanging off this gear, and now they have a tab of their own in the side
// panel (SkillsPanel.jsx), opened from the macOS **Skills** menu and from
// nowhere else — a list of thirty skills with their whole descriptions was
// never a popover's job. The gear is the settings, and only the settings.

// The global level of the extra `claude` flags: one field, saved when it
// loses focus or on Enter. Flags the app sets itself are refused with a line
// under the field instead of being written.
function ExtraFlagsField({ settings, onSave }) {
  const { translate } = useTranslation();
  const [draft, setDraft] = useState(settings.extraClaudeArguments || "");
  const [problem, setProblem] = useState("");

  function commit() {
    const checked = checkExtraArguments(draft);
    if (checked.reserved.length > 0) {
      setProblem(checked.message);
      return;
    }
    setProblem("");
    onSave(draft.trim());
  }

  return (
    <div className="settings-block">
      <div className="settings-name">{translate("flags.title")}</div>
      <input
        type="text"
        className="settings-input"
        value={draft}
        placeholder={EXTRA_FLAGS_PLACEHOLDER}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (handlePlaceholderKey(event, EXTRA_FLAGS_PLACEHOLDER, setDraft)) {
            return;
          }
          if (event.key === "Enter") {
            commit();
          }
        }}
        data-settings-extra-flags
      />
      <div className="settings-hint">{translate("flags.globalHint")}</div>
      <div className="settings-hint">{translate("flags.tabHint")}</div>
      {problem && (
        <div className="settings-hint is-problem" data-settings-extra-flags-problem>
          {problem}
        </div>
      )}
    </div>
  );
}

function SettingsPopover({ anchor, settings, onPickAgentsRoot, onSaveExtraFlags, onReveal, onClose }) {
  const { translate } = useTranslation();
  return (
    <PopupMenu anchor={anchor} variant="wide" onClose={onClose}>
      <div className="popup-menu-label">{translate("settings.title")}</div>
      <div className="settings-block">
        <div className="settings-name">{translate("settings.agentsRoot")}</div>
        <div className="settings-path" title={settings.agentsRoot} data-settings-agents-root>
          {settings.agentsRoot}
        </div>
        <div className="settings-hint">{translate("settings.agentsRootHint")}</div>
        <div className="settings-actions">
          <button type="button" className="button is-ghost is-small" onClick={onPickAgentsRoot} data-settings-pick-agents-root>
            {translate("settings.change")}
          </button>
          <button type="button" className="button is-ghost is-small" onClick={() => onReveal(settings.agentsRoot)}>
            {translate("skills.reveal")}
          </button>
        </div>
      </div>
      <div className="popup-menu-separator" />
      <div className="settings-block">
        <div className="settings-name">{translate("settings.skillsRoot")}</div>
        <div className="settings-path" title={settings.skillsRoot} data-settings-skills-root>
          {settings.skillsRoot}
        </div>
        <div className="settings-hint">{translate("settings.skillsRootHint")}</div>
        <div className="settings-actions">
          <button type="button" className="button is-ghost is-small" onClick={() => onReveal(settings.skillsRoot)}>
            {translate("skills.reveal")}
          </button>
        </div>
      </div>
      <div className="popup-menu-separator" />
      <ExtraFlagsField settings={settings} onSave={onSaveExtraFlags} />
    </PopupMenu>
  );
}

export default function WindowTools({ settings, settingsOpen, onSettingsOpenChange, onPickAgentsRoot, onSaveExtraFlags }) {
  const { translate } = useTranslation();
  const [settingsAnchor, setSettingsAnchor] = useState(null);
  const settingsButtonRef = useRef(null);

  // "Clauding → Settings…" in the menu bar opens the gear's popover: the
  // menu bar is where new functions go, and it opens what is already in the
  // window.
  useEffect(() => {
    if (settingsOpen && settingsButtonRef.current) {
      setSettingsAnchor(settingsButtonRef.current.getBoundingClientRect());
    }
  }, [settingsOpen]);

  return (
    <>
      <button
        type="button"
        className={settingsAnchor ? "header-tool-button is-icon is-open" : "header-tool-button is-icon"}
        ref={settingsButtonRef}
        title={translate("settings.title")}
        aria-label={translate("settings.title")}
        onClick={() => setSettingsAnchor(settingsAnchor ? null : settingsButtonRef.current.getBoundingClientRect())}
        data-settings-button
      >
        <GearIcon />
      </button>
      {settingsAnchor && (
        <SettingsPopover
          anchor={settingsAnchor}
          settings={settings}
          onPickAgentsRoot={() => {
            setSettingsAnchor(null);
            onPickAgentsRoot();
          }}
          onSaveExtraFlags={onSaveExtraFlags}
          onReveal={(target) => window.clauding.revealInFinder(target)}
          onClose={() => {
            setSettingsAnchor(null);
            if (onSettingsOpenChange) {
              onSettingsOpenChange(false);
            }
          }}
        />
      )}
    </>
  );
}
