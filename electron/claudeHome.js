// Which Claude Code folder this app reads — the one thing about the CLI that
// used to be baked in as ~/.claude.
//
// The order is the CLI's own: CLAUDE_CONFIG_DIR, when the app was started
// with it, wins over everything. Otherwise `claudeHome` from settings.json is
// used, and — so that every `claude` this app starts, and the Agent SDK that
// lists the sessions, look at the same folder — it is exported as
// CLAUDE_CONFIG_DIR into the app's own environment (and from there into every
// terminal). With neither, it is ~/.claude and the variable is left alone.
import os from "node:os";
import { claudeHomeFolder, claudeRegistryPaths, samePath } from "./lib/platformPaths.js";

const inheritedConfigurationFolder = String(process.env.CLAUDE_CONFIG_DIR || "").trim();
let configuredHome = "";

// `environment` is a parameter only for the dry tests.
export function applyConfiguredClaudeHome(folder, { environment = process.env, inherited = inheritedConfigurationFolder, homeDirectory = os.homedir() } = {}) {
  configuredHome = String(folder || "").trim();
  if (inherited) {
    return inherited;
  }
  const defaultHome = claudeHomeFolder({ homeDirectory, environment: {} });
  if (configuredHome && !samePath(configuredHome, defaultHome)) {
    environment.CLAUDE_CONFIG_DIR = configuredHome;
  } else {
    delete environment.CLAUDE_CONFIG_DIR;
  }
  return currentClaudeHome({ environment, homeDirectory });
}

export function currentClaudeHome({ environment = process.env, homeDirectory = os.homedir() } = {}) {
  return claudeHomeFolder({ homeDirectory, environment, configuredHome });
}

// Where the value came from, for `clauding settings get claudeHome`.
export function claudeHomeOrigin({ environment = process.env } = {}) {
  if (inheritedConfigurationFolder) {
    return "CLAUDE_CONFIG_DIR";
  }
  if (configuredHome && String(environment.CLAUDE_CONFIG_DIR || "") === configuredHome) {
    return "settings";
  }
  return "default";
}

// The registries inside the current folder, read at the moment of asking:
// the setting can change while the app runs.
export function currentRegistryPaths() {
  return claudeRegistryPaths({ homeDirectory: os.homedir(), claudeHome: currentClaudeHome() });
}
