# CL-20 · Find in conversation
Priority: P2 · Verified by: dry test `test/transcriptSearch.test.js` + manual
(screenshot hook `CLAUDING_SCREENSHOT_FIND`)

## Goal
A word typed into the find bar is found everywhere it occurs in the session's
own JSONL transcript — including in places the terminal no longer shows — and
the hits are readable, in order, and reachable one by one.

## Preconditions
- A session whose transcript holds the word in an assistant message **and** in
  a tool result, and ideally in a subagent transcript as well.
- That session is selected and its terminal is on screen.

## Steps
1. Press ⌘F (Ctrl+F on Windows), then close the bar with Escape.
2. Open it again through **View → Find in conversation…**.
3. Type the word and press Enter.
4. Press Enter and Shift+Enter a few times; press ↑ and ↓.
5. Click a hit whose text is an assistant message, and one whose text is a
   tool result.
6. Press **Refresh** in the results header.
7. Type a word that is nowhere in the transcript and press Enter.
8. Select another session.

## Expected state
- The bar is over the terminal, not on a second header line; the terminal
  underneath keeps running and keeps its scrollback.
- The results are one tab in the side panel for that session, named after the
  query; a second search replaces it rather than adding another.
- Every hit says whose it was (you / Claude / tool result / subagent) and what
  kind of block it was, and shows the matched word marked in a short snippet.
- Hits appear in the order the conversation happened, with each subagent's
  hits after the main transcript's.
- The count in the bar moves with Enter / Shift+Enter / ↑ / ↓ and wraps round
  at both ends; the results tab scrolls to the hit being pointed at.
- A clicked hit opens the whole message; an assistant message is read as
  markdown, everything else as it is. A message cut at 20 kB says so.
- Refresh runs the search again against the file as it is now.
- A word that is not there says so and shows no hits; nothing errors.
- Selecting another session closes the bar.
- Nothing under `~/.claude` is written, and `panel-tabs.json` holds no search
  tab after a restart.

## Notes
The parsing and the matching are covered dry by `test/transcriptSearch.test.js`
against a fixture JSONL: which line types are conversation and which are
bookkeeping, both shapes of `tool_result`, the case-insensitive matching, the
snippet window and its marking, and the 20 kB cap.
