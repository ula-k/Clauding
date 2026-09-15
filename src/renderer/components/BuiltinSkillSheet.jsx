import { useTranslation } from "../i18n.js";
import { SparkIcon } from "./Icons.jsx";

// Asked once, on the very first start. Clauding reads a great deal under
// ~/.claude and writes one single thing there: the built-in skill-maker
// skill, which has to sit in the folder Claude Code loads skills from or it
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
        <div className="sheet-path">{String(skillsRoot || "").replace(/^\/Users\/[^/]+/, "~")}/skill-maker/SKILL.md</div>
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
