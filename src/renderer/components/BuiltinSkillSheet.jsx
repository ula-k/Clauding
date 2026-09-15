import { useTranslation } from "../i18n.js";
import { SparkIcon } from "./Icons.jsx";

// The names of the skills the app ships with; they mirror
// BUILTIN_SKILL_NAMES in electron/skills.js, which is what actually gets
// written.
const BUILTIN_SKILL_NAMES = ["skill-maker", "clauding-agents"];

// Asked once, on the very first start. Clauding reads a great deal under
// ~/.claude and writes only these two things there: its built-in skills,
// which have to sit in the folder Claude Code loads skills from or they
// cannot be loaded at all. Writing into someone's own configuration folder
// without saying so is not something an app should do quietly, so this asks
// — and the answer is remembered in settings.json.
export default function BuiltinSkillSheet({ skillsRoot, onAnswer }) {
  const { translate } = useTranslation();
  return (
    <div className="sheet-backdrop" data-builtin-skill-sheet>
      <div className="sheet">
        <div className="sheet-title">
          <SparkIcon />
          {translate("builtinSkill.title")}
        </div>
        <p className="sheet-hint">{translate("builtinSkill.text")}</p>
        {BUILTIN_SKILL_NAMES.map((skillName) => (
          <div className="sheet-path" key={skillName}>
            {`${String(skillsRoot || "").replace(/^\/Users\/[^/]+/, "~")}/${skillName}/SKILL.md`}
          </div>
        ))}
        <div className="sheet-actions">
          <button type="button" className="button is-ghost" onClick={() => onAnswer(false)} data-builtin-skill-decline>
            {translate("builtinSkill.notNow")}
          </button>
          <button type="button" className="button is-primary" onClick={() => onAnswer(true)} data-builtin-skill-install>
            {translate("builtinSkill.install")}
          </button>
        </div>
      </div>
    </div>
  );
}
