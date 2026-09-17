import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { EXTRA_FLAGS_PLACEHOLDER, checkExtraArguments, mergeExtraArguments } from "../../../electron/lib/extraFlags.js";
import { handlePlaceholderKey } from "../placeholderAccept.js";
import { CANCEL, SAVE_AND_RESTART, SAVE_ONLY } from "../sessionFlagsPlan.js";

// "Extra claude flags…" for a conversation that already exists. The flags of
// a session used to be typeable only in the "+ New" sheet, before it had
// started — so a running conversation could not be given a Telegram channel
// without starting a second one. This dialog is that missing half: the
// session's own line of session-flags.json, and the one button that makes
// it take effect now (a restart is the only way — the command line of a
// `claude` that is already running cannot be changed).
//
// `request` is { sessionId, sessionTitle, flags, globalFlags, agentFlags,
//                hasOpenTerminal }:
//   flags            what session-flags.json holds for this session now
//   globalFlags      settings.json, the first level
//   agentFlags       the agent this session is assigned to, the second level
//   hasOpenTerminal  the session is running in one of the app's terminals,
//                    so there is something to restart; otherwise the flags
//                    can only be saved and wait for the next resume here
export default function SessionFlagsDialog({ request, onChoose }) {
  const { translate } = useTranslation();
  const [draft, setDraft] = useState(request.flags || "");
  const [problem, setProblem] = useState("");
  const fieldRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    if (fieldRef.current) {
      fieldRef.current.focus();
      fieldRef.current.select();
    }
  }, []);

  // Escape is Cancel, and so is a click next to the dialog: both are the
  // answer "I did not want this", and neither writes anything.
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onChoose(CANCEL, "");
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onChoose]);

  function handleBackdropMouseDown(event) {
    if (dialogRef.current && !dialogRef.current.contains(event.target)) {
      onChoose(CANCEL, "");
    }
  }

  // Answering with a flag the app sets itself changes nothing: the line
  // under the field says which one and the dialog stays open.
  function answer(choice) {
    const checked = checkExtraArguments(draft);
    if (checked.reserved.length > 0) {
      setProblem(checked.message);
      return;
    }
    onChoose(choice, draft.trim());
  }

  const title = translate("flags.sessionTitle", { title: request.sessionTitle || "" });
  // The whole command line as it would be composed for the next `claude`:
  // the global flags, then the agent's, then the ones in the field. Exactly
  // the merge the main process does, so this line is not a guess.
  const effective = mergeExtraArguments([request.globalFlags || "", request.agentFlags || "", draft]).join(" ");

  return (
    <div className="sheet-backdrop" data-session-flags-dialog onMouseDown={handleBackdropMouseDown}>
      <div className="sheet assign-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-title assign-dialog-title">{title}</div>
        <input
          type="text"
          className="settings-input"
          value={draft}
          placeholder={EXTRA_FLAGS_PLACEHOLDER}
          spellCheck={false}
          ref={fieldRef}
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem("");
          }}
          onKeyDown={(event) => {
            const used = handlePlaceholderKey(event, EXTRA_FLAGS_PLACEHOLDER, (value) => {
              setDraft(value);
              setProblem("");
            });
            if (used) {
              return;
            }
            if (event.key === "Enter") {
              answer(request.hasOpenTerminal ? SAVE_AND_RESTART : SAVE_ONLY);
            }
          }}
          data-session-flags-input
        />
        <div className="sheet-hint" data-session-flags-effective>
          {`${translate("flags.effective")}: ${effective || translate("flags.none")}`}
        </div>
        {problem && (
          <div className="sheet-hint is-problem" data-session-flags-problem>
            {problem}
          </div>
        )}
        <div className="sheet-hint">{translate("flags.tabHint")}</div>
        <p className="sheet-hint assign-dialog-text">
          {request.hasOpenTerminal ? translate("flags.sessionRestartText") : translate("flags.sessionResumeText")}
        </p>
        <div className="sheet-actions">
          <button type="button" className="button is-ghost" data-session-flags-cancel onClick={() => onChoose(CANCEL, "")}>
            {translate("agents.assignCancel")}
          </button>
          {request.hasOpenTerminal ? (
            <>
              <button
                type="button"
                className="button is-secondary"
                data-session-flags-save-only
                onClick={() => answer(SAVE_ONLY)}
              >
                {translate("flags.saveOnly")}
              </button>
              <button
                type="button"
                className="button is-primary"
                data-session-flags-save-restart
                onClick={() => answer(SAVE_AND_RESTART)}
              >
                {translate("flags.saveAndRestart")}
              </button>
            </>
          ) : (
            <button type="button" className="button is-primary" data-session-flags-save onClick={() => answer(SAVE_ONLY)}>
              {translate("flags.saveOnly")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
