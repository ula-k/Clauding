import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n.js";
import { FolderIcon } from "./Icons.jsx";
import EmojiPicker from "./EmojiPicker.jsx";
import { firstGrapheme } from "../emojiChoices.js";
import {
  AGENT_COLOR_TOKENS,
  DEFAULT_AGENT_COLOR,
  DEFAULT_AGENT_EMOJI,
  definitionFolderLabel,
  fileNameOf
} from "../agentConstants.js";

// The form behind "+ Add agent" and the row menu's "Edit": a name, an emoji,
// one of the eight palette colours, the folder the definition is read from
// and which .md file inside it is the definition.
//
// The folder comes first in practice: picking it fills the file select, and
// the file fills the name and the emoji, so in the normal case the user picks a
// folder and presses Save.
// `initialFolder` is an inspection of a definition folder (the same shape
// "Choose folder…" answers with): the form opens already filled in. That is
// what "Add as agent" on a freshly written definition uses, so the user only
// presses Save.
export default function AgentForm({ agent, initialFolder = null, onSave, onClose }) {
  const { translate } = useTranslation();
  const prefill = agent ? null : initialFolder;
  const [name, setName] = useState(agent ? agent.name : (prefill && prefill.name) || "");
  const [emoji, setEmoji] = useState(agent ? agent.emoji : (prefill && prefill.emoji) || DEFAULT_AGENT_EMOJI);
  const [color, setColor] = useState(agent ? agent.color : DEFAULT_AGENT_COLOR);
  const [definitionFolder, setDefinitionFolder] = useState(
    agent ? agent.definitionFolder : (prefill && prefill.definitionFolder) || ""
  );
  const [definitionFile, setDefinitionFile] = useState(
    agent ? agent.definitionFile : (prefill && prefill.definitionFile) || ""
  );
  const [markdownFiles, setMarkdownFiles] = useState(prefill ? prefill.markdownFiles || [] : []);
  // The name the definition file suggested. Only a name the user has not touched
  // is replaced when another file is picked.
  const [suggestedName, setSuggestedName] = useState(agent ? agent.name : (prefill && prefill.name) || "");
  // The built-in emoji list under the field (the fallback for the native panel).
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const formRef = useRef(null);
  // The emoji field, its two buttons and the popover: a click in here must
  // not count as a click outside the popover.
  const emojiAreaRef = useRef(null);
  const emojiInputRef = useRef(null);

  // Editing an existing agent: the file select needs the folder's .md files.
  useEffect(() => {
    if (!agent || !agent.definitionFolder) {
      return;
    }
    window.clauding.inspectAgentFolder(agent.definitionFolder).then((inspection) => {
      setMarkdownFiles(inspection.markdownFiles);
    });
  }, [agent]);

  // Escape and a click outside close the emoji popover first, and only the
  // whole form when the popover is already shut.
  useEffect(() => {
    function handleMouseDown(event) {
      if (formRef.current && !formRef.current.contains(event.target)) {
        onClose();
        return;
      }
      if (emojiPickerOpen && emojiAreaRef.current && !emojiAreaRef.current.contains(event.target)) {
        setEmojiPickerOpen(false);
      }
    }
    function handleKeyDown(event) {
      if (event.key !== "Escape") {
        return;
      }
      if (emojiPickerOpen) {
        setEmojiPickerOpen(false);
        return;
      }
      onClose();
    }
    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, emojiPickerOpen]);

  async function pickFolder() {
    const inspection = await window.clauding.pickAgentFolder();
    if (!inspection) {
      return;
    }
    setDefinitionFolder(inspection.definitionFolder);
    setMarkdownFiles(inspection.markdownFiles);
    setDefinitionFile(inspection.definitionFile);
    changeEmoji(inspection.emoji);
    setSuggestedName(inspection.name);
    if (!name.trim() || name === suggestedName) {
      setName(inspection.name);
    }
  }

  async function chooseFile(fileName) {
    const filePath = `${definitionFolder}/${fileName}`;
    setDefinitionFile(filePath);
    const inspection = await window.clauding.inspectAgentFile(filePath);
    changeEmoji(inspection.emoji);
    setSuggestedName(inspection.name);
    if (!name.trim() || name === suggestedName) {
      setName(inspection.name);
    }
  }

  // Whatever arrives in the field — typed, pasted, or dropped in by the
  // native panel — only its first whole emoji is kept, so "✅ Test" becomes
  // "✅" and "🧑‍💻" stays one character. An empty field is allowed while
  // editing; the default emoji is put back when the agent is saved.
  function changeEmoji(text) {
    setEmoji(firstGrapheme(text));
  }

  // The macOS emoji panel (⌃⌘Space) types into whatever has focus, so the
  // field is focused first and the main process opens the panel.
  async function openNativeEmojiPanel() {
    setEmojiPickerOpen(false);
    if (emojiInputRef.current) {
      emojiInputRef.current.focus();
    }
    await window.clauding.showEmojiPanel();
  }

  function pickEmojiFromList(chosen) {
    changeEmoji(chosen);
    setEmojiPickerOpen(false);
    if (emojiInputRef.current) {
      emojiInputRef.current.focus();
    }
  }

  const canSave = Boolean(name.trim() && definitionFolder && definitionFile);

  function save() {
    if (!canSave) {
      return;
    }
    onSave({
      name: name.trim(),
      emoji: emoji || DEFAULT_AGENT_EMOJI,
      color,
      definitionFolder,
      definitionFile
    });
  }

  return (
    <div className="agent-form" ref={formRef} data-agent-form>
      <div className="sheet-title">{translate(agent ? "agents.editTitle" : "agents.addTitle")}</div>

      <label className="sheet-label" htmlFor="agent-form-name">
        {translate("agents.name")}
      </label>
      <input
        id="agent-form-name"
        type="text"
        className="agent-form-input"
        value={name}
        autoFocus
        placeholder={translate("agents.namePlaceholder")}
        onChange={(event) => setName(event.target.value)}
        data-agent-name-input
      />

      <label className="sheet-label" htmlFor="agent-form-emoji">
        {translate("agents.emoji")}
      </label>
      {/* No maxLength on the field: a limit of 1 cuts an emoji in half (they
          are two or more code units). The first whole emoji is taken on
          change instead. */}
      <div className="agent-emoji-area" ref={emojiAreaRef}>
        <div className="agent-emoji-row">
          <input
            id="agent-form-emoji"
            ref={emojiInputRef}
            type="text"
            className="agent-form-input is-emoji"
            value={emoji}
            placeholder={DEFAULT_AGENT_EMOJI}
            onChange={(event) => changeEmoji(event.target.value)}
            data-agent-emoji-input
          />
          <button
            type="button"
            className="emoji-tool-button"
            title={translate("agents.emojiPanel")}
            aria-label={translate("agents.emojiPanel")}
            onClick={openNativeEmojiPanel}
            data-agent-emoji-panel
          >
            <span aria-hidden="true">🙂</span>
          </button>
          <button
            type="button"
            className={emojiPickerOpen ? "emoji-tool-button is-open" : "emoji-tool-button"}
            title={translate("agents.emojiList")}
            aria-label={translate("agents.emojiList")}
            aria-expanded={emojiPickerOpen}
            onClick={() => setEmojiPickerOpen(!emojiPickerOpen)}
            data-agent-emoji-list
          >
            <span aria-hidden="true">▦</span>
          </button>
        </div>
        <div className="agent-form-hint">{translate("agents.emojiHint")}</div>
        {emojiPickerOpen && <EmojiPicker onPick={pickEmojiFromList} />}
      </div>

      <span className="sheet-label">{translate("agents.color")}</span>
      <div className="agent-swatches">
        {AGENT_COLOR_TOKENS.map((token) => (
          <button
            type="button"
            key={token}
            className={token === color ? "agent-swatch is-selected" : "agent-swatch"}
            style={{ "--agent-color": `var(${token})` }}
            aria-label={token}
            data-agent-swatch={token}
            onClick={() => setColor(token)}
          />
        ))}
      </div>

      <span className="sheet-label">{translate("agents.definitionFolder")}</span>
      <button
        type="button"
        className="agent-folder-button"
        title={definitionFolder}
        onClick={pickFolder}
        data-agent-pick-folder
      >
        <FolderIcon />
        <span>{definitionFolder ? definitionFolderLabel(definitionFolder) : translate("agents.pickFolder")}</span>
      </button>
      <div className="agent-form-hint">{translate("agents.definitionFolderHint")}</div>

      <label className="sheet-label" htmlFor="agent-form-file">
        {translate("agents.definitionFile")}
      </label>
      <select
        id="agent-form-file"
        className="agent-form-select"
        value={fileNameOf(definitionFile)}
        disabled={markdownFiles.length === 0}
        onChange={(event) => chooseFile(event.target.value)}
        data-agent-file-select
      >
        {markdownFiles.length === 0 && <option value="">{translate("agents.noMarkdown")}</option>}
        {markdownFiles.map((fileName) => (
          <option key={fileName} value={fileName}>
            {fileName}
          </option>
        ))}
      </select>

      <div className="sheet-actions">
        <button type="button" className="button is-ghost" onClick={onClose}>
          {translate("terminal.cancel")}
        </button>
        <button type="button" className="button is-primary" disabled={!canSave} onClick={save} data-agent-save>
          {translate("agents.save")}
        </button>
      </div>
    </div>
  );
}
