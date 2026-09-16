// `npm run uninstall-app`: removes the application bundle that
// `npm run install-app` put in /Applications.
//
// Only the bundle goes. The project folder stays, and so does everything the
// app stores in ~/Library/Application Support/Clauding (groups, agents, the
// preamble, the panel tabs) — delete that folder by hand if you want those
// gone too.
import fs from "node:fs";
import { isClaudingBundle } from "./lib/appBundle.js";

const bundlePath = process.env.CLAUDING_APP_BUNDLE || "/Applications/Clauding.app";

function main() {
  if (!fs.existsSync(bundlePath)) {
    console.log(`[uninstall-app] nothing to remove: there is no ${bundlePath}`);
    return;
  }
  // Only ever remove our own bundle, never some other Clauding.app.
  if (!isClaudingBundle(bundlePath)) {
    console.log(`[uninstall-app] ${bundlePath} was not written by install-app — left alone.`);
    process.exit(1);
  }
  fs.rmSync(bundlePath, { recursive: true, force: true });
  console.log(`[uninstall-app] removed ${bundlePath}`);
  console.log("[uninstall-app] ~/Library/Application Support/Clauding was kept.");
}

main();
