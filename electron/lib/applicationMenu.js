// The menu bar, as a value.
//
// It is the same menu everywhere — Clauding / Edit / Skills / View / Window —
// but macOS and Windows disagree about what belongs in the first one. macOS
// puts Services, Hide, Hide Others, Show All and Quit into the application
// menu and draws it at the top of the screen; Windows has none of those
// roles (Electron simply drops them) and draws the menu bar inside the
// window, so there the first menu holds the About item, the version check,
// Settings and Quit, and nothing else.
//
// Accelerators are written as "CommandOrControl+…", which Electron renders as
// ⌘ on macOS and Ctrl on Windows, so one string is right on both.
//
// Pure on purpose: main.js hands in the labels and the click handlers, and
// test/platform.test.js reads the template back for either platform without
// an Electron window.
import { isMacOS } from "./platformPaths.js";

export const SETTINGS_ACCELERATOR = "CommandOrControl+,";

export function applicationMenuTemplate({
  platform = process.platform,
  applicationName = "Clauding",
  updateItemLabel = "Check for new version…",
  settingsLabel = "Settings…",
  skillsMenu = { label: "Skills", submenu: [] },
  onCheckForUpdate = () => {},
  onShowSettings = () => {}
} = {}) {
  const onMac = isMacOS(platform);
  const applicationSubmenu = [
    { role: "about" },
    { type: "separator" },
    { label: updateItemLabel, click: onCheckForUpdate },
    { type: "separator" },
    { label: settingsLabel, accelerator: SETTINGS_ACCELERATOR, click: onShowSettings },
    { type: "separator" }
  ];
  if (onMac) {
    applicationSubmenu.push(
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" }
    );
  }
  applicationSubmenu.push({ role: "quit" });

  return [
    // macOS draws this title from the bundle, but the label keeps the name
    // right when the app runs without one (`npm start`), and on Windows it is
    // the only thing that names the menu at all.
    { label: applicationName, submenu: applicationSubmenu },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    skillsMenu,
    { role: "viewMenu" },
    { role: "windowMenu" }
  ];
}

// The roles macOS understands and Windows does not; kept next to the
// template so a test can say what must not be in the Windows one.
export const MACOS_ONLY_MENU_ROLES = ["services", "hide", "hideOthers", "unhide"];
