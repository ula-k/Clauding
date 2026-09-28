// The side panel's zoom, per tab.
//
// Electron remembers a page's zoom per origin, and every local file shares
// the one `file://` origin: a zoom once applied to one page stuck to all of
// them, survived a reload, and nothing on screen said so. The panel
// therefore keeps its own zoom per tab (in memory, never saved), puts it
// back on the guest whenever a page loads or its tab comes to the front,
// and shows it in the address bar whenever it is not 100 %.
//
// The steps are Chromium's own, so ⌘+ / ⌘− feel the same as in a browser.

export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const DEFAULT_ZOOM = 1;

export function clampZoom(factor) {
  const value = Number(factor);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_ZOOM;
  }
  return Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], value));
}

// One step in (+1) or out (−1) from wherever the zoom is now; a factor
// between two steps moves to the next one in that direction.
export function stepZoom(factor, direction) {
  const current = clampZoom(factor);
  if (direction > 0) {
    return ZOOM_STEPS.find((step) => step > current + 0.001) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
  }
  const smaller = ZOOM_STEPS.filter((step) => step < current - 0.001);
  return smaller.length > 0 ? smaller[smaller.length - 1] : ZOOM_STEPS[0];
}

// "125 %" for the address bar, or null at 100 % (nothing to say).
export function zoomLabel(factor) {
  const current = clampZoom(factor);
  if (Math.abs(current - DEFAULT_ZOOM) < 0.001) {
    return null;
  }
  return `${Math.round(current * 100)} %`;
}

// A command from the menu bar (in / out / reset) applied to a factor.
export function applyZoomCommand(factor, command) {
  if (command === "in") {
    return stepZoom(factor, 1);
  }
  if (command === "out") {
    return stepZoom(factor, -1);
  }
  return DEFAULT_ZOOM;
}
