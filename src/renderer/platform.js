// What the window has to know about the system it is drawn on.
//
// The renderer has no Node: the preload script puts `process.platform` on
// `window.clauding.platform` and everything here reads it from there — or
// takes it as a parameter, so the Windows behaviour can be checked on a Mac
// (test/platform.test.js).
//
// Two things actually differ. The modifier key: ⌘ on macOS, Ctrl on Windows,
// which changes both what a keydown handler looks at and what the tooltips
// say. And the emoji panel: Electron can only open the macOS character
// palette, so on Windows the 🙂 button is not drawn at all — the built-in
// grid next to it stays, and the system's own Win+. picker still types into
// the focused field.
export const WINDOWS = "win32";
export const MACOS = "darwin";

export function currentPlatform() {
  if (typeof window !== "undefined" && window.clauding && typeof window.clauding.platform === "string") {
    return window.clauding.platform;
  }
  return MACOS;
}

export function isWindowsPlatform(platform = currentPlatform()) {
  return platform === WINDOWS;
}

// True for ⌘ on macOS and for Ctrl on Windows — and false when the *other*
// one is held, so Ctrl+Backspace inside a Mac terminal (delete the word) is
// never mistaken for the shortcut.
export function commandKeyPressed(event, platform = currentPlatform()) {
  if (!event) {
    return false;
  }
  if (isWindowsPlatform(platform)) {
    return Boolean(event.ctrlKey) && !event.metaKey;
  }
  return Boolean(event.metaKey) && !event.ctrlKey;
}

// The shortcut that hands a path or a URL to the system instead of the
// panel: ⌘+click on macOS, Ctrl+click on Windows.
export function openExternallyModifierPressed(event, platform = currentPlatform()) {
  return commandKeyPressed(event, platform);
}

// What the tooltips and hints spell out. These go into translate() as the
// {shortcut} placeholder, so the sentence around them stays translated.
export function shortcutLabels(platform = currentPlatform()) {
  if (isWindowsPlatform(platform)) {
    return {
      hideSession: "Ctrl+Backspace",
      settings: "Ctrl+,",
      clearTerminal: "Ctrl+K",
      emojiPanel: "Win+."
    };
  }
  return {
    hideSession: "⌘⌫",
    settings: "⌘,",
    clearTerminal: "⌘K",
    emojiPanel: "⌃⌘Space"
  };
}

// Electron's app.showEmojiPanel() only exists on macOS, so the button that
// asks for it is only drawn there.
export function nativeEmojiPanelAvailable(platform = currentPlatform()) {
  return platform === MACOS;
}
