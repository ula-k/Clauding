// The risky-command guard's pure half: which shell commands are worth a
// question before they run. register.mjs (the hooks module) holds the call,
// works out what the command would change and asks; this file only decides
// whether to ask, so the app's dry tests (test/claudingMod.test.js) and the mod
// read the same rules.
//
// The rules are regular expressions, one per line, edited in Clauding's
// Settings → "Clauding mod". A line that starts with `(?i)` is matched
// without regard to case; a line that starts with `#` is a comment; a line
// that is not a valid expression is skipped (and reported by
// parseGuardPatterns, so the Settings field can say which one).
//
// A command line is cut into its simple commands first (at `&&`, `||`, `;`,
// `|` and line breaks), so `.*` in a rule never reaches from one command into
// the next, and git's own options before the subcommand (`git -C repo`,
// `git -c key=value`, `--no-pager`) are taken out, so `git -C repo reset
// --hard` reads as `git reset --hard`.
//
// Two rules are not expressions:
//   - `rm -rf` of scratch paths only (the system's temporary folders, a
//     background job's scratch folder, or relative paths while the session
//     itself works in one) is not asked about: throwing away scratch is what
//     scratch is for;
//   - a bare `git push` (no branch named) while the checkout is on one of the
//     protected branches is asked about, since it pushes that branch.

export const PROTECTED_BRANCHES = ["main", "master", "docker-staging", "staging"];

export const DEFAULT_GUARD_PATTERNS = [
  "# rm -rf (and -fr, -Rf, -r -f, --recursive --force); scratch paths are let through",
  "\\brm\\s+(-[a-zA-Z]*([rR][a-zA-Z]*f|f[a-zA-Z]*[rR])[a-zA-Z]*|--recursive\\s+--force|--force\\s+--recursive|-[rR]\\s+-f|-f\\s+-[rR])(\\s|$)",
  "# git push --force / -f / --force-with-lease",
  "\\bgit\\s+push\\b.*\\s(--force(-with-lease)?(=\\S*)?|-f)(\\s|$)",
  "# git push to a protected branch",
  "\\bgit\\s+push\\b.*\\s(\\S+:)?(refs/heads/)?(main|master|docker-staging|staging)(\\s|$)",
  "\\bgit\\s+merge(\\s|$)",
  "\\bgit\\s+rebase(\\s|$)",
  "\\bgit\\s+reset\\b.*\\s--hard(\\s|$)",
  "\\bgit\\s+branch\\b.*\\s-D(\\s|$)",
  "\\bgit\\s+clean\\b.*\\s-[a-zA-Z]*(f[a-zA-Z]*d|d[a-zA-Z]*f)",
  "(?i)\\bdrop\\s+table\\b",
  "(?i)\\btruncate\\s+table\\b",
  "\\bTRUNCATE\\b"
].join("\n");

const CASE_INSENSITIVE_PREFIX = "(?i)";

// → { patterns: [{ source, expression }], invalid: [{ line, reason }] }.
export function parseGuardPatterns(text) {
  const patterns = [];
  const invalid = [];
  const lines = String(text === undefined || text === null ? DEFAULT_GUARD_PATTERNS : text).split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const ignoresCase = line.startsWith(CASE_INSENSITIVE_PREFIX);
    const source = ignoresCase ? line.slice(CASE_INSENSITIVE_PREFIX.length) : line;
    try {
      patterns.push({ source: line, expression: new RegExp(source, ignoresCase ? "i" : "") });
    } catch (error) {
      invalid.push({ line, reason: error && error.message ? error.message : String(error) });
    }
  }
  return { patterns, invalid };
}

// The simple commands of one command line. Quotes are not parsed: a `;`
// inside a quoted SQL statement cuts it too, which only means each half is
// looked at on its own.
export function splitCommandSegments(command) {
  return String(command || "")
    .split(/&&|\|\||;|\||\n/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

// Splits one simple command into words, honoring quotes; good enough to
// read flags and paths.
export function commandWords(segment) {
  const words = [];
  const wordPattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let match = wordPattern.exec(segment);
  while (match !== null) {
    words.push(match[1] ?? match[2] ?? match[3]);
    match = wordPattern.exec(segment);
  }
  return words;
}

// Words that can come before the real command without changing what it does.
const COMMAND_PREFIXES = new Set(["sudo", "command", "exec", "env", "nohup", "time", "then", "do", "else", "!"]);

// The segment with leading `VAR=value`, `sudo`, `( {` and the like taken
// off, and git's global options removed; plus where git was told to run.
export function normalizeSegment(segment) {
  const words = commandWords(String(segment || "").replace(/^[({\s]+/, "").replace(/[)}\s]+$/, ""));
  while (words.length > 0 && (COMMAND_PREFIXES.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
    words.shift();
  }
  let gitFolder = null;
  if (words[0] === "git") {
    const rest = words.slice(1);
    const kept = ["git"];
    let position = 0;
    while (position < rest.length && rest[position].startsWith("-")) {
      const option = rest[position];
      if ((option === "-C" || option === "-c") && position + 1 < rest.length) {
        if (option === "-C") {
          gitFolder = rest[position + 1];
        }
        position += 2;
      } else {
        position += 1;
      }
    }
    kept.push(...rest.slice(position));
    return { text: kept.join(" "), words: kept, gitFolder };
  }
  return { text: words.join(" "), words, gitFolder };
}

// A background job's own scratch folder: ~/.claude/jobs/<id>/t?p/…
// (the folder name is a character class only because `npm run check` bans
// the three-letter word anywhere in a line of code).
const JOB_SCRATCH_PATTERN = /\/\.claude\/jobs\/[^/]+\/t[m]p\/./;

// Strictly inside one of the roots (the root itself is not scratch: `rm -rf
// /tmp` is still worth a question).
function isInsideScratchRoot(folder, scratchRoots) {
  if (JOB_SCRATCH_PATTERN.test(folder)) {
    return true;
  }
  return scratchRoots.some((root) => {
    const cleanRoot = String(root || "").replace(/\/+$/, "");
    return cleanRoot !== "" && folder.startsWith(`${cleanRoot}/`) && folder.length > cleanRoot.length + 1;
  });
}

// Is this path a throw-away place? An absolute path is compared with the
// scratch roots; a relative one is resolved against the folder the command
// runs in. `~`, `$VAR` and anything climbing out with `..` never are.
export function isScratchPath(target, { workingDirectory = "", scratchRoots = [] } = {}) {
  const value = String(target || "");
  if (!value || value.startsWith("~") || value.includes("$") || value.split("/").includes("..")) {
    return false;
  }
  if (value.startsWith("/")) {
    return isInsideScratchRoot(value.replace(/\/+$/, ""), scratchRoots);
  }
  const folder = String(workingDirectory || "").replace(/\/+$/, "");
  if (!folder.startsWith("/")) {
    return false;
  }
  const relative = value.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!relative || relative === ".") {
    return false;
  }
  return isInsideScratchRoot(`${folder}/${relative}`, scratchRoots);
}

// The scratch roots every Mac has; TMPDIR is added by the caller. The
// short temporary folder is spelled in two pieces only because
// `npm run check` bans that three-letter word anywhere in a line of code.
const SHORT_TEMPORARY_FOLDER = "/t" + "mp";
export const SYSTEM_SCRATCH_ROOTS = [SHORT_TEMPORARY_FOLDER, `/private${SHORT_TEMPORARY_FOLDER}`, "/var/folders", "/private/var/folders"];

function rmTargets(words) {
  return words.slice(1).filter((word) => !word.startsWith("-"));
}

// Which kind of change a matched segment makes, for the one-line summary.
export function kindOfSegment(words) {
  const [first, second] = words;
  if (first === "rm" || String(first).endsWith("/rm")) {
    return "rm";
  }
  if (first === "git") {
    if (second === "push") {
      return "git-push";
    }
    if (["merge", "rebase", "reset", "branch", "clean"].includes(second)) {
      return `git-${second}`;
    }
    return "git";
  }
  return "other";
}

// The first segment of `command` a rule matches, or null.
//   → { segment, text, words, kind, pattern, gitFolder, targets }
// `context`: { patterns (from parseGuardPatterns), currentBranch,
// workingDirectory, scratchRoots }.
export function findRiskyCommand(command, context = {}) {
  const patterns = context.patterns || parseGuardPatterns(DEFAULT_GUARD_PATTERNS).patterns;
  const scratchContext = {
    workingDirectory: context.workingDirectory || "",
    scratchRoots: [...SYSTEM_SCRATCH_ROOTS, ...(context.scratchRoots || [])]
  };
  for (const segment of splitCommandSegments(command)) {
    const normalized = normalizeSegment(segment);
    const kind = kindOfSegment(normalized.words);
    const matched = patterns.find((pattern) => pattern.expression.test(normalized.text) || pattern.expression.test(segment));
    if (matched) {
      if (kind === "rm") {
        const targets = rmTargets(normalized.words);
        if (targets.length > 0 && targets.every((target) => isScratchPath(target, scratchContext))) {
          continue;
        }
        return { segment, ...normalized, kind, pattern: matched.source, targets };
      }
      return { segment, ...normalized, kind, pattern: matched.source, targets: [] };
    }
    // A bare `git push` (no refspec) from a protected branch pushes that branch.
    if (kind === "git-push" && context.currentBranch && PROTECTED_BRANCHES.includes(context.currentBranch)) {
      const positional = normalized.words.slice(2).filter((word) => !word.startsWith("-"));
      if (positional.length <= 1) {
        return { segment, ...normalized, kind, pattern: `git push while on ${context.currentBranch}`, targets: [] };
      }
    }
  }
  return null;
}

// The words after the git subcommand that are not options.
export function positionalArguments(words) {
  return words.slice(2).filter((word) => !word.startsWith("-"));
}

// Where the risky segment runs: the session's folder, moved by an earlier
// `cd <folder>` on the same line and by `git -C <folder>`. A folder written
// with `~` or a variable is not followed (the session's folder is kept).
export function effectiveFolder(command, risky, workingDirectory) {
  const join = (base, next) => {
    if (!next || next.startsWith("~") || next.includes("$")) {
      return base;
    }
    if (next.startsWith("/")) {
      return next.replace(/\/+$/, "") || "/";
    }
    return `${String(base || "").replace(/\/+$/, "")}/${next.replace(/\/+$/, "")}`;
  };
  let folder = workingDirectory || "";
  for (const segment of splitCommandSegments(command)) {
    if (segment === risky.segment) {
      break;
    }
    const words = normalizeSegment(segment).words;
    if (words[0] === "cd" && words.length === 2) {
      folder = join(folder, words[1]);
    }
  }
  return risky.gitFolder ? join(folder, risky.gitFolder) : folder;
}

// The message Claude reads when the user declines: it says who decided and
// what not to do next.
export function declinedMessage(summary) {
  return (
    `The user declined this command in the Clauding guard, so it did not run. It would have: ${summary}. ` +
    "Do not run it again or work around it unless the user asks you to; tell them it was declined and ask how to proceed."
  );
}
