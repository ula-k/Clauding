import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { playSoftChime } from "../softChime.js";

// The window's half of "a session finished": the Clauding mod reported that a
// session the user is not looking at finished, asked a question or waits
// for a permission (electron/modBridge.js decides who earns one), and a small
// card says so in the top-right corner. A click opens that session; it goes
// away by itself after a while. The macOS notification sent alongside it
// opens the same session (onModNoticeOpen).

const TOAST_LIFETIME_MILLISECONDS = 9000;
const MAXIMUM_TOASTS = 4;
const TEXT_KEYS = {
  finished: "modNotice.finished",
  needsAnswer: "modNotice.needsAnswer",
  needsPermission: "modNotice.needsPermission"
};

export default function ModToasts({ titleForSession, onOpen }) {
  const { translate } = useTranslation();
  const [toasts, setToasts] = useState([]);
  const counterRef = useRef(0);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  function dismiss(toastId) {
    setToasts((current) => current.filter((toast) => toast.toastId !== toastId));
  }

  useEffect(() => {
    // A window built before the mod existed, talking to an older main
    // process, simply shows no toasts.
    if (typeof window.clauding.onModNotice !== "function") {
      return undefined;
    }
    const stopNotices = window.clauding.onModNotice((notice) => {
      counterRef.current += 1;
      const toastId = counterRef.current;
      setToasts((current) =>
        current
          .filter((toast) => toast.terminalId !== notice.terminalId)
          .concat([{ ...notice, toastId }])
          .slice(-MAXIMUM_TOASTS)
      );
      setTimeout(() => dismiss(toastId), TOAST_LIFETIME_MILLISECONDS);
      if (notice.sound) {
        playSoftChime();
      }
    });
    const stopOpens = window.clauding.onModNoticeOpen((request) => {
      openRef.current({ terminalId: request.terminalId, sessionId: null });
    });
    return () => {
      stopNotices();
      stopOpens();
    };
  }, []);

  if (toasts.length === 0) {
    return null;
  }
  return (
    <div className="mod-toasts" data-mod-toasts>
      {toasts.map((toast) => {
        const title = (toast.sessionId && titleForSession(toast.sessionId)) || toast.title || translate("modNotice.untitled");
        return (
          <div key={toast.toastId} className={`mod-toast is-${toast.kind}`} data-mod-toast={toast.kind}>
            <button
              type="button"
              className="mod-toast-body"
              onClick={() => {
                dismiss(toast.toastId);
                onOpen({ terminalId: toast.terminalId, sessionId: toast.sessionId });
              }}
            >
              <span className="mod-toast-dot" />
              <span className="mod-toast-text">{translate(TEXT_KEYS[toast.kind] || TEXT_KEYS.finished, { title })}</span>
              <span className="mod-toast-open">{translate("modNotice.open")}</span>
            </button>
            <button
              type="button"
              className="mod-toast-close"
              aria-label={translate("modNotice.dismiss")}
              title={translate("modNotice.dismiss")}
              onClick={() => dismiss(toast.toastId)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
