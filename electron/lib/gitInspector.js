// Projects view: what the user's own checkouts say about each task's branch.
//
// Branches are named CU-<ClickUp task id>, sometimes with a suffix
// (CU-abc123aa1-1, CU-abc123aa1-team-dashboard), in any case (cu-…, Cu-…),
// and sometimes under a folder (someone/CU-abc123aa1). For every configured repo
// this reads, locally and without touching anything:
//   - which CU- branches exist, locally and on origin
//   - which of them are checked out in a worktree, and whether that
//     worktree has uncommitted changes
//   - how many commits each is ahead of the base branch (per repository, "main" by default)
//   - whether it has already reached the staging branch (per repository, "staging" by default)
//
// Only commands that read. `git fetch` is a separate function the view
// calls on the user's ↻ click and nowhere else: fetching updates
// remote-tracking refs, never the user's branches or files.
//
// A project without ClickUp (see lib/gitTasks.js) has no task ids to look
// for: `allBranches` then reads every feature branch — anything that is not
// one of the long-lived branches below — and keys each by gitTaskKey().
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

const BRANCH_PATTERN = /^CU-([0-9a-z]+)(?:[-_][0-9a-z_.-]*)?$/i;
const GIT_TIMEOUT_MILLISECONDS = 20000;
// Branches that live for the whole life of a repository are never "a piece
// of work". The repository's own base and staging branches are added to
// these per repository.
export const LONG_LIVED_BRANCHES = ["main", "master", "develop", "development", "dev", "staging", "production", "prod", "gh-pages", "HEAD"];
// The candidates for a repository's base and staging branch, in order of
// preference, when a project is set up.
export const BASE_BRANCH_CANDIDATES = ["main", "master", "trunk"];
export const STAGING_BRANCH_CANDIDATES = ["staging", "develop", "development", "dev"];

export function taskIdFromBranch(branchName) {
  const shortName = String(branchName || "").replace(/^refs\/(heads|remotes\/[^/]+)\//, "");
  const lastPart = shortName.split("/").pop();
  const match = lastPart.match(BRANCH_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

// The key a branch is known by in a project without ClickUp: its CU- id when
// it has one, else "git-" and a short hash of the name (a branch name can be
// long and full of slashes; the key has to fit where a task id fits).
export function gitTaskKey(branchName) {
  const taskId = taskIdFromBranch(branchName);
  if (taskId) {
    return taskId;
  }
  return `git-${createHash("sha1").update(String(branchName || "")).digest("hex").slice(0, 12)}`;
}

export function runGit(repositoryPath, gitArguments, { execFileImplementation = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImplementation(
      "git",
      ["-C", repositoryPath, ...gitArguments],
      { timeout: GIT_TIMEOUT_MILLISECONDS, maxBuffer: 8 * 1024 * 1024 },
      (error, standardOutput, standardError) => {
        if (error) {
          error.standardError = String(standardError || "");
          reject(error);
          return;
        }
        resolve(String(standardOutput || ""));
      }
    );
  });
}

// `git for-each-ref --format='%(refname)'` output → CU branches, one entry
// per branch name, remembering where it exists.
export function parseBranchRefs(output, remoteName = "origin", { allBranches = false, excluded = [] } = {}) {
  const branches = new Map();
  const skipped = new Set([...LONG_LIVED_BRANCHES, ...excluded].map((name) => String(name).toLowerCase()));
  for (const line of String(output || "").split("\n")) {
    const reference = line.trim();
    if (!reference) {
      continue;
    }
    let branchName = null;
    let where = null;
    if (reference.startsWith("refs/heads/")) {
      branchName = reference.slice("refs/heads/".length);
      where = "local";
    } else if (reference.startsWith(`refs/remotes/${remoteName}/`)) {
      branchName = reference.slice(`refs/remotes/${remoteName}/`.length);
      where = "remote";
    }
    if (!branchName) {
      continue;
    }
    if (allBranches ? skipped.has(branchName.toLowerCase()) : !taskIdFromBranch(branchName)) {
      continue;
    }
    const taskId = allBranches ? gitTaskKey(branchName) : taskIdFromBranch(branchName);
    const entry = branches.get(branchName) || { name: branchName, taskId, local: false, remote: false };
    entry[where] = true;
    branches.set(branchName, entry);
  }
  return [...branches.values()];
}

// `git worktree list --porcelain` → [{ path, branch }]
export function parseWorktrees(output) {
  const worktrees = [];
  let current = null;
  for (const line of String(output || "").split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      worktrees.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  return worktrees;
}

async function commitsAhead(repositoryPath, reference, baseReference, options) {
  try {
    const output = await runGit(repositoryPath, ["rev-list", "--count", `${baseReference}..${reference}`], options);
    return Number(output.trim()) || 0;
  } catch (error) {
    return null;
  }
}

async function isAncestor(repositoryPath, reference, targetReference, options) {
  try {
    await runGit(repositoryPath, ["merge-base", "--is-ancestor", reference, targetReference], options);
    return true;
  } catch (error) {
    // Exit code 1 means "not an ancestor"; anything else (a missing ref)
    // means we cannot tell, which the card shows as unknown.
    return error.code === 1 ? false : null;
  }
}

async function hasUncommittedChanges(worktreePath, options) {
  try {
    const output = await runGit(worktreePath, ["status", "--porcelain", "--untracked-files=no"], options);
    return output.trim().length > 0;
  } catch (error) {
    return null;
  }
}

async function referenceExists(repositoryPath, reference, options) {
  try {
    await runGit(repositoryPath, ["rev-parse", "--verify", "--quiet", reference], options);
    return true;
  } catch (error) {
    return false;
  }
}

// Everything the cards need about one repo, keyed by task id:
//   { available, error, branchesByTask: { "<taskId>": [branchInfo…] } }
// branchInfo = { repository, name, local, remote, pushed, aheadOfBase,
//                inStaging, worktreePath, uncommitted }
// Every branch (local and on the remote) already inside `targetReference`,
// in one git call — asking branch by branch takes minutes in a repository
// with a thousand CU- branches.
async function branchesMergedInto(repositoryPath, targetReference, remoteName, options) {
  const output = await runGit(
    repositoryPath,
    ["for-each-ref", `--merged=${targetReference}`, "--format=%(refname)", "refs/heads", `refs/remotes/${remoteName}`],
    options
  );
  return new Set(output.split("\n").map((line) => line.trim()).filter(Boolean));
}

// `options.taskIds` (a Set of lower-case ids), when given, limits the work
// to the branches of those tasks: the rest of the repository is not this
// project's business.
export async function inspectRepository(repository, options = {}) {
  const {
    name,
    localPath,
    remoteName = "origin",
    baseBranch = "main",
    stagingBranch = "staging"
  } = repository;
  const result = { repository: name, available: false, error: null, branchesByTask: {} };
  if (!localPath) {
    result.error = "no-path";
    return result;
  }
  let refsOutput;
  try {
    refsOutput = await runGit(localPath, ["for-each-ref", "--format=%(refname)", "refs/heads", `refs/remotes/${remoteName}`], options);
  } catch (error) {
    result.error = "not-a-repository";
    return result;
  }
  result.available = true;
  let worktrees = [];
  try {
    worktrees = parseWorktrees(await runGit(localPath, ["worktree", "list", "--porcelain"], options));
  } catch (error) {
    worktrees = [];
  }
  const baseReference = `${remoteName}/${baseBranch}`;
  const stagingReference = `${remoteName}/${stagingBranch}`;
  const hasBase = await referenceExists(localPath, baseReference, options);
  const hasStaging = await referenceExists(localPath, stagingReference, options);
  let mergedIntoStaging = null;
  if (hasStaging) {
    try {
      mergedIntoStaging = await branchesMergedInto(localPath, stagingReference, remoteName, options);
    } catch (error) {
      mergedIntoStaging = null;
    }
  }
  const wantedTasks = options.taskIds || null;
  const allBranches = Boolean(options.allBranches);
  // Without ClickUp every branch counts, so when each was last touched
  // matters: an old branch already inside the base branch is history.
  let lastCommitByReference = new Map();
  if (allBranches) {
    try {
      lastCommitByReference = parseCommitDates(
        await runGit(localPath, ["for-each-ref", "--format=%(refname) %(committerdate:unix)", "refs/heads", `refs/remotes/${remoteName}`], options)
      );
    } catch (error) {
      lastCommitByReference = new Map();
    }
  }

  for (const branch of parseBranchRefs(refsOutput, remoteName, { allBranches, excluded: [baseBranch, stagingBranch] })) {
    if (wantedTasks && !wantedTasks.has(branch.taskId)) {
      continue;
    }
    // The local branch is what the user works on; fall back to origin's
    // copy for a branch that only exists there.
    const reference = branch.local ? branch.name : `${remoteName}/${branch.name}`;
    const worktree = worktrees.find((entry) => entry.branch === branch.name) || null;
    const info = {
      repository: name,
      name: branch.name,
      local: branch.local,
      remote: branch.remote,
      pushed: branch.remote,
      aheadOfBase: hasBase ? await commitsAhead(localPath, reference, baseReference, options) : null,
      inStaging: !hasStaging
        ? null
        : mergedIntoStaging
          ? mergedIntoStaging.has(branch.local ? `refs/heads/${branch.name}` : `refs/remotes/${remoteName}/${branch.name}`)
          : await isAncestor(localPath, reference, stagingReference, options),
      worktreePath: worktree && worktree.path !== localPath ? worktree.path : null,
      checkedOutInMain: Boolean(worktree && worktree.path === localPath),
      uncommitted: worktree ? await hasUncommittedChanges(worktree.path, options) : null
    };
    // A branch with no commits of its own that is "in staging" was only
    // just cut: every commit of the base branch is in staging too.
    if (info.aheadOfBase === 0) {
      info.inStaging = false;
    }
    if (allBranches) {
      info.lastCommitAt =
        lastCommitByReference.get(branch.local ? `refs/heads/${branch.name}` : `refs/remotes/${remoteName}/${branch.name}`) || null;
      // Nothing of its own left outside the base branch: merged (or never
      // started). Either way it is not work in the queue.
      info.mergedIntoBase = hasBase ? info.aheadOfBase === 0 : null;
    }
    (result.branchesByTask[branch.taskId] ||= []).push(info);
  }
  return result;
}

// `%(refname) %(committerdate:unix)` lines → Map<refname, milliseconds>.
export function parseCommitDates(output) {
  const dates = new Map();
  for (const line of String(output || "").split("\n")) {
    const [reference, seconds] = line.trim().split(" ");
    if (reference && Number(seconds) > 0) {
      dates.set(reference, Number(seconds) * 1000);
    }
  }
  return dates;
}

// Which of the repository's branches is the base and which the staging
// branch, from its remote branches: the first candidate that exists wins.
// null when none does — the setup agent then asks.
export function suggestBranches(remoteBranchNames) {
  const names = new Set((remoteBranchNames || []).map((name) => String(name)));
  const baseBranch = BASE_BRANCH_CANDIDATES.find((candidate) => names.has(candidate)) || null;
  // Then any branch whose name says staging ("docker-staging", "staging-eu").
  const stagingBranch =
    STAGING_BRANCH_CANDIDATES.find((candidate) => names.has(candidate) && candidate !== baseBranch) ||
    [...names].find((name) => /(^|[-_/])staging($|[-_/])/i.test(name)) ||
    null;
  return { baseBranch, stagingBranch };
}

// "git@github.com:owner/name.git" / "https://github.com/owner/name" → "owner/name".
export function githubSlugFromRemote(remoteUrl) {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(remoteUrl || "").trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

// What `clauding repo inspect <folder>` reports about one checkout, read
// only: its remote, the branches there, the suggested base and staging
// branches, and how many branches look like work (CU- or other).
export async function describeRepository(localPath, options = {}) {
  const remoteName = options.remoteName || "origin";
  let topLevel = "";
  try {
    topLevel = (await runGit(localPath, ["rev-parse", "--show-toplevel"], options)).trim();
  } catch (error) {
    return { path: localPath, isRepository: false };
  }
  let remoteUrl = "";
  try {
    remoteUrl = (await runGit(topLevel, ["remote", "get-url", remoteName], options)).trim();
  } catch (error) {
    remoteUrl = "";
  }
  const references = await runGit(topLevel, ["for-each-ref", "--format=%(refname)", "refs/heads", `refs/remotes/${remoteName}`], options);
  const remoteBranches = [];
  const localBranches = [];
  for (const line of references.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    if (line.startsWith(`refs/remotes/${remoteName}/`)) {
      const name = line.slice(`refs/remotes/${remoteName}/`.length);
      if (name !== "HEAD") {
        remoteBranches.push(name);
      }
    } else if (line.startsWith("refs/heads/")) {
      localBranches.push(line.slice("refs/heads/".length));
    }
  }
  const suggested = suggestBranches(remoteBranches.length > 0 ? remoteBranches : localBranches);
  const everyBranch = [...new Set([...localBranches, ...remoteBranches])];
  const longLived = new Set([...LONG_LIVED_BRANCHES, suggested.baseBranch, suggested.stagingBranch].filter(Boolean).map((name) => name.toLowerCase()));
  const featureBranches = everyBranch.filter((name) => !longLived.has(name.toLowerCase()));
  return {
    path: topLevel,
    isRepository: true,
    name: topLevel.split(/[\\/]/).filter(Boolean).pop() || topLevel,
    remoteName,
    remoteUrl: remoteUrl || null,
    githubSlug: githubSlugFromRemote(remoteUrl),
    remoteBranches: remoteBranches.slice(0, 60),
    remoteBranchCount: remoteBranches.length,
    localBranchCount: localBranches.length,
    suggestedBaseBranch: suggested.baseBranch,
    suggestedStagingBranch: suggested.stagingBranch,
    clickupBranchCount: featureBranches.filter((name) => taskIdFromBranch(name)).length,
    otherFeatureBranchCount: featureBranches.filter((name) => !taskIdFromBranch(name)).length,
    featureBranchesSample: featureBranches.slice(0, 10)
  };
}

// Only on the user's ↻ click (see the file header).
export async function fetchRepository(repository, options = {}) {
  const { localPath, remoteName = "origin" } = repository;
  await runGit(localPath, ["fetch", "--no-tags", "--quiet", remoteName], options);
}
