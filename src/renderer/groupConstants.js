// The one group that always exists. The main process (electron/sessionGroups.js)
// uses the same id; it is repeated here so the renderer does not import from
// the Electron side.
export const DEFAULT_GROUP_ID = "default";

// The header label of a group: the stored name, or the translated "Default"
// for the built-in group as long as it was never renamed.
export function groupDisplayName(group, translate) {
  if (group.id === DEFAULT_GROUP_ID && !group.name) {
    return translate("groups.default");
  }
  return group.name || translate("groups.default");
}
