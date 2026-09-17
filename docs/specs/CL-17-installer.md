# CL-17 · App · installer
Priority: P2 · Verified by: dry test `test/installApp.test.js` + manual

## Goal
`npm run install-app` leaves a Clauding.app in Applications that is called
Clauding everywhere macOS shows a name — the Dock, the leftmost menu-bar
menu, the About panel — and that runs this checkout; started from the Dock it
still finds `claude` and `clauding` despite the sparse PATH a GUI app
inherits; `npm run uninstall-app` removes it again.

## Preconditions
- `npm install` has been run in this checkout (Electron is there).
- macOS.

## Steps
1. Run `npm run install-app`.
2. Look at the bundle in Applications: its name and its icon.
3. Start it from Launchpad or Spotlight (not from the terminal).
4. Read the leftmost menu-bar title, and open it → About Clauding.
5. In a terminal of the app, run `which claude` and `which clauding`, and open
   a session.
6. Move the checkout to another folder and start the bundle again.
7. Run `npm run uninstall-app` and look at Applications.

## Expected state
- The bundle carries the app's name, the version from package.json and the
  icon. It is Electron's own bundle, copied and renamed, signed ad-hoc; of
  our code it holds only a two-line entry importing this checkout's
  `electron/main.js`, so there is no second copy of the app.
- The menu-bar title says Clauding, and the About panel shows the Clauding
  icon, "Clauding" and the version from package.json — not Electron, its
  version and its atom.
- Started from the Dock, the app finds the CLI: `~/.local/bin`,
  `/opt/homebrew/bin` and `/usr/local/bin` are on the PATH of its terminals
  (`ensureShellPath()` in `electron/main.js`), and `clauding` resolves to the
  one in this checkout's `bin/`.
- After the checkout has moved, the old bundle no longer works and the fix is
  to run `npm run install-app` again (it is written in the entry itself).
- Uninstalling removes the bundle and nothing else.

## Evidence
- `test/installApp.test.js`, building the bundle in a throw-away folder from
  a fake Electron.app skeleton — /Applications is never touched, the real
  Electron is never copied, nothing is built, signed or launched:
  - "the bundle is Electron's own, renamed to Clauding" — the four name keys
    plus the category, and Electron's own untouched keys still there.
  - "the executable is renamed too, and stays runnable".
  - "the property list carries the version from package.json" and "a checkout
    with no package.json still gets a version".
  - "our icon replaces Electron's" — including `electron.icns` being gone.
  - "a missing icon is reported and does not stop the bundle".
  - "the app inside the bundle is two lines pointing at this checkout" — a
    static import of the absolute path, an ES module manifest, and nothing
    else in the folder.
  - "a checkout path with a space in it survives into the entry".
  - "installing again replaces what was there before" (step 1 run twice).
  - "writing a bundle touches nothing outside the folder it was given".
  - "uninstalling only ever removes a bundle install-app wrote".
- Manual, with screenshots: the icon in Applications (step 2), the app
  started from Spotlight (step 3), the menu-bar title and the About panel
  (step 4) — the panel can be photographed with
  `CLAUDING_SCREENSHOT_ABOUT=1` (see the screenshot switches in
  `electron/main.js`), the two `which` answers (step 5), and Applications
  after uninstalling (step 7).

## Out of scope
- Signing with a Developer ID and notarising: the bundle is signed ad-hoc,
  which is enough to start it locally but not to hand it to anybody else.
- Renaming the helper bundles inside Electron.app ("Electron Helper"): they
  are not user-visible outside Activity Monitor.
- `node-pty` and rebuilding the binary: installation, not behavior (the plan
  puts it out of scope).

## What the dry tests do not prove
- That the bundle actually starts, that the Dock shows the icon, and that the
  app finds `claude` with a GUI PATH: manual.
- `npm run uninstall-app`: manual.
