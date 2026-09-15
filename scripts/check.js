// `npm run check`: syntax-checks every JavaScript file and flags identifiers
// that break the house naming rules (single letters, jargon abbreviations).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const foldersToScan = ["electron", "scripts", "src"];
const bannedWords = /\b(ctx|opts|fn|tmp|cfg|msg|res|req|evt|dir|idx|len|arr|obj|str|num|val|params|args|cb|el|elem|btn|img)\b/;
const singleLetterArrow = /\(\s*[a-zA-Z_]\s*\)\s*=>|\b[a-zA-Z_]\s*=>/;
const singleLetterDeclaration = /\b(const|let|var|function)\s+[a-zA-Z_]\b/;
const singleLetterLoop = /\bfor\s*\(\s*(const|let|var)\s+[a-zA-Z_]\b/;

function collectFiles(folder) {
  const found = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectFiles(fullPath));
    } else if (/\.(js|cjs|mjs|jsx)$/.test(entry.name)) {
      found.push(fullPath);
    }
  }
  return found;
}

let problems = 0;
for (const folder of foldersToScan) {
  for (const filePath of collectFiles(path.join(projectRoot, folder))) {
    const relativePath = path.relative(projectRoot, filePath);
    if (relativePath === path.join("scripts", "check.js")) {
      continue;
    }
    if (!filePath.endsWith(".jsx")) {
      try {
        execFileSync(process.execPath, ["--check", filePath], { stdio: "pipe" });
      } catch (error) {
        problems += 1;
        console.log(`${relativePath}: syntax error\n${error.stderr}`);
      }
    }
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    for (const [lineIndex, line] of lines.entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
        continue;
      }
      const checks = [
        [bannedWords, "banned abbreviation"],
        [singleLetterArrow, "single-letter arrow parameter"],
        [singleLetterDeclaration, "single-letter declaration"],
        [singleLetterLoop, "single-letter loop variable"]
      ];
      for (const [pattern, label] of checks) {
        if (pattern.test(line)) {
          problems += 1;
          console.log(`${relativePath}:${lineIndex + 1}: ${label}: ${trimmed}`);
        }
      }
    }
  }
}

if (problems === 0) {
  console.log("All files pass.");
} else {
  console.log(`${problems} problem(s) found.`);
  process.exit(1);
}
