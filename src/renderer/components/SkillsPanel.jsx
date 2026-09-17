import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../i18n.js";
import { ScanIcon, SparkIcon } from "./Icons.jsx";
import { buildSkillsList } from "../skillsList.js";
import { shortenHomeFolder } from "../paths.js";

// The **Skills** tab of the side panel: every skill on this Mac as a
// catalogue — a search field, a count, and one row per skill with its name,
// its **whole** description and where it comes from. There is no button
// anywhere in the window that opens it: the macOS **Skills** menu does, and
// nothing else.
//
// Clicking a row opens the skill's SKILL.md in the middle column, over the
// terminal, exactly as it always did; this list stays next to it, which is
// the point of it being a panel tab instead of a popover.
//
// The folder is read every time the tab is mounted, so a skill a session
// wrote a minute ago is already in it.
export default function SkillsPanel({
  skillsRoot,
  onOpenSkill,
  onScanForSkills,
  onInstallBuiltinSkill,
  skillMakerSeeding
}) {
  const { translate } = useTranslation();
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let dropped = false;
    setLoading(true);
    window.clauding
      .listSkills()
      .then((answer) => {
        if (dropped) {
          return;
        }
        setSkills(answer.skills || []);
        setLoading(false);
      })
      .catch((error) => {
        console.error("Could not read the skills folder", error);
        if (!dropped) {
          setSkills([]);
          setLoading(false);
        }
      });
    return () => {
      dropped = true;
    };
  }, [skillsRoot]);

  const list = useMemo(
    () =>
      buildSkillsList({
        skills,
        query,
        sourceOptions: {
          builtinLabel: translate("skills.sourceBuiltin"),
          pluginLabel: translate("skills.sourcePlugin")
        }
      }),
    [skills, query, skillsRoot, translate]
  );

  return (
    <div className="panel-tab-content skills-panel" data-skills-panel>
      <div className="skills-panel-toolbar">
        <input
          type="search"
          className="skills-panel-search"
          value={query}
          placeholder={translate("skills.searchPlaceholder")}
          spellCheck={false}
          data-skills-search
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="skills-panel-count" data-skills-count>
          {list.filtered
            ? translate("skills.countFiltered", { shown: list.shown, total: list.total })
            : translate("skills.countAll", { count: list.total })}
        </span>
      </div>
      <div className="skills-panel-list">
        {loading && <div className="skills-panel-note">{translate("skills.loading")}</div>}
        {!loading && list.total === 0 && <div className="skills-panel-note">{translate("skills.empty")}</div>}
        {!loading && list.total > 0 && list.shown === 0 && (
          <div className="skills-panel-note">{translate("skills.noMatch")}</div>
        )}
        {list.rows.map((skill) => (
          <button
            type="button"
            key={skill.filePath}
            className="skills-panel-row"
            title={translate("skills.openHint")}
            data-skill-row={skill.name}
            onClick={() => onOpenSkill(skill)}
          >
            <span className="skills-panel-name">
              {skill.name}
              {skill.builtin && <span className="skills-panel-builtin">{translate("skills.builtin")}</span>}
            </span>
            <span className="skills-panel-where">{skill.sourceLabel}</span>
            {skill.description && <span className="skills-panel-description">{skill.description}</span>}
          </button>
        ))}
      </div>
      {/* Offered only to somebody who said "not now" when the app first
          asked whether it may write its built-in skills. */}
      {skillMakerSeeding === "declined" && onInstallBuiltinSkill && (
        <button type="button" className="skills-panel-install" onClick={onInstallBuiltinSkill} data-skills-install-builtin>
          <SparkIcon />
          {translate("skills.installBuiltin")}
        </button>
      )}
      {/* The footer is links, not buttons: the window gets no new buttons,
          and these two are what the old popover had at the bottom. */}
      <div className="skills-panel-footer">
        <span className="skills-panel-root" title={skillsRoot}>
          {translate("skills.footer", { folder: shortenHomeFolder(skillsRoot), count: list.total })}
        </span>
        <span className="skills-panel-links">
          <button type="button" className="skills-panel-link" onClick={onScanForSkills} data-skills-scan-link>
            <ScanIcon />
            {translate("skills.scan")}
          </button>
          <button
            type="button"
            className="skills-panel-link"
            onClick={() => window.clauding.revealInFinder(skillsRoot)}
            data-skills-reveal
          >
            {translate("skills.reveal")}
          </button>
        </span>
      </div>
    </div>
  );
}
