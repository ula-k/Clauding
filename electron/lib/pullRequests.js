// Projects view: pull requests and their CI, through the GitHub CLI.
//
// One `gh pr list` per repository, all states, matched to tasks by the
// branch name (CU-<task id>). `gh` uses the user's own login; when it is not
// installed or not signed in, the cards say so and everything else works.
import { execFile } from "node:child_process";
import { gitTaskKey, taskIdFromBranch } from "./gitInspector.js";

const PULL_REQUEST_LIMIT = 200;
const GH_TIMEOUT_MILLISECONDS = 30000;
const GH_FIELDS = "number,title,headRefName,baseRefName,state,url,isDraft,updatedAt,statusCheckRollup";

// statusCheckRollup → "passing" | "failing" | "pending" | "none"
export function ciStateFrom(checks) {
  const list = Array.isArray(checks) ? checks : [];
  if (list.length === 0) {
    return "none";
  }
  let pending = false;
  for (const check of list) {
    // Check runs carry status + conclusion; commit statuses carry state.
    const conclusion = String(check.conclusion || check.state || "").toUpperCase();
    const status = String(check.status || "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) {
      return "failing";
    }
    if ((status && status !== "COMPLETED") || conclusion === "PENDING" || conclusion === "EXPECTED" || conclusion === "") {
      pending = true;
    }
  }
  return pending ? "pending" : "passing";
}

// gh's JSON → { "<taskId>": [pullRequest…] }, newest first.
// With `allBranches` (a project without ClickUp) every pull request counts,
// keyed the way its branch is (gitTaskKey).
export function pullRequestsByTask(repositoryName, pullRequests, { allBranches = false } = {}) {
  const byTask = {};
  for (const pull of pullRequests || []) {
    const taskId = allBranches ? gitTaskKey(pull.headRefName) : taskIdFromBranch(pull.headRefName);
    if (!taskId) {
      continue;
    }
    (byTask[taskId] ||= []).push({
      repository: repositoryName,
      number: pull.number,
      title: pull.title || "",
      branch: pull.headRefName,
      base: pull.baseRefName,
      state: String(pull.state || "").toLowerCase(),
      draft: Boolean(pull.isDraft),
      url: pull.url,
      updatedAt: pull.updatedAt || null,
      ci: ciStateFrom(pull.statusCheckRollup)
    });
  }
  for (const list of Object.values(byTask)) {
    list.sort((first, second) => String(second.updatedAt).localeCompare(String(first.updatedAt)));
  }
  return byTask;
}

// { available, reason, byTask }. reason: "gh-missing" | "gh-signed-out" | "gh-failed"
export function listPullRequests(repository, { execFileImplementation = execFile, allBranches = false } = {}) {
  const { name, githubSlug, localPath } = repository;
  const repositoryArguments = githubSlug ? ["--repo", githubSlug] : [];
  return new Promise((resolve) => {
    execFileImplementation(
      "gh",
      ["pr", "list", ...repositoryArguments, "--state", "all", "--limit", String(PULL_REQUEST_LIMIT), "--json", GH_FIELDS],
      { timeout: GH_TIMEOUT_MILLISECONDS, maxBuffer: 16 * 1024 * 1024, cwd: localPath || undefined },
      (error, standardOutput, standardError) => {
        if (error) {
          const text = `${standardError || ""} ${error.message || ""}`;
          let reason = "gh-failed";
          if (error.code === "ENOENT") {
            reason = "gh-missing";
          } else if (/auth login|not logged|authenticat/i.test(text)) {
            reason = "gh-signed-out";
          }
          resolve({ available: false, reason, byTask: {} });
          return;
        }
        try {
          resolve({ available: true, reason: null, byTask: pullRequestsByTask(name, JSON.parse(standardOutput || "[]"), { allBranches }) });
        } catch (parseError) {
          resolve({ available: false, reason: "gh-failed", byTask: {} });
        }
      }
    );
  });
}
