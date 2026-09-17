import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../i18n.js";
import { renderMarkdown, withoutFrontmatter } from "../markdown.js";
import { ArrowLeftIcon, FolderIcon, ReadIcon } from "./Icons.jsx";
import { parentFolderOf, shortenHomeFolder } from "../paths.js";

// The reader that takes over the middle column: a skill's SKILL.md or an
// agent's definition, shown *where the conversation is* instead of in the
// side panel. The panel can be hidden for a session, and a page that opens
// into a hidden panel looks like nothing happened at all — which is exactly
// what a click on a skill used to look like.
//
// The terminal underneath is never unmounted: MiddleColumn only hides its
// wrapper, so the pty keeps running and the scrollback is still there when
// "Back to terminal" (or Escape) brings it back.

const COPIED_FEEDBACK_MILLISECONDS = 1200;


export default function DocumentReader({ reader, onClose, onOpenInPanel, windowTools }) {
  const { translate } = useTranslation();
  const [text, setText] = useState(null);
  const [failure, setFailure] = useState(null);
  const [copied, setCopied] = useState(false);
  const folder = reader.folder || parentFolderOf(reader.filePath);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setFailure(null);
    window.clauding
      .readPanelFile(reader.filePath)
      .then((content) => {
        if (!cancelled) {
          setText(content);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setFailure(error && error.message ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reader.filePath]);

  // Escape is the way out of every other overlay in the app, so it is the
  // way out of this one too.
  useEffect(() => {
    function handleKey(event) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const html = useMemo(() => (text === null ? "" : renderMarkdown(withoutFrontmatter(text))), [text]);

  function copyFolder() {
    navigator.clipboard.writeText(folder).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_FEEDBACK_MILLISECONDS);
    });
  }

  return (
    <div className="reader" data-reader={reader.kind}>
      <header className="reader-header">
        <div className="reader-header-top">
          <span className="reader-kind">
            <ReadIcon />
            {translate(reader.kind === "agent" ? "reader.agentDefinition" : "reader.skill")}
          </span>
          <h1 className="reader-title">{reader.name}</h1>
          <button
            type="button"
            className="button is-ghost is-small"
            onClick={() => onOpenInPanel(reader)}
            data-reader-open-in-panel
          >
            {translate("reader.openInPanel")}
          </button>
          <button type="button" className="reader-back" onClick={onClose} title={translate("reader.backHint")} data-reader-back>
            <ArrowLeftIcon />
            {translate("reader.back")}
          </button>
          {windowTools}
        </div>
        {reader.description && <p className="reader-description">{reader.description}</p>}
        <button
          type="button"
          className={copied ? "reader-path is-copied" : "reader-path"}
          onClick={copyFolder}
          title={translate("reader.copyPath")}
          data-reader-path
        >
          <FolderIcon />
          {copied ? translate("reader.pathCopied") : shortenHomeFolder(folder)}
        </button>
      </header>
      <div className="reader-body panel-reading">
        {failure && <div className="panel-note is-error">{translate("panel.loadError", { message: failure })}</div>}
        {text === null && !failure && <div className="panel-note">{translate("panel.loading")}</div>}
        {text !== null && <article className="markdown" dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
    </div>
  );
}
