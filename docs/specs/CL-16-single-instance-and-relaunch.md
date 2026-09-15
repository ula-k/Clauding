# CL-16 · App · one instance and relaunch
Priority: P1 · Verified by: manual

## Goal
A second launch only brings the first window up, and the list keeps
refreshing; quitting the app leaves no `claude` process behind, every session
can be resumed by clicking it again, and a test run leaves this repository
untouched.

## Preconditions
- Clauding is running with two or three terminals open, in scratch folders.
- A terminal window ready for `ps`.

## Steps
1. With the app running, launch it again (from the Dock, from Spotlight, or
   with `npm start`).
2. Count the windows, then watch the list: start something somewhere else and
   see whether the list still changes on its own.
3. Note the pids of the `claude` processes the app started
   (`ps -Ao pid,ppid,command | grep claude`).
4. Quit the app.
5. Run the same `ps` again.
6. Start the app and click each of the sessions from step 1.
7. Run `git status` in this repository.

## Expected state
- The second launch opens no second window: the first one comes forward
  (restored if it was minimised), and the list goes on refreshing — two
  instances reading the session list at once were seen to stall it.
- After quitting, none of the `claude` processes the app started is left.
- Each of those sessions resumes from its row, with its conversation intact.
- This repository has no changes from any test run: every automated test
  works in a throw-away folder, and the smoke runs work in the smoke folder.

## Evidence
- Manual only, with screenshots: the single window after the second launch
  (steps 1–2), the two `ps` outputs before and after quitting (steps 3 and 5),
  the resumed sessions (step 6), and `git status` (step 7).
- Nothing here can be a dry test: the single-instance lock, the window and the
  quit handling are Electron's, and this specification is about the app being
  started and stopped for real.

## Out of scope
- What a click does with a session: CL-07.
- The installed bundle: CL-17.

## What the dry tests do not prove
- All of it: this specification has no automated part on purpose.
