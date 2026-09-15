// Renderer-side twin of projectFolderLabel() in electron/projects.js, for
// paths the renderer only has as a raw string (a folder picked in the dialog).
export function folderLabel(folderPath) {
  if (!folderPath) {
    return "";
  }
  const homeRelative = folderPath.replace(/^\/Users\/[^/]+/, "~");
  if (homeRelative === "~") {
    return "~";
  }
  if (homeRelative.startsWith("~/") && homeRelative.slice(2).split("/").filter(Boolean).length <= 2) {
    return homeRelative;
  }
  const segments = folderPath.split("/").filter(Boolean);
  if (segments.length <= 2) {
    return `/${segments.join("/")}`;
  }
  return `…/${segments.slice(-2).join("/")}`;
}
