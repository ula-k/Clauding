// CL-25 — "Check for new version…": the comparison and the decision behind
// the dialog (electron/updater.js). Nothing is fetched, pulled or installed
// here: `updatePlan` is a pure function of what git said, and the rest of
// this file only touches a temporary folder.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  QUIET_CHECK_INTERVAL_MILLISECONDS,
  lastLinesOf,
  quietCheckIsDue,
  readLastQuietCheck,
  updateMenuItemLabel,
  updatePlan,
  writeLastQuietCheck
} from "../electron/updater.js";

test("nothing new means nothing to do, whatever the tree looks like", () => {
  const plan = updatePlan({ localVersion: "0.2.0", remoteVersion: "0.2.0", behindCount: 0, clean: false, branch: "side" });
  assert.equal(plan.updateAvailable, false);
  assert.equal(plan.canUpdateInApp, false);
  assert.equal(plan.headline, "You're up to date (0.2.0)");
  assert.equal(plan.detail, "");
});

test("a newer origin/main is offered with the version and how many changes it is", () => {
  const plan = updatePlan({ localVersion: "0.2.0", remoteVersion: "0.3.0", behindCount: 7, clean: true, branch: "main" });
  assert.equal(plan.updateAvailable, true);
  assert.equal(plan.canUpdateInApp, true);
  assert.equal(plan.blockedBy, null);
  assert.equal(plan.newVersion, "0.3.0");
  assert.equal(plan.headline, "Clauding 0.3.0 is available");
  assert.match(plan.detail, /7 new changes since your version \(0\.2\.0\)/);
  const single = updatePlan({ localVersion: "0.2.0", remoteVersion: "0.3.0", behindCount: 1, clean: true, branch: "main" });
  assert.match(single.detail, /^1 new change since/, 'one commit is not "1 new changes"');
});

test("commits without a version bump still say which version is on offer", () => {
  const plan = updatePlan({ localVersion: "0.2.0", remoteVersion: "0.2.0", behindCount: 3, clean: true, branch: "main" });
  assert.equal(plan.updateAvailable, true);
  assert.equal(plan.newVersion, "0.2.0");
  assert.equal(plan.headline, "Clauding 0.2.0 is available");
});

test("the app updates the checkout only on a clean main", () => {
  const dirty = updatePlan({ localVersion: "0.2.0", remoteVersion: "0.3.0", behindCount: 2, clean: false, branch: "main" });
  assert.equal(dirty.updateAvailable, true);
  assert.equal(dirty.canUpdateInApp, false);
  assert.equal(dirty.blockedBy, "changes");
  const otherBranch = updatePlan({
    localVersion: "0.2.0",
    remoteVersion: "0.3.0",
    behindCount: 2,
    clean: true,
    branch: "feature/telegram"
  });
  assert.equal(otherBranch.canUpdateInApp, false);
  assert.equal(otherBranch.blockedBy, "branch");
});

test("the menu item is the only thing a quiet check changes", () => {
  assert.equal(updateMenuItemLabel(null), "Check for new version…");
  assert.equal(
    updateMenuItemLabel(updatePlan({ localVersion: "0.2.0", remoteVersion: "0.2.0", behindCount: 0, clean: true, branch: "main" })),
    "Check for new version…"
  );
  assert.equal(
    updateMenuItemLabel(updatePlan({ localVersion: "0.2.0", remoteVersion: "0.3.0", behindCount: 4, clean: true, branch: "main" })),
    "Update available (0.3.0)…"
  );
});

test("a failing step is reported by its last lines, blank ones dropped", () => {
  const output = ["one", "", "two", "three", "   ", "four"].join("\n");
  assert.equal(lastLinesOf(output, 2), "three\nfour");
  assert.equal(lastLinesOf("", 5), "");
});

test("the quiet check runs at most once a day and remembers when it ran", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-update-check-"));
  assert.equal(readLastQuietCheck(folder), 0, "nothing remembered yet");
  assert.equal(quietCheckIsDue(0), true);
  const when = Date.now();
  writeLastQuietCheck(folder, when);
  assert.equal(readLastQuietCheck(folder), when);
  assert.equal(quietCheckIsDue(when, when + 1000), false, "just checked");
  assert.equal(quietCheckIsDue(when, when + QUIET_CHECK_INTERVAL_MILLISECONDS), true, "a day later");
  fs.rmSync(folder, { recursive: true, force: true });
});
