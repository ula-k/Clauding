import { useTranslation } from "../i18n.js";
import { GearIcon, SparkIcon } from "./Icons.jsx";

// The first thing a new copy of Clauding shows (settings.showFirstRun): the
// whole window, two choices. "Set up with an agent" starts the built-in
// setup agent in a terminal — it looks at this machine, asks what it cannot
// find, shows a summary and only then writes anything, through the
// `clauding` command. "I'll set it up myself" opens Settings and marks the
// question answered. Clauding ▸ Run setup agent… starts the agent again at
// any time.
export default function FirstRunSheet({ onSetUpWithAgent, onSetUpMyself }) {
  const { translate } = useTranslation();
  return (
    <div className="first-run" data-first-run>
      <div className="first-run-card">
        <div className="first-run-title">{translate("firstRun.title")}</div>
        <p className="first-run-text">{translate("firstRun.text")}</p>
        <div className="first-run-choices">
          <button type="button" className="first-run-choice is-primary" onClick={onSetUpWithAgent} data-first-run-agent>
            <span className="first-run-choice-icon">
              <SparkIcon />
            </span>
            <span className="first-run-choice-body">
              <span className="first-run-choice-title">
                {translate("firstRun.agent")}
                <span className="first-run-badge">{translate("firstRun.recommended")}</span>
              </span>
              <span className="first-run-choice-text">{translate("firstRun.agentText")}</span>
            </span>
          </button>
          <button type="button" className="first-run-choice" onClick={onSetUpMyself} data-first-run-myself>
            <span className="first-run-choice-icon">
              <GearIcon />
            </span>
            <span className="first-run-choice-body">
              <span className="first-run-choice-title">{translate("firstRun.myself")}</span>
              <span className="first-run-choice-text">{translate("firstRun.myselfText")}</span>
            </span>
          </button>
        </div>
        <p className="first-run-note">{translate("firstRun.note")}</p>
      </div>
    </div>
  );
}
