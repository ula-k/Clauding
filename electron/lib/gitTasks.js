// Projects without ClickUp: the tasks are the feature branches.
//
// Not every project has a tracker. When a project has no ClickUp list, its
// cards come from its repositories instead — every branch that is not one
// of the long-lived ones (lib/gitInspector.js, `allBranches`), with its pull
// request when GitHub has one — and the sessions that worked on that branch.
// Each branch becomes a task the rest of the Projects view already
// understands, with a status written the way a tracker would:
//
//   in progress   no pull request yet, commits of its own     → my queue
//   in review     an open pull request                        → waiting on others
//   in staging    already inside the staging branch           → waiting on others
//   merged        its pull request was merged, or nothing of  → closed
//                 its own is left outside the base branch
//
// Deadlines are the ones typed in the app. Nothing here reads a file or
// runs git: the caller hands in what gitInspector and pullRequests read.

// A branch already merged is kept on the board this long after its last
// commit, then it is history.
export const MERGED_BRANCH_DAYS = 30;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const MAXIMUM_GIT_TASKS = 150;

export const GIT_STATUSES = {
  inProgress: { status: "in progress", statusType: "custom", statusColor: "#5b8def" },
  inReview: { status: "in review", statusType: "custom", statusColor: "#e0a33a" },
  inStaging: { status: "in staging", statusType: "custom", statusColor: "#a77bdb" },
  merged: { status: "merged", statusType: "closed", statusColor: "#4caf7d" },
  closedUnmerged: { status: "closed", statusType: "closed", statusColor: "#8a8a8a" }
};

function statusOf(branches, pullRequests) {
  const newest = pullRequests[0] || null;
  if (newest && newest.state === "open") {
    return GIT_STATUSES.inReview;
  }
  if (newest && newest.state === "merged") {
    return GIT_STATUSES.merged;
  }
  if (branches.some((branch) => branch.mergedIntoBase === true)) {
    return GIT_STATUSES.merged;
  }
  if (branches.some((branch) => branch.inStaging === true)) {
    return GIT_STATUSES.inStaging;
  }
  if (newest && newest.state === "closed") {
    return GIT_STATUSES.closedUnmerged;
  }
  return GIT_STATUSES.inProgress;
}

// repositoryResults: inspectRepository(…, { allBranches: true }) answers;
// pullRequestResults: listPullRequests(…, { allBranches: true }) answers.
// → tasks in the shape clickupClient's mapTask() gives, plus `source: "git"`.
export function tasksFromBranches({ repositoryResults = [], pullRequestResults = [], now = Date.now() } = {}) {
  const branchesByKey = new Map();
  for (const result of repositoryResults) {
    for (const [key, branches] of Object.entries((result && result.branchesByTask) || {})) {
      branchesByKey.set(key, [...(branchesByKey.get(key) || []), ...branches]);
    }
  }
  const pullsByKey = new Map();
  for (const result of pullRequestResults) {
    for (const [key, pulls] of Object.entries((result && result.byTask) || {})) {
      pullsByKey.set(key, [...(pullsByKey.get(key) || []), ...pulls]);
    }
  }
  const tasks = [];
  for (const [key, branches] of branchesByKey) {
    const pullRequests = (pullsByKey.get(key) || []).slice().sort((first, second) => String(second.updatedAt).localeCompare(String(first.updatedAt)));
    const lastCommitAt = Math.max(0, ...branches.map((branch) => branch.lastCommitAt || 0));
    const pullUpdatedAt = pullRequests[0] && pullRequests[0].updatedAt ? Date.parse(pullRequests[0].updatedAt) || 0 : 0;
    const updatedAt = Math.max(lastCommitAt, pullUpdatedAt) || null;
    const status = statusOf(branches, pullRequests);
    if (status.statusType === "closed" && updatedAt && now - updatedAt > MERGED_BRANCH_DAYS * DAY_MILLISECONDS) {
      continue;
    }
    const firstBranch = branches[0];
    tasks.push({
      id: key,
      source: "git",
      customId: null,
      name: pullRequests[0] && pullRequests[0].title ? pullRequests[0].title : firstBranch.name,
      branchName: firstBranch.name,
      url: pullRequests[0] ? pullRequests[0].url : null,
      status: status.status,
      statusType: status.statusType,
      statusColor: status.statusColor,
      assignees: [],
      dueDate: null,
      startDate: null,
      createdAt: null,
      updatedAt,
      closedAt: status.statusType === "closed" ? updatedAt : null,
      doneAt: null,
      parentId: null,
      listId: null,
      listName: null,
      folderId: null,
      folderName: null,
      spaceId: null,
      dependsOn: [],
      linkedTaskIds: [],
      specUrl: null,
      isMilestone: false,
      typeId: null,
      workspaceId: null,
      description: branches.map((branch) => `${branch.repository}: ${branch.name}`).join("\n"),
      customFields: []
    });
  }
  // Newest first, and a board with a thousand old branches stays readable.
  tasks.sort((first, second) => (second.updatedAt || 0) - (first.updatedAt || 0));
  return tasks.slice(0, MAXIMUM_GIT_TASKS);
}

// branch name (lower case) → task key, so a session whose git branch is
// that branch is linked to its card (lib/taskLinker.js).
export function branchTaskMap(tasks, repositoryResults = []) {
  const map = {};
  const keys = new Set(tasks.map((task) => task.id));
  for (const result of repositoryResults) {
    for (const [key, branches] of Object.entries((result && result.branchesByTask) || {})) {
      if (!keys.has(key)) {
        continue;
      }
      for (const branch of branches) {
        map[String(branch.name).toLowerCase()] = key;
      }
    }
  }
  return map;
}

// Does this project follow ClickUp at all? A project set up without a link,
// a list or a task is a git-only project.
export function usesClickup(board) {
  const clickup = (board && board.clickup) || {};
  return Boolean(clickup.buildListId || clickup.seedTaskId || clickup.projectLink || clickup.planningListId);
}
