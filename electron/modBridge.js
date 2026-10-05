// The app's side of the Clauding mod (builtin/mod/clauding-mod/): whether
// the `claude` on this Mac can load it, the `--plugin-dir` every terminal the
// app starts gets, and what happens when the mod reports a state — the list
// moves (terminals.js), and a session that is not the one on screen earns a
// toast in the window and a macOS notification.
//
// The decisions are electron/lib/modState.js (pure, tested); this file only
// asks Electron, git and the CLI.
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Notification } from "electron";
import { claudeExecutablePath, spawnPlanFor } from "./claudeCli.js";
import { taskIdFromBranch } from "./lib/gitInspector.js";
import {
  MINIMUM_MOD_VERSION,
  MOD_FOLDER_PARTS,
  modArguments,
  noticeForChange,
  noticeText,
  sessionInfoResponse,
  versionSupportsMods
} from "./lib/modState.js";

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MOD_PLUGIN_DIRECTORY = path.join(projectRoot, ...MOD_FOLDER_PARTS);

export function createModBridge({
  terminals,
  readSettings,
  readPanelSelection,
  getWindow,
  sendToWindow,
  channels,
  lookUpSessionTitle,
  linkedTaskForSession,
  log = () => {}
}) {
  // `claude --version`, asked once per binary: a GUI app's PATH and the
  // configured binary decide which `claude` that is.
  let versionCheck = null;

  function modSupport() {
    const binary = claudeExecutablePath();
    if (versionCheck && versionCheck.binary === binary) {
      return versionCheck;
    }
    let version = "";
    try {
      const plan = spawnPlanFor(binary, ["--version"]);
      version = execFileSync(plan.file, plan.commandArguments, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).trim();
    } catch (error) {
      version = "";
    }
    versionCheck = {
      binary,
      version,
      supported: versionSupportsMods(version),
      minimumVersion: MINIMUM_MOD_VERSION,
      pluginDirectory: MOD_PLUGIN_DIRECTORY
    };
    log(`[mod] claude ${version || "(no version)"}: mods ${versionCheck.supported ? "supported" : `not supported (needs ${MINIMUM_MOD_VERSION})`}`);
    return versionCheck;
  }

  // What terminals.js adds to a command line (see modArguments).
  function readModPlan() {
    const settings = readSettings();
    if (!settings || settings.modEnabled === false) {
      return { pluginDirectory: MOD_PLUGIN_DIRECTORY, arguments: [] };
    }
    const support = modSupport();
    return {
      pluginDirectory: MOD_PLUGIN_DIRECTORY,
      arguments: modArguments({ settings, supported: support.supported, pluginDirectory: MOD_PLUGIN_DIRECTORY })
    };
  }

  function showWindowOn(terminalId) {
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.show();
      window.focus();
    }
    sendToWindow(channels.modNoticeOpen, { terminalId });
  }

  async function announce(kind, terminal) {
    const settings = readSettings() || {};
    let title = terminal.sessionName || "";
    if (!title && terminal.sessionId && lookUpSessionTitle) {
      try {
        title = (await lookUpSessionTitle(terminal.sessionId)) || "";
      } catch (error) {
        title = "";
      }
    }
    const text = noticeText(kind, title);
    log(`[mod] notice for ${terminal.terminalId}: ${text}`);
    sendToWindow(channels.modNotice, {
      kind,
      terminalId: terminal.terminalId,
      sessionId: terminal.sessionId || null,
      title: title || null,
      text,
      sound: settings.modSound === true
    });
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: "Clauding",
        body: text,
        // The window plays its own soft sound when the setting is on; the
        // system's alert sound never.
        silent: true
      });
      notification.on("click", () => showWindowOn(terminal.terminalId));
      notification.show();
    }
  }

  // `clauding state <terminal> <state> [detail]`.
  function reportState(terminalId, report) {
    const applied = terminals().reportModState(terminalId, report);
    if (!applied) {
      return null;
    }
    const settings = readSettings() || {};
    const window = getWindow();
    const selection = readPanelSelection() || {};
    const kind = noticeForChange({
      previous: applied.previous,
      next: applied.next,
      isOnScreen: selection.terminalId === terminalId,
      windowFocused: Boolean(window && !window.isDestroyed() && window.isFocused()),
      notificationsOn: settings.modNotifications !== false
    });
    if (kind) {
      announce(kind, applied.terminal).catch((error) => log(`[mod] notice failed: ${error.message}`));
    }
    return applied;
  }

  function currentBranch(folder) {
    return new Promise((resolve) => {
      if (!folder) {
        resolve(null);
        return;
      }
      execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: folder, timeout: 5000 }, (error, standardOutput) => {
        const branch = error ? "" : String(standardOutput || "").trim();
        resolve(branch && branch !== "HEAD" ? branch : null);
      });
    });
  }

  // `clauding session-info <terminal>`.
  async function sessionInfo(terminalId) {
    const terminal = terminals().get(terminalId);
    if (!terminal || terminal.exited) {
      return null;
    }
    const branch = await currentBranch(terminal.workingDirectory);
    let linkedTask = null;
    try {
      linkedTask = terminal.sessionId && linkedTaskForSession ? linkedTaskForSession(terminal.sessionId) : null;
    } catch (error) {
      linkedTask = null;
    }
    return sessionInfoResponse({
      terminal,
      branch,
      linkedTask,
      branchTaskId: taskIdFromBranch(branch || ""),
      settings: readSettings() || {}
    });
  }

  return { modSupport, readModPlan, reportState, sessionInfo };
}
