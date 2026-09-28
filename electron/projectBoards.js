// The user's projects for the Projects tab, saved to
// <userData>/project-boards.json. Called "boards" in code because "projects"
// already means working folders in this app (electron/projects.js); the UI
// says Projects.
//
// File shape (version 1):
//   {
//     "version": 1,
//     "boards": [
//       {
//         "id": "<uuid>",
//         "name": "Website",
//         "color": "--project-color-0",
//         "group": "Work",
//         "clickup": {
//           "buildListId": "901…", "buildListName": "Web build list",
//           "planningListId": "901…", "planningListName": "…",
//           "seedTaskId": "abc123aa1",       // a task link, when one was given
//           "projectLink": "https://app.clickup.com/…/v/li/901…" // the link it was set up from
//         },
//         "clickupUserId": "123456",
//         "specUrlFieldName": "Spec URL",   // the custom field holding the spec link
//         "repositories": [
//           { "name": "website", "localPath": "/Users/…/website",
//             "githubSlug": "acme/website",
//             "baseBranch": "main", "stagingBranch": "staging" }
//         ],
//         "deadlines": [
//           { "id": "<uuid>", "label": "Feature freeze", "date": 1760486400000,
//             "source": "manual" | "task", "taskId": null }
//         ],
//         "startDate": null,
//         "upNext": ["<taskId>", …],
//         "manualLinks": { "<taskId>": { "sessionIds": [], "unlinkedSessionIds": [] } },
//         "agentRoles": { "<agentId>": "spec" | "builder" | "other" },
//         "statusOverrides": { "<status name>": "<bucket>" },
//         "specStatusOverrides": { "<status name>": "<spec stage>" },
//         "focusRules": { "myQueue": true, "needsMe": true, "recentSession": true,
//                         "upNext": true, "everythingOpen": false },
//         "perspectiveOverrides": { "<status name>": "myQueue" | "waiting" | "closed" },
//         "developerStatusFieldName": null,        // null = detected
//         "developerStatusMap": { "<field value>": "myQueue" | "waiting" | "closed" },
//         "deadlineHidden": ["clickup-<task id>", …],  // not drawn on the axis
//         "keyDeadlineId": "clickup-<task id>" | null  // what "Next" counts to
//       }
//     ]
//   }
//
// Anything unexpected is dropped when read; a broken file never keeps the
// app from starting — it is set aside as project-boards.json.bak and the
// store starts empty.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BUCKETS, SPEC_STAGE_ORDER } from "./lib/statusBuckets.js";
import { cleanDeadlineSource } from "./lib/deadlineSources.js";

const SAVE_DEBOUNCE_MILLISECONDS = 200;
const MAXIMUM_NAME_LENGTH = 60;
const MAXIMUM_UP_NEXT = 50;
const ROLES = ["spec", "builder", "other"];
// What "My focus" shows; each can be switched off in the settings sheet.
export const DEFAULT_FOCUS_RULES = { myQueue: true, needsMe: true, recentSession: true, upNext: true, everythingOpen: false };
const PERSPECTIVE_CHOICES = ["myQueue", "waiting", "closed"];

function cleanFocusRules(raw) {
  const rules = { ...DEFAULT_FOCUS_RULES };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(DEFAULT_FOCUS_RULES)) {
      if (typeof raw[key] === "boolean") {
        rules[key] = raw[key];
      }
    }
  }
  return rules;
}
export const DEFAULT_BASE_BRANCH = "main";
export const DEFAULT_STAGING_BRANCH = "staging";
export const DEFAULT_SPEC_URL_FIELD_NAME = "Spec URL";

function cleanText(value, maximumLength = 200) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function cleanId(value) {
  const text = cleanText(value, 64);
  return text || null;
}

function cleanStringList(values, limit = 500) {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set();
  for (const value of values) {
    const text = cleanId(value);
    if (text) {
      seen.add(text);
    }
  }
  return [...seen].slice(0, limit);
}

function cleanRepository(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const name = cleanText(raw.name, 60);
  if (!name) {
    return null;
  }
  return {
    name,
    localPath: raw.localPath ? String(raw.localPath) : null,
    githubSlug: raw.githubSlug ? cleanText(raw.githubSlug, 120) : null,
    remoteName: cleanText(raw.remoteName, 40) || "origin",
    baseBranch: cleanText(raw.baseBranch, 120) || DEFAULT_BASE_BRANCH,
    // "" on purpose means "this repository has no staging branch" (the setup
    // agent writes that when `git branch -r` has none); a missing value is
    // the old default.
    stagingBranch: raw.stagingBranch === "" ? "" : cleanText(raw.stagingBranch, 120) || DEFAULT_STAGING_BRANCH
  };
}

function cleanDeadline(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const label = cleanText(raw.label, 80);
  // A deadline that follows a task may have no date of its own yet: the
  // snapshot takes the task's due date (and it moves with the task).
  const date = raw.date === null || raw.date === undefined || raw.date === "" ? null : Number(raw.date);
  const followsTask = raw.source === "task" && cleanId(raw.taskId);
  if (!label || (!followsTask && !Number.isFinite(date))) {
    return null;
  }
  return {
    id: cleanId(raw.id) || randomUUID(),
    label,
    date: Number.isFinite(date) ? date : null,
    source: raw.source === "task" ? "task" : "manual",
    taskId: raw.source === "task" ? cleanId(raw.taskId) : null
  };
}

function cleanMap(raw, allowedValues) {
  const result = {};
  if (!raw || typeof raw !== "object") {
    return result;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (allowedValues.includes(value)) {
      result[cleanText(key, 120)] = value;
    }
  }
  return result;
}

function cleanManualLinks(raw) {
  const result = {};
  if (!raw || typeof raw !== "object") {
    return result;
  }
  for (const [taskId, link] of Object.entries(raw)) {
    const cleanTaskId = cleanId(taskId);
    if (!cleanTaskId || !link || typeof link !== "object") {
      continue;
    }
    const sessionIds = cleanStringList(link.sessionIds);
    const unlinkedSessionIds = cleanStringList(link.unlinkedSessionIds);
    if (sessionIds.length > 0 || unlinkedSessionIds.length > 0) {
      result[cleanTaskId] = { sessionIds, unlinkedSessionIds };
    }
  }
  return result;
}

export function cleanBoard(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const name = cleanText(raw.name, MAXIMUM_NAME_LENGTH);
  if (!name) {
    return null;
  }
  const clickup = raw.clickup && typeof raw.clickup === "object" ? raw.clickup : {};
  return {
    id: cleanId(raw.id) || randomUUID(),
    name,
    color: /^--project-color-\d$/.test(raw.color || "") ? raw.color : "--project-color-0",
    group: cleanText(raw.group, 40) || "Work",
    clickup: {
      buildListId: cleanId(clickup.buildListId),
      buildListName: cleanText(clickup.buildListName, 120) || null,
      planningListId: cleanId(clickup.planningListId),
      planningListName: cleanText(clickup.planningListName, 120) || null,
      seedTaskId: cleanId(clickup.seedTaskId),
      projectLink: cleanText(clickup.projectLink, 400) || null
    },
    clickupUserId: cleanId(raw.clickupUserId),
    specUrlFieldName: cleanText(raw.specUrlFieldName, 120) || DEFAULT_SPEC_URL_FIELD_NAME,
    repositories: (Array.isArray(raw.repositories) ? raw.repositories : []).map(cleanRepository).filter(Boolean),
    deadlines: (Array.isArray(raw.deadlines) ? raw.deadlines : []).map(cleanDeadline).filter(Boolean),
    startDate: Number.isFinite(Number(raw.startDate)) && raw.startDate !== null ? Number(raw.startDate) : null,
    upNext: cleanStringList(raw.upNext, MAXIMUM_UP_NEXT),
    manualLinks: cleanManualLinks(raw.manualLinks),
    agentRoles: cleanMap(raw.agentRoles, ROLES),
    statusOverrides: cleanMap(raw.statusOverrides, Object.values(BUCKETS)),
    specStatusOverrides: cleanMap(raw.specStatusOverrides, SPEC_STAGE_ORDER),
    focusRules: cleanFocusRules(raw.focusRules),
    // Where each status lands from the user's side (lib/perspective.js).
    perspectiveOverrides: cleanMap(raw.perspectiveOverrides, PERSPECTIVE_CHOICES),
    // The developer-status custom field (null = detected) and which of its
    // values put a task in the queue, waiting or closed.
    developerStatusFieldName: cleanText(raw.developerStatusFieldName, 120) || null,
    developerStatusMap: cleanMap(raw.developerStatusMap, PERSPECTIVE_CHOICES),
    // Where the phases and deadlines come from (lib/deadlineSources.js).
    deadlineSource: cleanDeadlineSource(raw.deadlineSource),
    // Deadline items (typed or from ClickUp, by id) left off the axis, and
    // the one pinned as the key deadline "Next" counts to.
    deadlineHidden: cleanStringList(raw.deadlineHidden, 200),
    keyDeadlineId: cleanText(raw.keyDeadlineId, 120) || null
  };
}

function emptyState() {
  return { version: 1, boards: [] };
}

export function readBoardsFile(storagePath) {
  let text;
  try {
    text = fs.readFileSync(storagePath, "utf8");
  } catch (error) {
    return emptyState();
  }
  try {
    const saved = JSON.parse(text);
    const boards = (Array.isArray(saved.boards) ? saved.boards : []).map(cleanBoard).filter(Boolean);
    return { version: 1, boards };
  } catch (error) {
    try {
      fs.copyFileSync(storagePath, `${storagePath}.bak`);
    } catch (copyError) {
      // Nothing to keep; start empty either way.
    }
    return emptyState();
  }
}

export function createProjectBoardStore({ storagePath, onChange = () => {} }) {
  let state = readBoardsFile(storagePath);
  let saveTimer = null;

  function writeNow() {
    saveTimer = null;
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    const temporaryPath = `${storagePath}.writing`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
    fs.renameSync(temporaryPath, storagePath);
  }

  function scheduleSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(writeNow, SAVE_DEBOUNCE_MILLISECONDS);
    onChange(snapshot());
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  function findBoard(boardId) {
    const board = state.boards.find((candidate) => candidate.id === boardId);
    if (!board) {
      throw new Error(`No project with id ${boardId}.`);
    }
    return board;
  }

  function replaceBoard(boardId, update) {
    const index = state.boards.findIndex((candidate) => candidate.id === boardId);
    if (index === -1) {
      throw new Error(`No project with id ${boardId}.`);
    }
    const cleaned = cleanBoard({ ...state.boards[index], ...update, id: boardId });
    if (!cleaned) {
      throw new Error("A project needs a name.");
    }
    state.boards[index] = cleaned;
    scheduleSave();
    return cleaned;
  }

  return {
    getState: snapshot,
    getBoard(boardId) {
      return JSON.parse(JSON.stringify(findBoard(boardId)));
    },
    addBoard(draft) {
      const board = cleanBoard({ ...draft, id: randomUUID() });
      if (!board) {
        throw new Error("A project needs a name.");
      }
      state.boards.push(board);
      scheduleSave();
      return board;
    },
    updateBoard: replaceBoard,
    // Deleting a project only forgets it here; nothing in ClickUp, git or
    // the sessions is touched. The window asks before calling this.
    deleteBoard(boardId) {
      findBoard(boardId);
      state.boards = state.boards.filter((candidate) => candidate.id !== boardId);
      scheduleSave();
    },
    setUpNext(boardId, taskIds) {
      return replaceBoard(boardId, { upNext: taskIds });
    },
    linkSession(boardId, taskId, sessionId) {
      const board = findBoard(boardId);
      const links = { ...board.manualLinks };
      const link = links[taskId] || { sessionIds: [], unlinkedSessionIds: [] };
      links[taskId] = {
        sessionIds: [...new Set([...link.sessionIds, sessionId])],
        unlinkedSessionIds: link.unlinkedSessionIds.filter((existing) => existing !== sessionId)
      };
      return replaceBoard(boardId, { manualLinks: links });
    },
    unlinkSession(boardId, taskId, sessionId) {
      const board = findBoard(boardId);
      const links = { ...board.manualLinks };
      const link = links[taskId] || { sessionIds: [], unlinkedSessionIds: [] };
      links[taskId] = {
        sessionIds: link.sessionIds.filter((existing) => existing !== sessionId),
        unlinkedSessionIds: [...new Set([...link.unlinkedSessionIds, sessionId])]
      };
      return replaceBoard(boardId, { manualLinks: links });
    },
    flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        writeNow();
      }
    }
  };
}
