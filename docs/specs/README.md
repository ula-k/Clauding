# Clauding test specifications

Nineteen specifications, one per item of the accepted QA plan, in nine areas.
Each one says what must be true, how to get there by clicking, and what proves
it. They describe **state and meaning** ("the row says the session is running
elsewhere"), never the exact wording on screen — wording is quoted only as
"currently e.g. …", so a reworded label is not a failing test.

## How a specification is verified

- **dry test `<file>`** — an automated test under `test/`, run with `npm test`.
  A dry test never starts the app, never starts Electron and never starts a
  real `claude`: it exercises the same modules the app uses, with its files in
  a throw-away folder under the system temporary folder. It costs nothing and
  can be run at any time.
- **manual** — the maintainer, clicking, with a screenshot. Everything that needs a real
  window, a real pty, a real Claude Code session or a second instance of the
  app.
- **smoke hook `CLAUDING_SMOKE_*`** — the app's own dev-only automations (see
  the README). They drive the real interface and some of them spend a few
  cents on real `claude` calls. Where one exists it is named, but it is not
  part of `npm test`.

## Index

| Id | Area · name | Priority | How verified |
| --- | --- | --- | --- |
| [CL-01](CL-01-sessions-list-and-status.md) | List · sessions and status | P1 | dry test `test/sessions.test.js`, `test/liveStatus.test.js` + manual |
| [CL-02](CL-02-session-running-elsewhere.md) | List · a session running outside the app | P1 | dry test `test/liveStatus.test.js` + manual |
| [CL-03](CL-03-search.md) | List · search | P2 | dry test `test/sessionGrouping.test.js` + manual |
| [CL-04](CL-04-groups-create-and-order.md) | Groups · creating and ordering | P1 | dry test `test/sessionGroups.test.js`, `test/sessionGrouping.test.js` + manual |
| [CL-05](CL-05-groups-hiding.md) | Groups · hiding | P1 | dry test `test/sessionGroups.test.js`, `test/sessionGrouping.test.js` + manual |
| [CL-06](CL-06-groups-collapsing.md) | Groups · collapsing | P2 | dry test `test/sessionGrouping.test.js`, `test/sessionGroups.test.js` + manual |
| [CL-07](CL-07-click-opens-a-terminal.md) | Terminal · a click is a terminal | P1 | dry test `test/claudeCli.test.js` + manual |
| [CL-08](CL-08-new-session-and-self-closing.md) | Terminal · "+ New" and self-closing | P2 | dry test `test/sessions.test.js` + manual |
| [CL-09](CL-09-fork.md) | Fork | P1 | dry test `test/claudeCli.test.js` + manual |
| [CL-10](CL-10-panel-tabs-per-session.md) | Panel · tabs per session | P1 | dry test `test/panelTabs.test.js` + manual |
| [CL-11](CL-11-clauding-command.md) | Panel · the `clauding` command | P1 | dry test `test/commandProtocol.test.js` + manual |
| [CL-12](CL-12-panel-width.md) | Panel · width | P2 | manual (smoke hook `CLAUDING_SMOKE_RESIZE`) |
| [CL-13](CL-13-preamble-resumed-session.md) | Preamble · a resumed session | P1 | dry test `test/preamble.test.js`, `test/claudeCli.test.js` + manual |
| [CL-14](CL-14-preamble-editing-and-refresh.md) | Preamble · editing and refreshing | P3 | dry test `test/preamble.test.js` |
| [CL-15](CL-15-agents.md) | Agents | P1 | dry test `test/agents.test.js`, `test/emojiChoices.test.js`, `test/claudeCli.test.js` + manual |
| [CL-16](CL-16-single-instance-and-relaunch.md) | App · one instance and relaunch | P1 | manual |
| [CL-17](CL-17-installer.md) | App · installer | P2 | dry test `test/installApp.test.js` + manual |
| [CL-18](CL-18-languages.md) | Languages | P3 | dry test `test/i18n.test.js` + manual |
| [CL-19](CL-19-windows.md) | App · Windows | P2 | dry test `test/platform.test.js` + CI on `windows-latest`; manual **not done yet** |

Eleven P1, six P2, two P3.

## Rules every specification follows

- Steps are a click path in the app, not an IPC call and not a file path.
- What is judged is state and meaning, not wording; wording is only ever
  quoted as "currently e.g. …".
- Every manual finding comes with a screenshot.
- A dry test works in a throw-away folder; after a run the app's own files,
  its socket and this repository are untouched.
- The burden of proof is on the test: a specification says which assertion
  proves which sentence, and names what is left unproven.

## The template

```
# CL-NN · Area · Name
Priority: P1 · Verified by: dry test <file> / manual

## Goal
One sentence: what must be true once this has been checked.

## Preconditions
The state to start from (e.g. session X is running in Terminal.app; the panel
is hidden; a throw-away folder is in use).

## Steps
1. Click … 2. Type … 3. Run `clauding open …` — a click path, not a URL.

## Expected state
What is on screen and what it means (the row changed colour; this session's
panel shows the page), not the exact words — wording as "currently e.g. …".

## Evidence
Which dry test proves which sentence; which screenshot proves the rest.

## Out of scope
What this specification deliberately leaves out, and which one takes it.

## What the dry tests do not prove
(automated ones only) Said plainly, e.g. "the pointer crossing the webview:
manual".
```
