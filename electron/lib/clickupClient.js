// Projects view: reading ClickUp. Only ever GET — this module has no way to
// write, on purpose: the view shows ClickUp, it never changes it.
//
// The token is the user's own personal token: CLAUDING_CLICKUP_TOKEN when
// set, else the macOS Keychain item read with `security
// find-generic-password -a clickup-api -s clickup-api-token -w`. It is kept in memory only: never
// written to disk, never logged, never sent to the window. ClickUp takes the
// raw token in the Authorization header, not "Bearer <token>".
//
// ClickUp allows about 100 requests a minute per token; requests start with
// a small gap between them so a big list never trips it, and a few of them
// may wait for their answers at once.
import { execFile } from "node:child_process";

export const CLICKUP_API_ROOT = "https://api.clickup.com/api";
const KEYCHAIN_ACCOUNT = "clickup-api";
const KEYCHAIN_SERVICE = "clickup-api-token";
// Requests START at least this far apart (about 90 a minute, under
// ClickUp's 100); up to MAXIMUM_REQUESTS_AT_ONCE of them may be waiting for
// their answers at the same time, so a slow answer does not hold up the
// ones behind it.
const MINIMUM_GAP_MILLISECONDS = 650;
const MAXIMUM_REQUESTS_AT_ONCE = 4;
// 100 tasks a page: 200 pages is 20,000 tasks. A list longer than that
// says so (tasks.truncated) instead of being cut off without a word.
export const MAXIMUM_TASK_PAGES = 200;
// After a 429 the request is tried once more, when ClickUp's
// X-RateLimit-Reset says the minute is over (a minute when it says nothing,
// never longer than that).
const RATE_LIMIT_WAIT_MILLISECONDS = 60 * 1000;

// X-RateLimit-Reset (seconds since 1970) → how long to wait, in ms.
export function rateLimitWait(response, nowTime) {
  const headers = response && response.headers;
  const reset = headers && typeof headers.get === "function" ? Number(headers.get("x-ratelimit-reset")) : NaN;
  if (!Number.isFinite(reset) || reset <= 0) {
    return RATE_LIMIT_WAIT_MILLISECONDS;
  }
  return Math.min(Math.max(reset * 1000 - nowTime, 0), RATE_LIMIT_WAIT_MILLISECONDS);
}

export class ClickupError extends Error {
  constructor(message, { kind, status, call } = {}) {
    super(message);
    this.name = "ClickupError";
    // "no-token" | "unauthorized" | "not-found" | "rate-limited" | "network" | "http"
    this.kind = kind || "http";
    this.status = status || null;
    // The request that failed ("GET /v2/list/…/task"), for the error state
    // in the view. Never carries the token.
    this.call = call || null;
  }
}

// The token, or null when there is none (no Keychain item, not a Mac, the
// user said no to the Keychain prompt). Never throws.
export function readClickupToken({ platform = process.platform, execFileImplementation = execFile, environment = process.env } = {}) {
  if (environment.CLAUDING_CLICKUP_TOKEN) {
    return Promise.resolve(environment.CLAUDING_CLICKUP_TOKEN.trim());
  }
  if (platform !== "darwin") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    execFileImplementation(
      "security",
      ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 10000 },
      (error, standardOutput) => {
        if (error) {
          resolve(null);
          return;
        }
        const token = String(standardOutput || "").trim();
        resolve(token || null);
      }
    );
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createClickupClient({
  token,
  fetchImplementation = globalThis.fetch,
  apiRoot = CLICKUP_API_ROOT,
  minimumGapMilliseconds = MINIMUM_GAP_MILLISECONDS,
  maximumRequestsAtOnce = MAXIMUM_REQUESTS_AT_ONCE,
  now = () => Date.now(),
  wait = sleep
}) {
  // When the next request may start, and the requests waiting for room.
  let nextStartAt = 0;
  let running = 0;
  const waitingForRoom = [];

  // A place among the requests in flight, first come first served; a
  // finished request hands its place straight to the next one waiting.
  function takePlace() {
    if (running < maximumRequestsAtOnce) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waitingForRoom.push(resolve));
  }

  function givePlaceBack() {
    const nextInLine = waitingForRoom.shift();
    if (nextInLine) {
      nextInLine();
    } else {
      running -= 1;
    }
  }

  async function waitForTurn() {
    const startAt = Math.max(now(), nextStartAt);
    nextStartAt = startAt + minimumGapMilliseconds;
    const waitFor = startAt - now();
    if (waitFor > 0) {
      await wait(waitFor);
    }
  }

  function get(pathAndQuery) {
    const call = `GET ${String(pathAndQuery).split("?")[0]}`;
    const run = async () => {
      if (!token) {
        throw new ClickupError("No ClickUp token on this Mac.", { kind: "no-token", call });
      }
      const request = async () => {
        await waitForTurn();
        try {
          return await fetchImplementation(`${apiRoot}${pathAndQuery}`, {
            method: "GET",
            headers: { Authorization: token, Accept: "application/json" }
          });
        } catch (error) {
          throw new ClickupError(`ClickUp could not be reached: ${error.message}`, { kind: "network", call });
        }
      };
      let response = await request();
      if (response.status === 429) {
        // Every request waits for the reset, not only this one.
        nextStartAt = Math.max(nextStartAt, now() + rateLimitWait(response, now()));
        response = await request();
      }
      if (response.status === 401) {
        throw new ClickupError("ClickUp refused the token.", { kind: "unauthorized", status: 401, call });
      }
      if (response.status === 404) {
        throw new ClickupError("ClickUp says this does not exist.", { kind: "not-found", status: 404, call });
      }
      if (response.status === 429) {
        throw new ClickupError("ClickUp asked to slow down.", { kind: "rate-limited", status: 429, call });
      }
      if (!response.ok) {
        throw new ClickupError(`ClickUp answered ${response.status}.`, { kind: "http", status: response.status, call });
      }
      return response.json();
    };
    // A failed request gives its place back too, so it never jams the rest.
    return takePlace().then(() => run().finally(givePlaceBack));
  }

  // Tasks page after page until ClickUp says it was the last: the first
  // `expectedPages` asked for at once, the rest one by one. Stopping at
  // `maximumPages` with more left is said on the array (tasks.truncated),
  // so the window can say "at least"; tasks.pagesRead is how many pages the
  // list took.
  async function readPages(readPage, { maximumPages, expectedPages }) {
    const tasks = [];
    let truncated = true;
    const firstPages = Math.max(1, Math.min(maximumPages, Math.floor(expectedPages) || 1));
    const answers = await Promise.all(Array.from({ length: firstPages }, (unused, page) => readPage(page)));
    let page = 0;
    let answer = answers[0];
    while (answer) {
      const pageTasks = answer.tasks || [];
      tasks.push(...pageTasks.map(mapTask));
      if (answer.last_page === true || pageTasks.length === 0) {
        truncated = false;
        break;
      }
      page += 1;
      if (page >= maximumPages) {
        break;
      }
      answer = page < answers.length ? answers[page] : await readPage(page);
    }
    tasks.truncated = truncated;
    tasks.pagesRead = page + 1;
    return tasks;
  }

  return {
    get,
    async getTask(taskId) {
      return mapTask(await get(`/v2/task/${encodeURIComponent(taskId)}?include_subtasks=true`));
    },
    async getTaskComments(taskId) {
      const answer = await get(`/v2/task/${encodeURIComponent(taskId)}/comment`);
      return (answer.comments || []).map(mapComment);
    },
    async getList(listId) {
      const answer = await get(`/v2/list/${encodeURIComponent(listId)}`);
      return {
        id: String(answer.id),
        name: answer.name || "",
        folderId: answer.folder ? String(answer.folder.id) : null,
        folderName: answer.folder ? answer.folder.name : null,
        spaceId: answer.space ? String(answer.space.id) : null,
        statuses: (answer.statuses || []).map((status) => ({
          name: status.status,
          type: status.type || null,
          color: status.color || null,
          order: typeof status.orderindex === "number" ? status.orderindex : Number(status.orderindex) || 0
        }))
      };
    },
    // Every task of a list, page by page: subtasks at every level
    // (subtasks=true; without it ClickUp answers with the top-level tasks
    // only) and, unless the project says otherwise, closed ones too
    // (include_closed=true; without it ClickUp leaves out every task whose
    // status is of type "closed"). Descriptions come as plain text: the
    // markdown copy is not asked for.
    //
    // `updatedAfter` (ms) asks only for the tasks changed since then
    // (date_updated_gt) — a refresh that merges them into the last copy.
    // `expectedPages` asks for that many pages at once (how many the last
    // full read had) instead of one after another; reading goes on page by
    // page after them when the list has grown.
    async listTasks(listId, { maximumPages = MAXIMUM_TASK_PAGES, includeClosed = true, updatedAfter = null, expectedPages = 1 } = {}) {
      const since = Number.isFinite(updatedAfter) ? `&date_updated_gt=${Math.floor(updatedAfter)}` : "";
      return readPages(
        (page) =>
          get(
            `/v2/list/${encodeURIComponent(listId)}/task?include_closed=${includeClosed ? "true" : "false"}&subtasks=true&include_markdown_description=false${since}&page=${page}`
          ),
        { maximumPages, expectedPages }
      );
    },
    // When each task entered each of its statuses (ClickUp's "time in
    // status"), 100 tasks per request: { "<task id>": [{ status, type,
    // since }] }. Workspaces without that ClickApp answer with an error;
    // the caller then does without.
    async getStatusHistory(taskIds) {
      const history = {};
      const ids = [...new Set((taskIds || []).map(String))];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const query = ids
          .slice(offset, offset + 100)
          .map((taskId) => `task_ids=${encodeURIComponent(taskId)}`)
          .join("&");
        const answer = await get(`/v2/task/bulk_time_in_status/task_ids?${query}`);
        for (const [taskId, entry] of Object.entries(answer || {})) {
          history[taskId] = ((entry && entry.status_history) || []).map((step) => ({
            status: step.status || "",
            type: step.type || null,
            since: toTimestamp(step.total_time && step.total_time.since)
          }));
        }
      }
      return history;
    },
    // Tasks of a whole workspace of the given task types (ClickUp's own
    // "milestone" is type 1), closed ones and subtasks included — for
    // finding where a project's phases and milestones are kept.
    // The pages are few (five at most) and all asked for at once.
    async listWorkspaceTasksOfTypes(workspaceId, typeIds, { maximumPages = 5 } = {}) {
      const types = (typeIds || []).map((typeId) => `custom_items%5B%5D=${encodeURIComponent(typeId)}`).join("&");
      return readPages((page) => get(`/v2/team/${encodeURIComponent(workspaceId)}/task?${types}&include_closed=true&subtasks=true&page=${page}`), {
        maximumPages,
        expectedPages: maximumPages
      });
    },
    // A task with its subtasks mapped too (a roadmap task's phases).
    async getTaskWithSubtasks(taskId) {
      const answer = await get(`/v2/task/${encodeURIComponent(taskId)}?include_subtasks=true`);
      return { task: mapTask(answer), subtasks: (answer.subtasks || []).map(mapTask) };
    },
    // A saved view: what it belongs to. parent.type 6 = list, 5 = folder,
    // 4 = space, 7 = the whole workspace.
    async getView(viewId) {
      const answer = await get(`/v2/view/${encodeURIComponent(viewId)}`);
      const view = answer.view || {};
      const parent = view.parent || {};
      const kinds = { 4: "space", 5: "folder", 6: "list" };
      return { id: String(view.id || viewId), name: view.name || "", parentKind: kinds[Number(parent.type)] || null, parentId: parent.id ? String(parent.id) : null };
    },
    async getFolder(folderId) {
      const answer = await get(`/v2/folder/${encodeURIComponent(folderId)}`);
      return {
        id: String(answer.id),
        name: answer.name || "",
        spaceId: answer.space ? String(answer.space.id) : null,
        spaceName: answer.space ? answer.space.name || null : null,
        lists: (answer.lists || []).map((list) => ({ id: String(list.id), name: list.name, folderName: answer.name || "" }))
      };
    },
    async listFolderlessLists(spaceId) {
      const answer = await get(`/v2/space/${encodeURIComponent(spaceId)}/list?archived=false`);
      return (answer.lists || []).map((list) => ({ id: String(list.id), name: list.name, folderName: null }));
    },
    // The custom fields a list's tasks can carry (for the spec-link setting).
    async listFields(listId) {
      const answer = await get(`/v2/list/${encodeURIComponent(listId)}/field`);
      return (answer.fields || []).map((field) => ({
        id: String(field.id),
        name: field.name,
        type: field.type,
        options: ((field.type_config && field.type_config.options) || []).map((option) => option.name || option.label).filter(Boolean)
      }));
    },
    // Everyone who can see a list (for "who am I in ClickUp").
    async listMembers(listId) {
      const answer = await get(`/v2/list/${encodeURIComponent(listId)}/member`);
      return (answer.members || []).map(mapUser);
    },
    // The owner of the token.
    async getCurrentUser() {
      const answer = await get("/v2/user");
      return mapUser(answer.user);
    },
    async listWorkspaces() {
      const answer = await get("/v2/team");
      return (answer.teams || []).map((team) => ({ id: String(team.id), name: team.name }));
    },
    // Settings: walking a workspace down to its lists.
    async listSpaces(workspaceId) {
      const answer = await get(`/v2/team/${encodeURIComponent(workspaceId)}/space?archived=false`);
      return (answer.spaces || []).map((space) => ({ id: String(space.id), name: space.name }));
    },
    async listFolders(spaceId) {
      const answer = await get(`/v2/space/${encodeURIComponent(spaceId)}/folder?archived=false`);
      return (answer.folders || []).map((folder) => ({
        id: String(folder.id),
        name: folder.name,
        lists: (folder.lists || []).map((list) => ({ id: String(list.id), name: list.name }))
      }));
    }
  };
}

// ---- Shapes ----------------------------------------------------------------

function toTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function initialsOf(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  return words
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");
}

export function mapUser(rawUser) {
  const user = rawUser || {};
  const name = user.username || user.email || "Unknown";
  return {
    id: user.id === undefined || user.id === null ? null : String(user.id),
    name,
    initials: user.initials || initialsOf(name),
    color: user.color || null
  };
}

// The custom field that holds a planning task's spec link. Matched by its
// name (a board setting, "Spec URL" unless the project says otherwise),
// ignoring case, since the field id differs per workspace; only a value
// that is a link counts.
export const DEFAULT_SPEC_URL_FIELD = "Spec URL";

function fieldKey(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function linkIn(value) {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return /^https?:\/\/\S+$/.test(text) ? text : null;
}

// The exact name wins; else a field whose name starts with it once spaces
// and punctuation are ignored ("Spec URL" finds "Spec URL (Automation)"),
// so a workspace that decorated the name still works without a setting.
export function specUrlFrom(customFields, fieldName = DEFAULT_SPEC_URL_FIELD) {
  const wanted = String(fieldName || DEFAULT_SPEC_URL_FIELD).trim().toLowerCase();
  const wantedKey = fieldKey(wanted);
  const fields = customFields || [];
  for (const field of fields) {
    if (String(field.name || "").trim().toLowerCase() === wanted && linkIn(field.value)) {
      return linkIn(field.value);
    }
  }
  if (!wantedKey) {
    return null;
  }
  for (const field of fields) {
    if (fieldKey(field.name).startsWith(wantedKey) && linkIn(field.value)) {
      return linkIn(field.value);
    }
  }
  return null;
}

// The ids this task waits on ("depends on" in ClickUp). A dependency entry
// says `task_id` waits on `depends_on`; the same array also lists the tasks
// that wait on this one, which are not what we want here.
export function dependsOnFrom(taskId, dependencies) {
  const ids = [];
  for (const dependency of dependencies || []) {
    if (String(dependency.task_id) === String(taskId) && dependency.depends_on) {
      ids.push(String(dependency.depends_on));
    }
  }
  return ids;
}

// A drop-down's value is the index (or id) of an option and labels are
// option ids: both are turned into the option names people see in ClickUp.
export function readableFieldValue(field) {
  const value = field.value;
  const options = (field.type_config && field.type_config.options) || [];
  const optionName = (wanted) => {
    const option = options.find(
      (candidate) => String(candidate.id) === String(wanted) || (typeof wanted === "number" && candidate.orderindex === wanted)
    );
    return option ? option.name || option.label || null : null;
  };
  if (field.type === "drop_down" && options.length > 0) {
    return optionName(value) || value;
  }
  if (field.type === "labels" && Array.isArray(value)) {
    return value.map((entry) => optionName(entry) || entry).join(", ");
  }
  return value;
}

// ClickUp's own task type for a milestone (custom_item_id 1).
const MILESTONE_ITEM_ID = 1;

export function mapTask(raw) {
  const task = raw || {};
  const id = String(task.id);
  const status = task.status || {};
  return {
    id,
    customId: task.custom_id || null,
    name: task.name || "",
    url: task.url || `https://app.clickup.com/t/${id}`,
    status: status.status || "",
    statusType: status.type || null,
    statusColor: status.color || null,
    assignees: (task.assignees || []).map(mapUser),
    dueDate: toTimestamp(task.due_date),
    startDate: toTimestamp(task.start_date),
    createdAt: toTimestamp(task.date_created),
    updatedAt: toTimestamp(task.date_updated),
    closedAt: toTimestamp(task.date_closed),
    doneAt: toTimestamp(task.date_done),
    parentId: task.parent ? String(task.parent) : null,
    listId: task.list ? String(task.list.id) : null,
    listName: task.list ? task.list.name : null,
    folderId: task.folder ? String(task.folder.id) : null,
    folderName: task.folder ? task.folder.name : null,
    spaceId: task.space ? String(task.space.id) : null,
    dependsOn: dependsOnFrom(id, task.dependencies),
    linkedTaskIds: (task.linked_tasks || [])
      .map((link) => String(link.link_id === id ? link.task_id : link.link_id))
      .filter((linkedId) => linkedId && linkedId !== id),
    specUrl: specUrlFrom(task.custom_fields),
    isMilestone: Number(task.custom_item_id) === MILESTONE_ITEM_ID,
    typeId: task.custom_item_id === undefined || task.custom_item_id === null ? null : Number(task.custom_item_id),
    workspaceId: task.team_id ? String(task.team_id) : null,
    description: typeof task.markdown_description === "string" ? task.markdown_description : task.description || "",
    customFields: (task.custom_fields || [])
      .filter((field) => field.value !== undefined && field.value !== null && field.value !== "")
      .map((field) => ({ name: field.name, type: field.type, value: readableFieldValue(field) }))
  };
}

export function mapComment(raw) {
  const comment = raw || {};
  return {
    id: String(comment.id),
    author: mapUser(comment.user),
    text: comment.comment_text || "",
    createdAt: toTimestamp(comment.date)
  };
}

// What a pasted ClickUp link (or a bare id) points at:
//   https://app.clickup.com/t/<task>            → { kind: "task", id }
//   https://app.clickup.com/t/<team>/<task>     → { kind: "task", id }
//   https://app.clickup.com/<team>/v/li/<list>  → { kind: "list", id }
//   https://app.clickup.com/<team>/v/l/6-<list>-1 → { kind: "list", id }
//   https://app.clickup.com/<team>/v/l/<view>   → { kind: "view", id }  (a saved
//       view of a list, folder or space: ClickUp is asked what it belongs to)
//   https://app.clickup.com/<team>/v/b/<view>   → the same for a board view
//   https://app.clickup.com/<team>/v/f/<folder> → { kind: "folder", id }
//   https://app.clickup.com/<team>/v/s/<space>  → { kind: "space", id }
//   901234567890 (digits only)                  → { kind: "list", id }
//   abc123aa1 (letters and digits)              → { kind: "task", id }
// Anything else — a doc, a custom id, garbage — is null.
const VIEW_LINK_KINDS = { li: "list", l: "view", b: "view", g: "view", c: "view", f: "folder", s: "space" };

export function parseClickupLink(link) {
  const text = String(link || "").trim();
  if (!text) {
    return null;
  }
  const teamMatch = text.match(/app\.clickup\.com\/(\d+)\//i);
  const teamId = teamMatch ? teamMatch[1] : null;
  const taskMatch = text.match(/app\.clickup\.com\/t\/(?:\d+\/)?([0-9a-z]+)(?:[/?#]|$)/i);
  if (taskMatch) {
    return { kind: "task", id: taskMatch[1], teamId };
  }
  const viewMatch = text.match(/app\.clickup\.com\/\d+\/v\/(li|l|b|g|c|f|s)\/([0-9a-z-]+)(?:[/?#]|$)/i);
  if (viewMatch) {
    const kind = VIEW_LINK_KINDS[viewMatch[1].toLowerCase()];
    const identifier = viewMatch[2];
    // A list's own default view carries the list id: 6-<list id>-<view type>.
    const defaultListView = identifier.match(/^6-(\d+)-\d+$/);
    if (kind === "view" && defaultListView) {
      return { kind: "list", id: defaultListView[1], teamId };
    }
    const defaultFolderView = identifier.match(/^5-(\d+)-\d+$/);
    if (kind === "view" && defaultFolderView) {
      return { kind: "folder", id: defaultFolderView[1], teamId };
    }
    const defaultSpaceView = identifier.match(/^4-(\d+)-\d+$/);
    if (kind === "view" && defaultSpaceView) {
      return { kind: "space", id: defaultSpaceView[1], teamId };
    }
    return { kind, id: identifier, teamId };
  }
  if (/^\d{6,20}$/.test(text)) {
    return { kind: "list", id: text, teamId: null };
  }
  if (/^[0-9a-z]{6,12}$/i.test(text) && /[a-z]/i.test(text)) {
    return { kind: "task", id: text, teamId: null };
  }
  return null;
}

// "https://app.clickup.com/t/abc123aa1" → "abc123aa1"; a bare id passes
// through. Custom ids ("CU-1234") and doc links are not task ids.
export function taskIdFromLink(link) {
  const parsed = parseClickupLink(link);
  return parsed && parsed.kind === "task" ? parsed.id : null;
}
