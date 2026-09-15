import { useEffect, useRef } from "react";
import { attachInstance, detachInstance, fitInstance, focusInstance } from "../terminalInstances.js";

// The visible terminal: a host box the xterm wrapper is moved into. Fits the
// terminal to the box whenever the box changes size and focuses it on show.
export default function TerminalPane({ terminalId }) {
  const hostRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !terminalId) {
      return undefined;
    }
    attachInstance(terminalId, host);
    let fitTimer = null;
    const observer = new ResizeObserver(() => {
      if (fitTimer) {
        clearTimeout(fitTimer);
      }
      fitTimer = setTimeout(() => {
        fitTimer = null;
        fitInstance(terminalId);
      }, 40);
    });
    observer.observe(host);
    // Fonts may finish loading after the first fit; fit once more shortly after.
    const lateFit = setTimeout(() => {
      fitInstance(terminalId);
      focusInstance(terminalId);
    }, 120);
    return () => {
      observer.disconnect();
      clearTimeout(lateFit);
      if (fitTimer) {
        clearTimeout(fitTimer);
      }
      detachInstance(terminalId);
    };
  }, [terminalId]);

  return <div className="terminal-host" ref={hostRef} onMouseDown={() => focusInstance(terminalId)} />;
}
