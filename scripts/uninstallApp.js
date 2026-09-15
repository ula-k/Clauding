// `npm run uninstall-app`: removes the launcher bundle that
// `npm run install-app` put in /Applications.
//
// Only the bundle goes. The project folder stays, and so does everything the
// app stores in ~/Library/Application Support/Clauding (groups, agents, the
// preamble, the panel tabs) — delete that folder by hand if you want those
// gone too.
import fs from "node:fs";
import path from "node:path";

const bundlePath = process.env.CLAUDING_APP_BUNDLE || "/Applications/Clauding.app";
const launcherPath = path.join(bundlePath, "Contents", "MacOS", "Clauding");

function main() {
  if (!fs.existsSync(bundlePath)) {
    console.log(`[uninstall-app] nothing to remove: there is no ${bundlePath}`);
    return;
  }
  // Only ever remove our own launcher bundle, never some other Clauding.app.
  let launcher = "";
  try {
    launcher = fs.readFileSync(launcherPath, "utf8");
  } catch (error) {
    launcher = "";
  }
  if (!launcher.includes("PROJECT_DIRECTORY=")) {
    console.log(`[uninstall-app] ${bundlePath} is not a Clauding launcher bundle — left alone.`);
    process.exit(1);
  }
  fs.rmSync(bundlePath, { recursive: true, force: true });
  console.log(`[uninstall-app] removed ${bundlePath}`);
  console.log("[uninstall-app] ~/Library/Application Support/Clauding was kept.");
}

main();
