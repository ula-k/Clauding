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
import { execFile } from "node:child_process";

const BRANCH_PATTERN = /^CU-([0-9a-z]+)(?:[-_][0-9a-z_.-]*)?$/i;
const GIT_TIMEOUT_MILLISECONDS = 20000;

export function taskIdFromBranch(branchName) {
  const shortName = String(branchName || "").replace(/^refs\/(heads|remotes\/[^/]+)\//, "");
  const lastPart = shortName.split("/").pop();
  const match = lastPart.match(BRANCH_PATTERN);
  return match ? match[1].toLowerCase() : null;
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
export function parseBranchRefs(output, remoteName = "origin") {
  const branches = new Map();
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
    if (!branchName || !taskIdFromBranch(branchName)) {
      continue;
    }
    const entry = branches.get(branchName) || { name: branchName, taskId: taskIdFromBranch(branchName), local: false, remote: false };
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

  for (const branch of parseBranchRefs(refsOutput, remoteName)) {
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
    (result.branchesByTask[branch.taskId] ||= []).push(info);
  }
  return result;
}

// Only on the user's ↻ click (see the file header).
export async function fetchRepository(repository, options = {}) {
  const { localPath, remoteName = "origin" } = repository;
  await runGit(localPath, ["fetch", "--no-tags", "--quiet", remoteName], options);
}
