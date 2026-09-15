# CL-17 · App · installer
Priority: P2 · Verified by: dry test `test/installApp.test.js` + manual

## Goal
`npm run install-app` leaves a Clauding.app with its icon that starts this
checkout; started from the Dock it still finds `claude` and `clauding` despite
the sparse PATH a GUI app inherits; `npm run uninstall-app` removes it again.

## Preconditions
- `npm install` has been run in this checkout (Electron is there).
- macOS.

## Steps
1. Run `npm run install-app`.
2. Look at the bundle in Applications: its name and its icon.
3. Start it from Launchpad or Spotlight (not from the terminal).
4. In a terminal of the app, run `which claude` and `which clauding`, and open
   a session.
5. Move the checkout to another folder and start the bundle again.
6. Run `npm run uninstall-app` and look at Applications.

## Expected state
- The bundle carries the app's name, the version from package.json and the
  icon; it holds no copy of the code, only a launcher pointing at this
  checkout.
- Started from the Dock, the app finds the CLI: `~/.local/bin`,
  `/opt/homebrew/bin` and `/usr/local/bin` are on the PATH of its terminals,
  and `clauding` resolves to the one in this checkout's `bin/`.
- After the checkout has moved, the old bundle no longer works and the fix is
  to run `npm run install-app` again (it is written in the launcher itself).
- Uninstalling removes the bundle and nothing else.

## Evidence
- `test/installApp.test.js`, writing the bundle into a throw-away folder —
  `/Applications` is never touched and the renderer is not built:
  - "the bundle is a property list, an executable script and an icon",
    including the launcher's 0755 mode.
  - "the property list carries the version from package.json" and "a checkout
    with no package.json still gets a version".
  - "the launcher starts this checkout, with the usual shell folders on PATH"
    — the three folders of step 4 and the Electron binary of this checkout.
  - "the project folder is the one this script lives in, whatever the folder
    is called" — resolved from the script's own location, and a path with a
    space in it survives.
  - "a missing icon is reported and does not stop the bundle".
  - "installing again replaces what was there before" (step 1 run twice).
  - "writing a bundle touches nothing outside the folder it was given".
- Manual, with screenshots: the icon in Applications (step 2), the app started
  from Spotlight (step 3), the two `which` answers (step 4), and Applications
  after uninstalling (step 6).

## Out of scope
- Signing, notarising and a real packaged app: not offered.
- `node-pty` and rebuilding the binary: installation, not behaviour (the plan
  puts it out of scope).

## What the dry tests do not prove
- That the bundle actually starts, that the Dock shows the icon, and that the
  app finds `claude` with a GUI PATH: manual.
- `npm run uninstall-app`: manual.
