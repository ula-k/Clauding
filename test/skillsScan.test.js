// Finding skills scattered over the Mac and copying one into the main
// skills folder (electron/skillsScan.js). A fake home directory is built
// under the system temporary folder and handed to the scan, so nothing
// outside it is ever read: no Electron, no network, no real home.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SOURCE_MANIFEST_FILE,
  copySkillCandidate,
  hashFolderContents,
  readSourceManifest,
  scanForSkillCandidates,
  scanRootFolders,
  scanRootsFor
} from "../electron/skillsScan.js";

const scratchFolders = [];

after(() => {
  for (const folder of scratchFolders) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

function scratchFolder() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "clauding-skills-scan-"));
  scratchFolders.push(folder);
  return folder;
}

// A fake home from { "Documents/one/SKILL.md": "…" }: every folder on the
// way is created, so a test says only what it cares about.
function homeWith(files) {
  const homeDirectory = path.join(scratchFolder(), "home");
  for (const [relativePath, text] of Object.entries(files)) {
    const filePath = path.join(homeDirectory, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, text);
  }
  return homeDirectory;
}

function skillFile(name, description, body = "Some steps.") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function namesFound(result) {
  return result.candidates.map((candidate) => candidate.name).sort();
}

function candidateNamed(result, name) {
  return result.candidates.find((candidate) => candidate.name === name) || null;
}

test("a skill inside a project is found, with the name and description it declares", () => {
  const homeDirectory = homeWith({
    "Documents/website/.claude/skills/plan-writer/SKILL.md": skillFile(
      "plan-writer",
      "Writes the plan before touching anything."
    ),
    "Documents/website/README.md": "# Website\n"
  });
  const skillsRoot = path.join(homeDirectory, "SkillsMain");
  const result = scanForSkillCandidates({ homeDirectory, skillsRoot });

  assert.deepEqual(namesFound(result), ["plan-writer"]);
  const found = candidateNamed(result, "plan-writer");
  assert.equal(found.description, "Writes the plan before touching anything.");
  assert.equal(found.folder, path.join(homeDirectory, "Documents/website/.claude/skills/plan-writer"));
  assert.equal(found.filePath, path.join(found.folder, "SKILL.md"));
  assert.equal(found.sourceLabel, "projects");
  assert.equal(found.hermesFormat, false, "it has frontmatter, so it is a plain skill");
  assert.equal(found.alreadyAdded, false);
  assert.deepEqual(found.duplicatePaths, []);
  assert.match(found.contentHash, /^[0-9a-f]{64}$/);

  const documentsSource = result.sources.find((source) => source.folder === path.join(homeDirectory, "Documents"));
  assert.deepEqual(
    { label: documentsSource.label, found: documentsSource.found, truncated: documentsSource.truncated },
    { label: "projects", found: 1, truncated: false }
  );
});

test("package folders, build output and .git are never walked", () => {
  const homeDirectory = homeWith({
    "Documents/website/skills/real-one/SKILL.md": skillFile("real-one", "The one that counts."),
    "Documents/website/node_modules/some-package/skills/vendored/SKILL.md": skillFile("vendored", "Not hers."),
    "Documents/website/.git/skills/committed/SKILL.md": skillFile("committed", "Not hers either."),
    "Documents/website/dist/skills/built/SKILL.md": skillFile("built", "Output."),
    "Documents/website/.venv/skills/installed/SKILL.md": skillFile("installed", "A dependency.")
  });
  const result = scanForSkillCandidates({ homeDirectory, skillsRoot: path.join(homeDirectory, "SkillsMain") });
  assert.deepEqual(namesFound(result), ["real-one"]);
});

test("the walk stops at the depth a root allows", () => {
  const atTheLimit = "Documents/one/two/three/four/five/just-deep-enough/SKILL.md";
  const pastTheLimit = "Documents/one/two/three/four/five/six/buried/SKILL.md";
  const homeDirectory = homeWith({
    [atTheLimit]: skillFile("just-deep-enough", "Six folders under Documents."),
    [pastTheLimit]: skillFile("buried", "One folder too far.")
  });
  const result = scanForSkillCandidates({ homeDirectory, skillsRoot: path.join(homeDirectory, "SkillsMain") });
  assert.deepEqual(namesFound(result), ["just-deep-enough"]);
});

test("the same skill in two places is one entry; the same name with other contents is two", () => {
  const twin = skillFile("twin", "Two copies of one skill.");
  const homeDirectory = homeWith({
    "Documents/website/skills/twin/SKILL.md": twin,
    "Library/Application Support/Claude/skills/twin/SKILL.md": twin,
    "Documents/website/skills/forked/SKILL.md": skillFile("forked", "The first way of doing it."),
    "Documents/other/skills/forked-again/SKILL.md": skillFile("forked", "A different way of doing it.")
  });
  const result = scanForSkillCandidates({ homeDirectory, skillsRoot: path.join(homeDirectory, "SkillsMain") });

  const twins = result.candidates.filter((candidate) => candidate.name === "twin");
  assert.equal(twins.length, 1, "byte-for-byte the same skill is listed once");
  assert.equal(twins[0].folder, path.join(homeDirectory, "Documents/website/skills/twin"), "the first one found is kept");
  assert.deepEqual(twins[0].duplicatePaths, [
    path.join(homeDirectory, "Library/Application Support/Claude/skills/twin")
  ]);

  const forked = result.candidates.filter((candidate) => candidate.name === "forked");
  assert.equal(forked.length, 2, "one name, two different skills: the user picks");
  assert.notEqual(forked[0].contentHash, forked[1].contentHash);
});

test("a skill already in the main folder is marked, and only marked as changed when it differs", () => {
  const unchanged = skillFile("settled", "Nothing has moved.");
  const homeDirectory = homeWith({
    "Documents/website/skills/settled/SKILL.md": unchanged,
    "Documents/website/skills/drifted/SKILL.md": skillFile("drifted", "The newer wording."),
    "SkillsMain/settled/SKILL.md": unchanged,
    "SkillsMain/drifted/SKILL.md": skillFile("drifted", "The older wording."),
    "SkillsMain/homegrown/SKILL.md": skillFile("homegrown", "Written here, never copied.")
  });
  const result = scanForSkillCandidates({ homeDirectory, skillsRoot: path.join(homeDirectory, "SkillsMain") });

  const settled = candidateNamed(result, "settled");
  assert.equal(settled.alreadyAdded, true);
  assert.equal(settled.differsFromInstalled, false);

  const drifted = candidateNamed(result, "drifted");
  assert.equal(drifted.alreadyAdded, true);
  assert.equal(drifted.differsFromInstalled, true, "same name, other contents: she should see that it moved on");
});

test("a Hermes folder with one bare markdown file is found and marked as the other format", () => {
  const homeDirectory = homeWith({
    ".hermes/skills/note-taker/note-taker.md": "# Note taker\n\nTakes notes during a meeting.\n",
    ".hermes/skills/ambiguous/one.md": "# One\n",
    ".hermes/skills/ambiguous/two.md": "# Two\n"
  });
  const result = scanForSkillCandidates({ homeDirectory, skillsRoot: path.join(homeDirectory, "SkillsMain") });

  assert.deepEqual(namesFound(result), ["note-taker"], "two markdown files are not a skill, they are a folder");
  const noteTaker = candidateNamed(result, "note-taker");
  assert.equal(noteTaker.hermesFormat, true);
  assert.equal(noteTaker.sourceLabel, "hermes");
  assert.equal(noteTaker.filePath, path.join(homeDirectory, ".hermes/skills/note-taker/note-taker.md"));
  // No frontmatter, so the first block of the file stands in for the
  // description, its heading marks stripped — exactly what the skills list
  // itself shows for a SKILL.md written without frontmatter.
  assert.equal(noteTaker.description, "Note taker");
});

test("the main skills folder is never scanned, even when it sits inside a scanned one", () => {
  const homeDirectory = homeWith({
    "Documents/SkillsMain/already-mine/SKILL.md": skillFile("already-mine", "Copied here last week."),
    "Documents/website/skills/offerable/SKILL.md": skillFile("offerable", "Still somewhere else.")
  });
  const skillsRoot = path.join(homeDirectory, "Documents/SkillsMain");
  const roots = scanRootsFor({ homeDirectory, skillsRoot });
  assert.ok(!roots.some((root) => root.folder === skillsRoot), "the destination is not a source");
  assert.deepEqual(
    roots.map((root) => [root.label, root.folder, root.maxDepth]),
    [["projects", path.join(homeDirectory, "Documents"), 6]],
    "only the folders that exist are walked"
  );

  const result = scanForSkillCandidates({ homeDirectory, skillsRoot });
  assert.deepEqual(namesFound(result), ["offerable"]);
});

test("added folders are scanned too, and a root with nothing in it still reports itself", () => {
  const elsewhere = scratchFolder();
  fs.mkdirSync(path.join(elsewhere, "shared-skills", "borrowed"), { recursive: true });
  fs.writeFileSync(
    path.join(elsewhere, "shared-skills", "borrowed", "SKILL.md"),
    skillFile("borrowed", "From the folder she added by hand.")
  );
  const homeDirectory = homeWith({ "Documents/notes.txt": "nothing here" });
  const result = scanForSkillCandidates({
    homeDirectory,
    skillsRoot: path.join(homeDirectory, "SkillsMain"),
    extraRoots: [path.join(elsewhere, "shared-skills"), path.join(elsewhere, "not-there")]
  });

  assert.deepEqual(namesFound(result), ["borrowed"]);
  assert.equal(candidateNamed(result, "borrowed").sourceLabel, "added");
  assert.deepEqual(
    result.sources.map((source) => [source.label, source.found]),
    [
      ["projects", 0],
      ["added", 1]
    ],
    "the empty Documents root is still listed, and the folder that does not exist is not"
  );
});

test("the scan stops at the limit and says which source was cut short", () => {
  const homeDirectory = homeWith({
    "Documents/website/skills/one/SKILL.md": skillFile("one", "First."),
    "Documents/website/skills/two/SKILL.md": skillFile("two", "Second."),
    "Documents/website/skills/three/SKILL.md": skillFile("three", "Third.")
  });
  const result = scanForSkillCandidates({
    homeDirectory,
    skillsRoot: path.join(homeDirectory, "SkillsMain"),
    limit: 2
  });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.sources[0].truncated, true);
});

test("copying a candidate brings the whole folder over and leaves a note about where it came from", () => {
  const homeDirectory = homeWith({
    "Documents/website/skills/plan-writer/SKILL.md": skillFile("plan-writer", "Writes the plan."),
    "Documents/website/skills/plan-writer/references/checklist.md": "# Checklist\n\nOne, two, three.\n"
  });
  const skillsRoot = path.join(homeDirectory, "SkillsMain");
  const result = scanForSkillCandidates({ homeDirectory, skillsRoot });
  const candidate = candidateNamed(result, "plan-writer");

  const copied = copySkillCandidate({ candidate, skillsRoot });
  assert.equal(copied.copied, true);
  assert.equal(copied.folder, path.join(skillsRoot, "plan-writer"));
  assert.equal(fs.readFileSync(path.join(copied.folder, "references/checklist.md"), "utf8"), "# Checklist\n\nOne, two, three.\n");

  const manifest = readSourceManifest(copied.folder);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.sourceFolder, candidate.folder);
  assert.equal(manifest.sourceHash, candidate.contentHash);
  assert.ok(!Number.isNaN(Date.parse(manifest.copiedAt)), "the note says when it was copied");

  // The copy is now "already added", and the same hash, because the note it
  // left behind is not part of what is hashed.
  const second = scanForSkillCandidates({ homeDirectory, skillsRoot });
  const again = candidateNamed(second, "plan-writer");
  assert.equal(again.alreadyAdded, true);
  assert.equal(again.differsFromInstalled, false);
});

test("a second copy never writes over the folder that is already there", () => {
  const homeDirectory = homeWith({
    "Documents/website/skills/plan-writer/SKILL.md": skillFile("plan-writer", "The newer wording."),
    "SkillsMain/plan-writer/SKILL.md": skillFile("plan-writer", "The wording she kept."),
    "SkillsMain/plan-writer/her-own-notes.md": "# Hers\n"
  });
  const skillsRoot = path.join(homeDirectory, "SkillsMain");
  const candidate = candidateNamed(scanForSkillCandidates({ homeDirectory, skillsRoot }), "plan-writer");

  const skipped = copySkillCandidate({ candidate, skillsRoot });
  assert.deepEqual(skipped, {
    copied: false,
    skipped: true,
    reason: "exists",
    folder: path.join(skillsRoot, "plan-writer")
  });
  assert.match(fs.readFileSync(path.join(skillsRoot, "plan-writer/SKILL.md"), "utf8"), /wording she kept/);
  assert.ok(fs.existsSync(path.join(skillsRoot, "plan-writer/her-own-notes.md")), "her own file is still there");
  assert.equal(readSourceManifest(path.join(skillsRoot, "plan-writer")), null, "and nothing was written into it");

  const overwritten = copySkillCandidate({ candidate, skillsRoot, overwrite: true });
  assert.equal(overwritten.copied, true, "asked for on purpose, the copy goes ahead");
  assert.match(fs.readFileSync(path.join(skillsRoot, "plan-writer/SKILL.md"), "utf8"), /newer wording/);
});

test("the hash ignores the note left by a copy and does not care what was written first", () => {
  const firstFolder = path.join(scratchFolder(), "one");
  const secondFolder = path.join(scratchFolder(), "two");
  fs.mkdirSync(path.join(firstFolder, "references"), { recursive: true });
  fs.mkdirSync(path.join(secondFolder, "references"), { recursive: true });

  fs.writeFileSync(path.join(firstFolder, "SKILL.md"), skillFile("same", "Same skill."));
  fs.writeFileSync(path.join(firstFolder, "references/checklist.md"), "one, two\n");
  // The other way round, and with the note a copy leaves behind.
  fs.writeFileSync(path.join(secondFolder, "references/checklist.md"), "one, two\n");
  fs.writeFileSync(path.join(secondFolder, "SKILL.md"), skillFile("same", "Same skill."));
  fs.writeFileSync(path.join(secondFolder, SOURCE_MANIFEST_FILE), JSON.stringify({ version: 1 }));

  assert.equal(hashFolderContents(firstFolder), hashFolderContents(secondFolder));

  fs.writeFileSync(path.join(secondFolder, "references/checklist.md"), "one, two, three\n");
  assert.notEqual(hashFolderContents(firstFolder), hashFolderContents(secondFolder), "a changed file changes the hash");
  assert.equal(hashFolderContents(""), hashFolderContents(path.join(firstFolder, "no-such-folder")));
});

test("on Windows the scan looks where a Windows machine keeps skills", () => {
  const onWindows = scanRootFolders({
    homeDirectory: "C:\\Users\\ula",
    platform: "win32",
    environment: { APPDATA: "C:\\Users\\ula\\AppData\\Roaming" }
  });
  const folders = onWindows.map((root) => root.folder);
  assert.ok(folders.includes("C:\\Users\\ula\\.claude\\plugins"), "plugins live in the same place");
  assert.ok(folders.includes("C:\\Users\\ula\\AppData\\Roaming\\Claude"), "Claude Desktop keeps its copies here");
  assert.ok(folders.includes("C:\\Users\\ula\\.hermes\\skills"));
  assert.equal(
    folders.some((folder) => folder.includes("Library")),
    false,
    "the macOS folder is not even offered"
  );
  assert.equal(
    onWindows.find((root) => root.label === "hermes").kind,
    "hermes",
    "a Hermes folder is still allowed its bare markdown file"
  );
});

test("the real scan still uses the running system's roots", () => {
  const home = homeWith({ "Documents/a-skill/SKILL.md": skillFile("a-skill", "Does a thing.") });
  const roots = scanRootsFor({ homeDirectory: home, skillsRoot: path.join(home, ".claude", "skills") });
  assert.ok(
    roots.some((root) => root.folder === path.join(home, "Documents")),
    "no platform given means this machine's own"
  );
});
