// One line of header controls, and a "…" for everything that does not fit.
//
// The rule this encodes is the house rule for the terminal header: the row
// is at most ONE line; what does not fit goes into the three dots; what is
// in the three dots is not a button, and what is a button is not in the
// three dots. Nothing is ever in both places, and nothing ever wraps.
//
// `priority` is how much a control deserves to stay on the line: the
// biggest number survives the narrowest window. Where a control sits in
// the `items` array is only where it is drawn — it says nothing about
// whether it is kept.
//
// Widths are the natural (unshrunk) widths the caller measured, with the
// gap that follows each control already added in. `overflowButtonWidth` is
// the "…" button's own width, and it is only ever subtracted when
// something really does overflow: a row that fits exactly must not lose a
// control to make room for a "…" nobody would see.

export const HEADER_ITEM_PRIORITY = {
  agentChip: 60,
  kickoffHint: 55,
  statusPill: 50,
  fork: 40,
  createAgent: 30,
  harvestSkills: 20
};

export function fitToolbar({ availableWidth, items, overflowButtonWidth = 0 }) {
  const candidates = Array.isArray(items) ? items : [];
  const naturalWidth = candidates.reduce((total, candidate) => total + candidate.width, 0);
  if (naturalWidth <= availableWidth) {
    return { visible: candidates.map((candidate) => candidate.id), overflowed: [] };
  }
  // Array.prototype.sort is stable, so two controls of the same priority
  // keep the order they are drawn in.
  const byPriority = candidates.slice().sort((one, other) => other.priority - one.priority);
  const budget = availableWidth - overflowButtonWidth;
  const kept = new Set();
  let used = 0;
  for (const candidate of byPriority) {
    // The first control that does not fit stops the line: a smaller, less
    // important control must not jump in over a more important one that
    // was just refused.
    if (used + candidate.width > budget) {
      break;
    }
    used += candidate.width;
    kept.add(candidate.id);
  }
  return {
    visible: candidates.filter((candidate) => kept.has(candidate.id)).map((candidate) => candidate.id),
    overflowed: byPriority.filter((candidate) => !kept.has(candidate.id)).map((candidate) => candidate.id)
  };
}
