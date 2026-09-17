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

export const FIND_ACCELERATOR = "CommandOrControl+F";

// The View menu is written out rather than taken as `role: "viewMenu"`,
// because "Find in conversation…" has to sit at the top of it — above the
// reload / zoom / full-screen roles, which are kept exactly as the role
// would have given them. Its accelerator is what ⌘F in the window is: a
// menu accelerator beats anything the page (and xterm) would do with the
// key, so there is no second keyboard handler anywhere.
export function applicationMenuTemplate({
  platform = process.platform,
  applicationName = "Clauding",
  updateItemLabel = "Check for new version…",
  settingsLabel = "Settings…",
  findLabel = "Find in conversation…",
  pasteLabel = "Paste",
  skillsMenu = { label: "Skills", submenu: [] },
  onCheckForUpdate = () => {},
  onShowSettings = () => {},
  onFindInConversation = () => {},
  // macOS only, and only when main.js hands one in: Clauding's own paste
  // (see electron/pasteSmart.js). Without it the item stays the plain role.
  onPaste = null
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

  // Edit → Paste. A menu accelerator beats anything the page would do with
  // the key, so ⌘V can only be intercepted here: on macOS the item is
  // Clauding's own paste, which types the path of a file on the clipboard
  // into the terminal and falls back to the ordinary paste everywhere else.
  // On Windows it stays the plain role — Ctrl+V there is what Claude Code's
  // own image paste is bound to, and nothing about it changes.
  const pasteItem = onMac && onPaste ? { label: pasteLabel, accelerator: "CommandOrControl+V", click: onPaste } : { role: "paste" };

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
        pasteItem,
        { role: "selectAll" }
      ]
    },
    skillsMenu,
    {
      label: "View",
      submenu: [
        { label: findLabel, accelerator: FIND_ACCELERATOR, click: onFindInConversation },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    { role: "windowMenu" }
  ];
}

// The roles macOS understands and Windows does not; kept next to the
// template so a test can say what must not be in the Windows one.
export const MACOS_ONLY_MENU_ROLES = ["services", "hide", "hideOthers", "unhide"];
