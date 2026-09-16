import { useEffect, useRef } from "react";
import { useTranslation } from "../i18n.js";
import { definitionFolderLabel } from "../agentConstants.js";
import { ASSIGN_AND_RESTART, ASSIGN_ONLY, CANCEL, REMOVE_ASSIGNMENT } from "../assignmentPlan.js";

// The question behind "Assign to agent". It is asked *before* anything is
// written: agents.json, the badge on the row and the chip in the header all
// wait for one of the positive buttons, so Cancel really does leave
// everything as it was.
//
// `request` is { agent, currentAgent, hasOpenTerminal }:
//   agent            the agent picked in the menu, or null for "No agent"
//   currentAgent     the agent the session is on now (null if none)
//   hasOpenTerminal  the session is running in one of the app's terminals,
//                    so there is something to restart and the choice is a
//                    real one; otherwise it is simply "Assign"
export default function AssignAgentDialog({ request, onChoose }) {
  const { translate } = useTranslation();
  const primaryButtonRef = useRef(null);
  const dialogRef = useRef(null);
  const removing = !request.agent;

  useEffect(() => {
    if (primaryButtonRef.current) {
      primaryButtonRef.current.focus();
    }
  }, []);

  // Escape is Cancel, and so is a click next to the dialog: both are the
  // answer "I did not want this", and neither writes anything.
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onChoose(CANCEL);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onChoose]);

  function handleBackdropMouseDown(event) {
    if (dialogRef.current && !dialogRef.current.contains(event.target)) {
      onChoose(CANCEL);
    }
  }

  const shownAgent = request.agent || request.currentAgent;
  const title = removing
    ? translate("agents.unassignTitle", {
        emoji: shownAgent ? shownAgent.emoji : "",
        name: shownAgent ? shownAgent.name : ""
      })
    : translate("agents.assignTitle", { emoji: request.agent.emoji, name: request.agent.name });
  const text = removing
    ? translate("agents.unassignText")
    : translate("agents.assignText", {
        name: request.agent.name,
        folder: definitionFolderLabel(request.agent.definitionFolder) || request.agent.definitionFolder || ""
      });

  return (
    <div className="sheet-backdrop" data-assign-dialog onMouseDown={handleBackdropMouseDown}>
      <div className="sheet assign-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label={title}>
        {/* The agent's own emoji is already in the title (and its colour on
            the line under it), so there is no second copy of it here. */}
        <div
          className="sheet-title assign-dialog-title"
          style={shownAgent ? { "--agent-color": `var(${shownAgent.color})` } : undefined}
        >
          {title}
        </div>
        <p className="sheet-hint assign-dialog-text">{text}</p>
        <div className="sheet-actions">
          <button type="button" className="button is-ghost" data-assign-cancel onClick={() => onChoose(CANCEL)}>
            {translate("agents.assignCancel")}
          </button>
          {removing ? (
            <button
              type="button"
              className="button is-danger"
              ref={primaryButtonRef}
              data-assign-remove
              onClick={() => onChoose(REMOVE_ASSIGNMENT)}
            >
              {translate("agents.unassignConfirm")}
            </button>
          ) : request.hasOpenTerminal ? (
            <>
              <button
                type="button"
                className="button is-secondary"
                data-assign-only
                onClick={() => onChoose(ASSIGN_ONLY)}
              >
                {translate("agents.assignOnly")}
              </button>
              <button
                type="button"
                className="button is-primary"
                ref={primaryButtonRef}
                data-assign-restart
                onClick={() => onChoose(ASSIGN_AND_RESTART)}
              >
                {translate("agents.assignAndRestart")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button is-primary"
              ref={primaryButtonRef}
              data-assign-confirm
              onClick={() => onChoose(ASSIGN_ONLY)}
            >
              {translate("agents.assignConfirm")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
