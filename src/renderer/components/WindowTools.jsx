import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import PopupMenu from "./PopupMenu.jsx";
import { GearIcon } from "./Icons.jsx";
import { EXTRA_FLAGS_PLACEHOLDER, checkExtraArguments } from "../../../electron/lib/extraFlags.js";
import { handlePlaceholderKey } from "../placeholderAccept.js";
import { DEFAULT_GUARD_PATTERNS, parseGuardPatterns } from "../../../builtin/mod/clauding-mod/hooks/commandGuard.js";

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

// The Clauding mod (builtin/mod/clauding-mod/): the overall switch, one per
// feature, and the guard's rules. Each checkbox saves at once; the rules
// save when the field loses focus. A `claude` too old for mods turns the
// whole block into one note.
const MOD_SWITCHES = [
  ["modStateReports", "mod.stateReports"],
  ["modNotifications", "mod.notifications"],
  ["modSound", "mod.sound"],
  ["modStatusLine", "mod.statusLine"],
  ["modContextBar", "mod.contextBar"],
  ["modGuard", "mod.guard"]
];

function ModSettingsBlock({ settings, onSave }) {
  const { translate } = useTranslation();
  const [patternDraft, setPatternDraft] = useState(settings.modGuardPatterns || DEFAULT_GUARD_PATTERNS);
  const support = settings.modSupport || { supported: true };
  const invalid = parseGuardPatterns(patternDraft).invalid;

  useEffect(() => {
    setPatternDraft(settings.modGuardPatterns || DEFAULT_GUARD_PATTERNS);
  }, [settings.modGuardPatterns]);

  if (!support.supported) {
    return (
      <div className="settings-block" data-settings-mod>
        <div className="settings-name">{translate("mod.title")}</div>
        <div className="settings-hint is-problem" data-settings-mod-unsupported>
          {translate("mod.unsupported", { minimum: support.minimumVersion || "", version: support.version || "?" })}
        </div>
      </div>
    );
  }
  const enabled = settings.modEnabled !== false;
  return (
    <div className="settings-block" data-settings-mod>
      <div className="settings-name">{translate("mod.title")}</div>
      <div className="settings-hint">{translate("mod.hint")}</div>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onSave({ modEnabled: event.target.checked })}
          data-settings-mod-switch="modEnabled"
        />
        <span>{translate("mod.enabled")}</span>
      </label>
      <div className={enabled ? "settings-checks" : "settings-checks is-off"}>
        {MOD_SWITCHES.map(([key, labelKey]) => (
          <label key={key} className="settings-check">
            <input
              type="checkbox"
              disabled={!enabled}
              checked={settings[key] === true}
              onChange={(event) => onSave({ [key]: event.target.checked })}
              data-settings-mod-switch={key}
            />
            <span>{translate(labelKey)}</span>
          </label>
        ))}
      </div>
      <div className="settings-name settings-subname">{translate("mod.guardPatterns")}</div>
      <textarea
        className="settings-input settings-textarea"
        rows={6}
        spellCheck={false}
        disabled={!enabled}
        value={patternDraft}
        onChange={(event) => setPatternDraft(event.target.value)}
        onBlur={() => onSave({ modGuardPatterns: patternDraft })}
        data-settings-mod-patterns
      />
      <div className="settings-hint">{translate("mod.guardPatternsHint")}</div>
      {invalid.map((problem) => (
        <div key={problem.line} className="settings-hint is-problem">
          {translate("mod.invalidPattern", { line: problem.line })}
        </div>
      ))}
      <div className="settings-actions">
        <button
          type="button"
          className="button is-ghost is-small"
          disabled={!enabled}
          onClick={() => {
            setPatternDraft(DEFAULT_GUARD_PATTERNS);
            onSave({ modGuardPatterns: "" });
          }}
        >
          {translate("mod.restoreDefaults")}
        </button>
      </div>
      <div className="settings-hint">{translate("mod.appliesToNew")}</div>
    </div>
  );
}

function SettingsPopover({ anchor, settings, onPickAgentsRoot, onSaveExtraFlags, onSaveModSettings, onReveal, onClose }) {
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
      <div className="popup-menu-separator" />
      <ModSettingsBlock settings={settings} onSave={onSaveModSettings} />
    </PopupMenu>
  );
}

export default function WindowTools({ settings, settingsOpen, onSettingsOpenChange, onPickAgentsRoot, onSaveExtraFlags, onSaveModSettings }) {
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
          onSaveModSettings={onSaveModSettings}
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
