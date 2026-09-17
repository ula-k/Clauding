import { useEffect, useRef, useState } from "react";
import { attachInstance, detachInstance, fitInstance, focusInstance, pasteIntoInstance } from "../terminalInstances.js";

// The paths of the files a drag carries. Electron 32 took `File.path` away,
// so the preload script is the one that can answer (webUtils).
function droppedFilePaths(dataTransfer) {
  const files = dataTransfer && dataTransfer.files ? Array.from(dataTransfer.files) : [];
  return files.map((file) => window.clauding.filePathForDroppedFile(file)).filter(Boolean);
}

// The visible terminal: a host box the xterm wrapper is moved into. Fits the
// terminal to the box whenever the box changes size and focuses it on show.
//
// A file dropped on the box has its path typed into the terminal — the same
// thing ⌘V does with a file on the clipboard (electron/pasteSmart.js), and
// the same thing dragging a file into Terminal.app does. Dropped text is
// pasted as text. `data-terminal-id` is how the main process finds out which
// terminal the keyboard is in when ⌘V arrives through the Edit menu.
export default function TerminalPane({ terminalId }) {
  const hostRef = useRef(null);
  const [dropTarget, setDropTarget] = useState(false);

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

  function handleDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dropTarget) {
      setDropTarget(true);
    }
  }

  // Dragging over xterm's own elements fires a leave for the box itself, so
  // the highlight only goes away when the pointer really left the pane.
  function handleDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setDropTarget(false);
    }
  }

  function handleDrop(event) {
    event.preventDefault();
    setDropTarget(false);
    const filePaths = droppedFilePaths(event.dataTransfer);
    focusInstance(terminalId);
    if (filePaths.length > 0) {
      window.clauding.pasteSmartIntoTerminal(terminalId, filePaths).catch((error) => {
        console.error("Could not type the dropped path", error);
      });
      return;
    }
    pasteIntoInstance(terminalId, event.dataTransfer.getData("text"));
  }

  return (
    <div
      className={dropTarget ? "terminal-host drop-target" : "terminal-host"}
      data-terminal-id={terminalId}
      ref={hostRef}
      onMouseDown={() => focusInstance(terminalId)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    />
  );
}
