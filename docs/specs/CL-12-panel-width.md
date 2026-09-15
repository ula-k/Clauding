# CL-12 · Panel · width
Priority: P2 · Verified by: manual (smoke hook `CLAUDING_SMOKE_RESIZE`)

## Goal
A width remembered from a bigger window comes back inside the limits, so the
panel handle is always reachable; both handles drag in both directions; and a
drag whose pointer travels over a page in the panel does not stop halfway.

## Preconditions
- A page is open in the panel (a real page, not an empty panel — the pointer
  has to cross it).
- A panel width wider than the current window is in the stored settings (for
  example stored while the window was maximised on a bigger screen).

## Steps
1. Start the app with that stored width and look at the panel.
2. Drag the panel handle to make the panel wider, then narrower.
3. Drag the left column's handle both ways.
4. Make the window much narrower and look at the panel again.

## Expected state
- On start the panel is inside its limits and its handle is on screen and
  grabbable — never pushed off the edge.
- Both handles follow the pointer in both directions; the drag continues while
  the pointer is over the page in the panel.
- Shrinking the window brings the panel back inside the limits by itself; the
  middle column never disappears.

## Evidence
- Manual, with screenshots: the corrected width on start (step 1), the panel
  dragged narrower with the pointer over the page (step 2), and the window
  shrunk (step 4).
- The smoke hook `CLAUDING_SMOKE_RESIZE` reproduces steps 1–3 with real mouse
  events through `webContents.sendInputEvent`, including the drag across the
  panel's webview, and puts the stored widths back afterwards.

## Out of scope
- What the panel shows: CL-10.
- Any dry test: the clamping rule lives inside the window component together
  with the drag handling, and the interesting half of this specification is
  the pointer crossing a separate guest process — which no dry test can
  reproduce. If the rule is ever needed on its own, it can be pulled out and
  tested then.
