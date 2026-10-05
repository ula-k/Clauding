// The Clauding mod: Claude Code function hooks that Clauding loads into the
// `claude` processes it starts itself (with `--plugin-dir`, never installed
// anywhere). Outside a Clauding terminal — no CLAUDING_TERMINAL_ID in the
// environment — every hook passes straight through and nothing is drawn.
//
// What it does, each switchable in Clauding's Settings → "Clauding mod":
//
//   state reports   turn.start / turn.complete / the question dialog / a
//                   permission prompt → `clauding state <terminal> <state>`,
//                   so the app's NEEDS ANSWER tag and status dot know at
//                   once instead of guessing from files.
//                   States: working, needs-answer, needs-permission, done, idle.
//   status line     `CU-<task> · <branch> · <n>% context` under the prompt;
//                   the task and branch come from the app
//                   (`clauding session-info <terminal>`), the context from
//                   $.session.usage().
//   context bar     the context left, as a colored bar above the prompt
//                   (after the token-weather sample); a warning from 80 % used.
//   command guard   a Bash command matching one of the guard's rules
//                   (commandGuard.js; the rules are edited in Settings) is
//                   held and the user is asked "Run" / "Cancel" in the CLI's
//                   own question dialog (after the blast-radius sample);
//                   Cancel answers Claude with a refusal instead of running it.
//
// Plain JavaScript on purpose (Clauding has no TypeScript). The host reads
// `on(...)` and `$.noun.method(...)` from the source, so they are spelled
// literally, and every helper that takes `$` is a top-level function.
import { textAsksSomething } from "./questionHeuristic.js";
import {
  DEFAULT_GUARD_PATTERNS,
  declinedMessage,
  effectiveFolder,
  findRiskyCommand,
  parseGuardPatterns,
  positionalArguments
} from "./commandGuard.js";

const NO_TASK = "—";
const INFO_REFRESH_MILLISECONDS = 30000;
const COMMAND_TIMEOUT_MILLISECONDS = 8000;
const CONTEXT_WARNING_PERCENT = 80;
const DETAIL_CHARACTERS = 160;
const RUN_LABEL = "Run";
const CANCEL_LABEL = "Cancel";

// Module state. A hot reload starts it over; session.start fires again then.
let terminalLookup = null;
let lastReportedState = null;
let sessionInfo = null;
let contextReading = null;
let infoTimerStop = null;

export function register(on) {
  on("session.start", async ($, event, next) => {
    const started = await next(event);
    const terminalId = await claudingTerminal($);
    if (!terminalId) {
      return started;
    }
    lastReportedState = null;
    await reportState($, "idle", "");
    await refreshSessionInfo($);
    await takeContextReading($);
    if (infoTimerStop) {
      infoTimerStop();
    }
    infoTimerStop = $.clock.every(INFO_REFRESH_MILLISECONDS, () => {
      refreshSessionInfo($).catch(() => {});
    });
    return started;
  });

  on("turn.start", async ($, event, next) => {
    const started = await next(event);
    if (await claudingTerminal($)) {
      await reportState($, "working", "");
    }
    return started;
  });

  on("turn.complete", async ($, event, next) => {
    const completed = await next(event);
    if (event.agentId || !(await claudingTerminal($))) {
      return completed;
    }
    if (event.isAborted) {
      await reportState($, "idle", "interrupted");
    } else if (textAsksSomething(event.answer)) {
      await reportState($, "needs-answer", lastLineOf(event.answer));
    } else {
      await reportState($, "done", "");
    }
    await takeContextReading($);
    await refreshSessionInfo($);
    return completed;
  });

  // Claude's own question dialog, and the guard's: the session waits on the
  // user until it is answered.
  on("tool.call", { tool: "AskUserQuestion" }, async ($, event, next) => {
    if (!(await claudingTerminal($))) {
      return next(event);
    }
    await reportState($, "needs-answer", questionOf(event));
    const answered = await next(event);
    await reportState($, "working", "");
    return answered;
  });

  // A permission prompt is about to be shown. The question dialog asks for
  // a permission too, but it is a question: it stays needs-answer.
  on("classic.PermissionRequest", async ($, event, next) => {
    if (event.tool_name !== "AskUserQuestion" && (await claudingTerminal($))) {
      await reportState($, "needs-permission", String(event.tool_name || ""));
    }
    return next(event);
  });

  // The prompt was answered: the tool ran, failed, or was refused.
  on("classic.PostToolUse", async ($, event, next) => {
    await backToWorking($);
    return next(event);
  });
  on("classic.PostToolUseFailure", async ($, event, next) => {
    await backToWorking($);
    return next(event);
  });
  on("classic.PermissionDenied", async ($, event, next) => {
    await backToWorking($);
    return next(event);
  });

  on("tool.call", { tool: "Bash" }, async ($, event, next) => {
    if (!(await claudingTerminal($)) || !featureIsOn("guard")) {
      return next(event);
    }
    const command = String(event.command || "");
    const workingDirectory = await $.session.cwd();
    const temporaryFolder = await $.env.get("TMPDIR");
    const patternText = sessionInfo && sessionInfo.mod && typeof sessionInfo.mod.guardPatterns === "string"
      ? sessionInfo.mod.guardPatterns
      : DEFAULT_GUARD_PATTERNS;
    const currentBranch = /\bgit\b.*\bpush\b/.test(command) ? await gitLine($, ["git", "rev-parse", "--abbrev-ref", "HEAD"], workingDirectory) : null;
    const risky = findRiskyCommand(command, {
      patterns: parseGuardPatterns(patternText).patterns,
      currentBranch,
      workingDirectory,
      scratchRoots: temporaryFolder ? [temporaryFolder] : []
    });
    if (!risky) {
      return next(event);
    }
    const folder = effectiveFolder(command, risky, workingDirectory);
    const summary = await summarizeRisk($, risky, folder);
    // Cancel is the first option, so anything that picks a default (or the
    // first row) picks the safe one; Run has to be chosen.
    let answer = CANCEL_LABEL;
    try {
      answer = await $.ui.ask(`Clauding guard: \`${shorten(risky.segment, 120)}\` would ${summary}. Run it?`, {
        options: [CANCEL_LABEL, RUN_LABEL],
        header: "Guard"
      });
    } catch {
      // Dismissed, or nobody to ask: the safe answer stands.
    }
    if (answer !== RUN_LABEL) {
      $.ui.log(`Clauding guard: not run (${shorten(answer, 40) || "no answer"}) — ${shorten(risky.segment, 80)}`);
      $.ui.toast("Clauding guard: cancelled, Claude was told");
      return { deny: declinedMessage(summary) };
    }
    $.ui.log(`Clauding guard: Run chosen — ${shorten(risky.segment, 80)}`);
    $.ui.toast("Clauding guard: running it");
    return next(event);
  });

  on("ui.render", { component: "AbovePrompt" }, ($, event, next) => {
    if (!terminalLookup || !terminalLookup.terminalId || !featureIsOn("contextBar") || contextReading === null) {
      return next(event);
    }
    const props = event.props || {};
    if (props.hasSurvey) {
      return next(event);
    }
    const { Box, Text } = $.ui.resolve(event);
    return contextBar(Box, Text, props.bodyColumns || 80);
  });
}

// ---- talking to the app ----------------------------------------------------

// The terminal this `claude` runs in, read once per load: null outside
// Clauding, which turns every hook into a pass-through.
async function claudingTerminal($) {
  if (terminalLookup === null) {
    const value = await $.env.get("CLAUDING_TERMINAL_ID");
    terminalLookup = { terminalId: value ? String(value) : null };
  }
  return terminalLookup.terminalId;
}

function featureIsOn(name) {
  const switches = sessionInfo && sessionInfo.mod ? sessionInfo.mod : null;
  return !switches || switches[name] !== false;
}

// One state change, sent once: the same state twice in a row is not news.
async function reportState($, state, detail) {
  const terminalId = await claudingTerminal($);
  if (!terminalId || !featureIsOn("stateReports") || state === lastReportedState) {
    return;
  }
  lastReportedState = state;
  const command = ["clauding", "state", terminalId, state];
  if (detail) {
    command.push(shorten(detail, DETAIL_CHARACTERS));
  }
  try {
    await $.process.run(command, { timeoutMs: COMMAND_TIMEOUT_MILLISECONDS });
  } catch {
    // The app is gone or busy; it falls back to reading the transcript.
  }
}

async function backToWorking($) {
  if (lastReportedState === "needs-permission" || lastReportedState === "needs-answer") {
    await reportState($, "working", "");
  }
}

// The task, branch and switches the app knows for this terminal.
async function refreshSessionInfo($) {
  const terminalId = await claudingTerminal($);
  if (!terminalId) {
    return;
  }
  try {
    const run = await $.process.run(["clauding", "session-info", terminalId], { timeoutMs: COMMAND_TIMEOUT_MILLISECONDS });
    if (run.exitCode === 0) {
      sessionInfo = JSON.parse(run.stdout);
    }
  } catch {
    // Keep what was known.
  }
  showStatusLine($);
}

async function takeContextReading($) {
  try {
    const { context } = await $.session.usage();
    if (context && context.window) {
      const tokens = context.tokens || 0;
      const percent = Math.round(context.percent ?? (tokens / context.window) * 100);
      contextReading = { tokens, window: context.window, percent };
    }
  } catch {
    // No reading this time; the last one stays.
  }
  showStatusLine($);
  $.ui.invalidate("ui.render");
}

function showStatusLine($) {
  if (!featureIsOn("statusLine")) {
    $.ui.status(undefined);
    return;
  }
  const task = sessionInfo && sessionInfo.task ? sessionInfo.task.label : NO_TASK;
  const branch = sessionInfo && sessionInfo.branch ? sessionInfo.branch : "no branch";
  const context = contextReading ? `${contextReading.percent}% context` : "context —";
  $.ui.status(`${task} · ${branch} · ${context}`);
}

// ---- the guard's one-line summary ----------------------------------------

async function gitLine($, command, folder) {
  try {
    const run = await $.process.run(command, { cwd: folder || undefined, timeoutMs: COMMAND_TIMEOUT_MILLISECONDS });
    return run.exitCode === 0 ? run.stdout.trim() : null;
  } catch {
    return null;
  }
}

async function countLines($, command, folder, keep) {
  try {
    const run = await $.process.run(command, { cwd: folder || undefined, timeoutMs: COMMAND_TIMEOUT_MILLISECONDS });
    return run.stdout.split("\n").filter((line) => line !== "" && keep(line)).length;
  } catch {
    return null;
  }
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// What the command would change, in a few words, measured where it would run.
async function summarizeRisk($, risky, folder) {
  const positional = positionalArguments(risky.words);
  const branch = risky.kind.startsWith("git") ? (await gitLine($, ["git", "rev-parse", "--abbrev-ref", "HEAD"], folder)) || "the current branch" : "";
  if (risky.kind === "git-reset") {
    const changed = await countLines($, ["git", "status", "--porcelain"], folder, (line) => !line.startsWith("??"));
    if (changed === null) {
      return `hard-reset ${branch}`;
    }
    return changed === 0 ? `hard-reset ${branch} (no uncommitted changes to lose)` : `discard uncommitted changes in ${plural(changed, "file")} on ${branch}`;
  }
  if (risky.kind === "git-clean") {
    const removed = await countLines($, ["git", "clean", "-n", "-d"], folder, (line) => line.startsWith("Would remove"));
    if (removed === null) {
      return "delete untracked files";
    }
    return removed === 1 ? "delete 1 untracked file or folder" : `delete ${removed} untracked files or folders`;
  }
  if (risky.kind === "git-push") {
    const remote = positional[0] || "origin";
    const target = positional[1] ? positional[1].replace(/^\+/, "").split(":").pop() : branch;
    const forced = risky.words.some((word) => word === "-f" || word.startsWith("--force"));
    return `push ${branch} to ${remote}/${target}${forced ? " with force (rewrites its history)" : ""}`;
  }
  if (risky.kind === "git-merge") {
    return `merge ${positional.join(" ") || "the upstream"} into ${branch}`;
  }
  if (risky.kind === "git-rebase") {
    return `rebase ${branch} onto ${positional.join(" ") || "its upstream"}`;
  }
  if (risky.kind === "git-branch") {
    return `delete the branch ${positional[0] || "named"} even if it is not merged`;
  }
  if (risky.kind === "rm") {
    const targets = risky.targets.length > 0 ? risky.targets : ["(nothing named)"];
    const files = await countLines($, ["find", ...targets, "-type", "f"], folder, () => true);
    return files === null ? `delete ${targets.join(" ")}` : `delete ${plural(files, "file")} under ${shorten(targets.join(" "), 60)}`;
  }
  return `change data irreversibly (${shorten(risky.text, 60)})`;
}

// ---- drawing ----------------------------------------------------------------

// The context left as a bar: green while most of it is free, yellow from
// half, red with a warning from 80 % used.
function contextBar(Box, Text, columns) {
  const used = Math.max(0, Math.min(100, contextReading.percent));
  const left = 100 - used;
  const width = Math.max(10, Math.min(30, columns - 50));
  const filled = Math.round((left / 100) * width);
  const color = used >= CONTEXT_WARNING_PERCENT ? "red" : used >= 50 ? "yellow" : "green";
  const parts = [
    Text({ key: "label", dimColor: true, children: "Context " }),
    Text({ key: "bar", color, children: `${"█".repeat(filled)}${"░".repeat(width - filled)}` }),
    Text({ key: "left", color, bold: used >= CONTEXT_WARNING_PERCENT, children: ` ${left}% left` }),
    Text({ key: "tokens", dimColor: true, children: `  ${shortNumber(contextReading.tokens)} / ${shortNumber(contextReading.window)}` })
  ];
  if (used >= CONTEXT_WARNING_PERCENT) {
    parts.push(Text({ key: "warning", color: "red", children: "  ⚠ over 80% used — consider /compact" }));
  }
  return Box({ flexDirection: "row", paddingX: 1, children: parts });
}

function shortNumber(count) {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${Math.round(count / 1000)}k`;
  }
  return String(count);
}

function shorten(text, characters) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > characters ? `${value.slice(0, characters - 1)}…` : value;
}

function lastLineOf(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] || "";
}

function questionOf(event) {
  const questions = Array.isArray(event.questions) ? event.questions : [];
  return questions.length > 0 && questions[0] && questions[0].question ? String(questions[0].question) : "question dialog";
}
