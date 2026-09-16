import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import PopupMenu from "./PopupMenu.jsx";
import { GearIcon, ScanIcon, SparkIcon } from "./Icons.jsx";
import { checkExtraArguments } from "../../../electron/lib/extraFlags.js";

// The one window-wide button in the top-right of the middle column, next to
// "Show panel": the settings gear. It does not belong to a session — it is
// about the machine, not about the conversation — but this is the corner of
// the window the eye goes to.
//
// Skills had a button of their own here and lost it: the list is one click
// away in the macOS **Skills** menu and at the bottom of the terminal
// header's "…", and the header is worth more to a title than to a button
// nobody presses. The popover is still opened from here, hanging off the
// gear, so both of those still have somewhere to open.
//
// Skills are shown, never edited here: a skill is written by running the
// skill-maker over a conversation ("Harvest skills"), which is a job for a
// session, not for a form.

function SkillsPopover({
  anchor,
  skillsRoot,
  skills,
  loading,
  onOpenSkill,
  onScanForSkills,
  onReveal,
  onClose,
  skillMakerSeeding,
  onInstallBuiltinSkill
}) {
  const { translate } = useTranslation();
  return (
    <PopupMenu anchor={anchor} variant="wide" onClose={onClose}>
      <div className="popup-menu-label">{translate("skills.title")}</div>
      {/* The list scrolls on its own so the folder path and "Reveal in
          Finder" stay in view however many skills there are. */}
      <div className="skill-list">
        {loading && <div className="popup-menu-note">{translate("skills.loading")}</div>}
        {!loading && skills.length === 0 && <div className="popup-menu-note">{translate("skills.empty")}</div>}
        {skills.map((skill) => (
          <button
            type="button"
            key={skill.filePath}
            className="skill-row"
            title={translate("skills.openHint")}
            data-skill-row={skill.name}
            onClick={() => {
              onOpenSkill(skill);
              onClose();
            }}
          >
            <span className="skill-row-name">
              {skill.name}
              {skill.builtin && <span className="skill-row-builtin">{translate("skills.builtin")}</span>}
            </span>
            {skill.description && <span className="skill-row-description">{skill.description}</span>}
          </button>
        ))}
      </div>
      <div className="popup-menu-separator" />
      {/* One main skills folder — but skills are scattered all over a Mac,
          and this is how the ones worth keeping get into it. */}
      <button
        type="button"
        className="skill-scan-button"
        onClick={() => {
          onClose();
          onScanForSkills();
        }}
        data-skills-scan-button
      >
        <ScanIcon />
        {translate("skills.scan")}
      </button>
      {/* Offered only to somebody who said "not now" when the app first
          asked whether it may write the built-in skill. */}
      {skillMakerSeeding === "declined" && (
        <button
          type="button"
          className="skill-scan-button"
          onClick={() => {
            onClose();
            onInstallBuiltinSkill();
          }}
          data-skills-install-builtin
        >
          <SparkIcon />
          {translate("skills.installBuiltin")}
        </button>
      )}
      <div className="skill-footer">
        <span className="skill-footer-path" title={skillsRoot}>
          {skillsRoot}
        </span>
        <button type="button" className="skill-footer-reveal" onClick={() => onReveal(skillsRoot)} data-skills-reveal>
          {translate("skills.reveal")}
        </button>
      </div>
    </PopupMenu>
  );
}

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
        placeholder="--channels plugin:telegram"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
          }
        }}
        data-settings-extra-flags
      />
      <div className="settings-hint">{translate("flags.globalHint")}</div>
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

export default function WindowTools({
  settings,
  skillsOpen,
  onSkillsOpenChange,
  settingsOpen,
  onSettingsOpenChange,
  onOpenSkill,
  onScanForSkills,
  onInstallBuiltinSkill,
  skillMakerSeeding,
  onPickAgentsRoot,
  onSaveExtraFlags
}) {
  const { translate } = useTranslation();
  const [skillsAnchor, setSkillsAnchor] = useState(null);
  const [settingsAnchor, setSettingsAnchor] = useState(null);
  const [skills, setSkills] = useState([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const settingsButtonRef = useRef(null);

  // The folder is read every time the list is opened, so a skill written a
  // minute ago by a "Harvest skills" session is already there. The list
  // hangs off the gear: the Skills button it used to hang off is gone, and
  // the gear is the one thing still standing in that corner.
  const openSkills = useCallback(() => {
    if (!settingsButtonRef.current) {
      return;
    }
    setSkillsAnchor(settingsButtonRef.current.getBoundingClientRect());
    setLoadingSkills(true);
    window.clauding
      .listSkills()
      .then((answer) => {
        setSkills(answer.skills || []);
        setLoadingSkills(false);
      })
      .catch((error) => {
        console.error("Could not read the skills folder", error);
        setSkills([]);
        setLoadingSkills(false);
      });
  }, []);

  function closeSkills() {
    setSkillsAnchor(null);
    if (onSkillsOpenChange) {
      onSkillsOpenChange(false);
    }
  }

  // The Skills item in the macOS menu bar asks for the same popover.
  useEffect(() => {
    if (skillsOpen) {
      openSkills();
    }
  }, [skillsOpen, openSkills]);

  // …and so does "Clauding → Settings…" for the gear's popover: the menu bar
  // is where new functions go, and it opens what is already in the window.
  useEffect(() => {
    if (settingsOpen && settingsButtonRef.current) {
      setSettingsAnchor(settingsButtonRef.current.getBoundingClientRect());
    }
  }, [settingsOpen]);

  return (
    <>
      <button
        type="button"
        className={settingsAnchor || skillsAnchor ? "header-tool-button is-icon is-open" : "header-tool-button is-icon"}
        ref={settingsButtonRef}
        title={translate("settings.title")}
        aria-label={translate("settings.title")}
        onClick={() => setSettingsAnchor(settingsAnchor ? null : settingsButtonRef.current.getBoundingClientRect())}
        data-settings-button
      >
        <GearIcon />
      </button>
      {skillsAnchor && (
        <SkillsPopover
          anchor={skillsAnchor}
          skillsRoot={settings.skillsRoot}
          skills={skills}
          loading={loadingSkills}
          onOpenSkill={onOpenSkill}
          onScanForSkills={onScanForSkills}
          skillMakerSeeding={skillMakerSeeding}
          onInstallBuiltinSkill={onInstallBuiltinSkill}
          onReveal={(target) => window.clauding.revealInFinder(target)}
          onClose={closeSkills}
        />
      )}
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
