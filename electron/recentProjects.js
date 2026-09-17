// Recent project folders for the "+ New" sheet, read from the `projects` map
// in ~/.claude.json (the CLI keeps one entry per folder it was started in).
import fs from "node:fs";
import os from "node:os";
import { projectFolderLabel, projectColorIndex, shortenHomePath } from "./projects.js";
import { claudeRegistryPaths } from "./lib/platformPaths.js";

export function listRecentProjects() {
  let configuration = null;
  try {
    const configurationFile = claudeRegistryPaths({ homeDirectory: os.homedir() }).configurationFile;
    configuration = JSON.parse(fs.readFileSync(configurationFile, "utf8"));
  } catch (error) {
    return [];
  }
  const projects = configuration && configuration.projects && typeof configuration.projects === "object"
    ? configuration.projects
    : {};
  const rows = [];
  for (const [folderPath, record] of Object.entries(projects)) {
    if (!fs.existsSync(folderPath)) {
      continue;
    }
    const lastUsed = Math.max(
      Number(record && record.lastStartTime) || 0,
      Number(record && record.lastSessionModified) || 0
    );
    rows.push({
      path: folderPath,
      pathShort: shortenHomePath(folderPath),
      label: projectFolderLabel(folderPath),
      colorIndex: projectColorIndex(folderPath),
      lastUsed
    });
  }
  rows.sort((first, second) => second.lastUsed - first.lastUsed);
  return rows;
}
