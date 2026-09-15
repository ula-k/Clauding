import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import PopupMenu from "./PopupMenu.jsx";
import { GearIcon, ScanIcon, SparkIcon } from "./Icons.jsx";

// The two window-wide buttons in the top-right of the middle column, next to
// "Show panel": **Skills** and the settings gear. Neither belongs to a
// session — they are about the machine, not about the conversation — but
// this is the corner of the window the eye goes to, and the same Skills list
// hangs in the macOS menu bar.
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

function SettingsPopover({ anchor, settings, onPickAgentsRoot, onReveal, onClose }) {
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
    </PopupMenu>
  );
}

export default function WindowTools({
  settings,
  skillsOpen,
  onSkillsOpenChange,
  onOpenSkill,
  onScanForSkills,
  onInstallBuiltinSkill,
  skillMakerSeeding,
  onPickAgentsRoot
}) {
  const { translate } = useTranslation();
  const [skillsAnchor, setSkillsAnchor] = useState(null);
  const [settingsAnchor, setSettingsAnchor] = useState(null);
  const [skills, setSkills] = useState([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const skillsButtonRef = useRef(null);
  const settingsButtonRef = useRef(null);

  // The folder is read every time the list is opened, so a skill written a
  // minute ago by a "Harvest skills" session is already there.
  const openSkills = useCallback(() => {
    if (!skillsButtonRef.current) {
      return;
    }
    setSkillsAnchor(skillsButtonRef.current.getBoundingClientRect());
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

  return (
    <>
      <button
        type="button"
        className={skillsAnchor ? "header-tool-button is-open" : "header-tool-button"}
        ref={skillsButtonRef}
        title={translate("skills.tooltip")}
        onClick={() => (skillsAnchor ? closeSkills() : openSkills())}
        data-skills-button
      >
        <SparkIcon />
        {translate("skills.button")}
      </button>
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
          onReveal={(target) => window.clauding.revealInFinder(target)}
          onClose={() => setSettingsAnchor(null)}
        />
      )}
    </>
  );
}
