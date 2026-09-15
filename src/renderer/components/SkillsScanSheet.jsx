import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../i18n.js";
import { FolderIcon, PlusIcon, ScanIcon } from "./Icons.jsx";

// "Scan for skills…": one main skills folder, but skills are scattered all
// over a Mac — in a project's own `.claude/skills`, in the CLI's plugins, in
// Claude Desktop's application support (several identical copies of the same
// thing), in `~/.hermes/skills`. The app looks through those places and
// shows what it found; the user decides what is actually a skill, because
// not everything that looks like one is one. Adding copies the whole folder
// into the skills folder — no symlinks, nothing overwritten without a yes.

// Where each group of candidates came from, in the order they are shown.
const SOURCE_LABELS = {
  projects: "skills.scanSourceProjects",
  plugins: "skills.scanSourcePlugins",
  "claude-desktop": "skills.scanSourceClaudeDesktop",
  hermes: "skills.scanSourceHermes",
  added: "skills.scanSourceAdded"
};

function matchesSearch(candidate, needle) {
  if (!needle) {
    return true;
  }
  const haystack = `${candidate.name} ${candidate.description} ${candidate.folder}`.toLowerCase();
  return haystack.includes(needle);
}

function shortFolder(folder) {
  return String(folder || "").replace(/^\/Users\/[^/]+/, "~");
}

export default function SkillsScanSheet({ onClose, onSkillsAdded }) {
  const { translate } = useTranslation();
  const [scan, setScan] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState([]);
  const [outcome, setOutcome] = useState(null);

  const runScan = useCallback(() => {
    setScanning(true);
    setOutcome(null);
    window.clauding
      .scanForSkills()
      .then((answer) => {
        setScan(answer);
        setPicked([]);
        setScanning(false);
      })
      .catch((error) => {
        console.error("Could not scan for skills", error);
        setScan({ candidates: [], sources: [] });
        setScanning(false);
      });
  }, []);

  useEffect(() => {
    runScan();
  }, [runScan]);

  useEffect(() => {
    function handleKey(event) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const candidates = (scan && scan.candidates) || [];
  const needle = search.trim().toLowerCase();
  const grouped = useMemo(() => {
    const bySource = new Map();
    for (const candidate of candidates) {
      if (!matchesSearch(candidate, needle)) {
        continue;
      }
      const list = bySource.get(candidate.sourceLabel) || [];
      list.push(candidate);
      bySource.set(candidate.sourceLabel, list);
    }
    return Array.from(bySource.entries());
  }, [candidates, needle]);

  function togglePick(folder) {
    setPicked((previous) =>
      previous.includes(folder) ? previous.filter((known) => known !== folder) : previous.concat([folder])
    );
  }

  async function addPicked() {
    const chosen = candidates.filter((candidate) => picked.includes(candidate.folder));
    if (chosen.length === 0) {
      return;
    }
    const first = await window.clauding.addScannedSkills(chosen, false);
    const blocked = first.results.filter((result) => result.skipped && result.reason === "exists");
    let added = first.results.filter((result) => result.copied).length;
    if (blocked.length > 0) {
      const names = blocked.map((result) => result.name).join(", ");
      if (window.confirm(translate("skills.scanOverwrite", { names }))) {
        const again = await window.clauding.addScannedSkills(
          chosen.filter((candidate) => blocked.some((result) => result.name === candidate.name)),
          true
        );
        added += again.results.filter((result) => result.copied).length;
      }
    }
    setOutcome(translate("skills.scanResult", { count: added }));
    setPicked([]);
    if (onSkillsAdded) {
      onSkillsAdded();
    }
    runScan();
  }

  return (
    <div className="sheet-backdrop" onClick={onClose} data-skills-scan-sheet>
      <div className="sheet is-wide" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-title">
          <ScanIcon />
          {translate("skills.scanTitle")}
        </div>
        <p className="sheet-hint">{translate("skills.scanHint")}</p>
        <div className="scan-controls">
          <input
            type="text"
            className="scan-search"
            value={search}
            placeholder={translate("skills.scanSearch")}
            spellCheck={false}
            onChange={(event) => setSearch(event.target.value)}
            data-skills-scan-search
          />
          <button type="button" className="button is-ghost is-small" onClick={runScan} disabled={scanning}>
            {translate("skills.scanAgain")}
          </button>
          <button
            type="button"
            className="button is-ghost is-small"
            onClick={() => window.clauding.addSkillScanRoot().then(runScan)}
            data-skills-scan-add-root
          >
            <PlusIcon />
            {translate("skills.scanAddRoot")}
          </button>
        </div>
        <div className="scan-list">
          {scanning && <div className="list-note">{translate("skills.scanRunning")}</div>}
          {!scanning && grouped.length === 0 && <div className="list-note">{translate("skills.scanEmpty")}</div>}
          {!scanning &&
            grouped.map(([sourceLabel, found]) => (
              <div className="scan-group" key={sourceLabel}>
                <div className="scan-group-name">
                  {translate(SOURCE_LABELS[sourceLabel] || "skills.scanSourceAdded")}
                  <span className="scan-group-count">{found.length}</span>
                </div>
                {found.map((candidate) => (
                  <label className="scan-row" key={candidate.folder} data-skills-scan-row={candidate.name}>
                    <input
                      type="checkbox"
                      checked={picked.includes(candidate.folder)}
                      onChange={() => togglePick(candidate.folder)}
                    />
                    <span className="scan-row-text">
                      <span className="scan-row-name">
                        {candidate.name}
                        {candidate.alreadyAdded && (
                          <span className="scan-flag">{translate("skills.scanAlreadyAdded")}</span>
                        )}
                        {candidate.differsFromInstalled && (
                          <span className="scan-flag is-warning">{translate("skills.scanDiffers")}</span>
                        )}
                        {candidate.hermesFormat && <span className="scan-flag">{translate("skills.scanHermes")}</span>}
                        {candidate.duplicatePaths && candidate.duplicatePaths.length > 0 && (
                          <span className="scan-flag is-quiet">
                            {translate("skills.scanDuplicates", { count: candidate.duplicatePaths.length })}
                          </span>
                        )}
                      </span>
                      {candidate.description && <span className="scan-row-description">{candidate.description}</span>}
                      <span className="scan-row-folder" title={candidate.folder}>
                        <FolderIcon />
                        {shortFolder(candidate.folder)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ))}
        </div>
        {outcome && <div className="scan-outcome">{outcome}</div>}
        <div className="sheet-actions">
          <button type="button" className="button is-ghost" onClick={onClose}>
            {translate("terminal.cancel")}
          </button>
          <button
            type="button"
            className="button is-primary"
            disabled={picked.length === 0}
            onClick={addPicked}
            data-skills-scan-add
          >
            {translate("skills.scanAdd", { count: picked.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
