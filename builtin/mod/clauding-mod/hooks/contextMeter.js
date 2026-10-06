// How full the session's context is, as the context bar and the status line
// show it.
//
// The bar fills with the context USED (5 % used → 5 % of the bar filled), so
// an almost empty bar means plenty of room; the label next to it still says
// how much is left ("95% left"). The color ramps with use: green, amber from
// 60 % used, red with a warning from 80 %.
//
// Pure: numbers in, a plain description out — register.mjs draws it, the
// tests read it.

export const CONTEXT_CAUTION_PERCENT = 60;
export const CONTEXT_WARNING_PERCENT = 80;

export function contextBarModel(percentUsed, width) {
  const used = Math.max(0, Math.min(100, Math.round(Number(percentUsed) || 0)));
  const left = 100 - used;
  const filled = Math.round((used / 100) * width);
  let color = "green";
  if (used >= CONTEXT_WARNING_PERCENT) {
    color = "red";
  } else if (used >= CONTEXT_CAUTION_PERCENT) {
    color = "yellow";
  }
  return {
    used,
    left,
    filled,
    empty: width - filled,
    color,
    warning: used >= CONTEXT_WARNING_PERCENT,
    label: `${left}% left`
  };
}

export function contextStatusText(reading) {
  return reading ? `${reading.percent}% context used` : "context —";
}
