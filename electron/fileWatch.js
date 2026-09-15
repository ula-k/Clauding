// Watches one file for changes (debounced 300 ms) so a page open in the
// panel reloads when Claude edits it. The parent folder is watched and
// filtered by file name, because editors that save through a temporary file
// and rename would otherwise detach a watcher pinned to the inode.
import fs from "node:fs";
import path from "node:path";

const DEBOUNCE_MILLISECONDS = 300;

export function watchFile(filePath, onChange) {
  const folder = path.dirname(filePath);
  const fileName = path.basename(filePath);
  let debounceTimer = null;
  let watcher = null;
  function scheduleChange() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onChange(filePath);
    }, DEBOUNCE_MILLISECONDS);
  }
  try {
    watcher = fs.watch(folder, { persistent: false }, (eventType, changedName) => {
      if (!changedName || changedName === fileName) {
        scheduleChange();
      }
    });
    watcher.on("error", () => {});
  } catch (error) {
    watcher = null;
  }
  return function stop() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    if (watcher) {
      watcher.close();
    }
  };
}

// Reference-counted watchers keyed by path, for the renderer's watch /
// unwatch pairs (two tabs of the same file share one watcher).
export function createFileWatchRegistry(onChange) {
  const watchers = new Map();
  function watch(filePath) {
    const entry = watchers.get(filePath);
    if (entry) {
      entry.count += 1;
      return;
    }
    watchers.set(filePath, { count: 1, stop: watchFile(filePath, onChange) });
  }
  function unwatch(filePath) {
    const entry = watchers.get(filePath);
    if (!entry) {
      return;
    }
    entry.count -= 1;
    if (entry.count <= 0) {
      entry.stop();
      watchers.delete(filePath);
    }
  }
  function stopAll() {
    for (const entry of watchers.values()) {
      entry.stop();
    }
    watchers.clear();
  }
  return { watch, unwatch, stopAll };
}
