// Projects view: reading ClickUp. Only ever GET — this module has no way to
// write, on purpose: the view shows ClickUp, it never changes it.
//
// The token is the user's own personal token: CLAUDING_CLICKUP_TOKEN when
// set, else the macOS Keychain item read with `security
// find-generic-password -a clickup-api -s clickup-api-token -w`. It is kept in memory only: never
// written to disk, never logged, never sent to the window. ClickUp takes the
// raw token in the Authorization header, not "Bearer <token>".
//
// ClickUp allows about 100 requests a minute per token; requests go through
// one queue with a small gap between them so a big list never trips it.
import { execFile } from "node:child_process";

export const CLICKUP_API_ROOT = "https://api.clickup.com/api";
const KEYCHAIN_ACCOUNT = "clickup-api";
const KEYCHAIN_SERVICE = "clickup-api-token";
const MINIMUM_GAP_MILLISECONDS = 650;
const MAXIMUM_TASK_PAGES = 50;

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
  now = () => Date.now()
}) {
  let queue = Promise.resolve();
  let lastRequestAt = 0;

  function get(pathAndQuery) {
    const call = `GET ${String(pathAndQuery).split("?")[0]}`;
    const run = async () => {
      if (!token) {
        throw new ClickupError("No ClickUp token on this Mac.", { kind: "no-token", call });
      }
      const waitFor = lastRequestAt + minimumGapMilliseconds - now();
      if (waitFor > 0) {
        await sleep(waitFor);
      }
      lastRequestAt = now();
      let response;
      try {
        response = await fetchImplementation(`${apiRoot}${pathAndQuery}`, {
          method: "GET",
          headers: { Authorization: token, Accept: "application/json" }
        });
      } catch (error) {
        throw new ClickupError(`ClickUp could not be reached: ${error.message}`, { kind: "network", call });
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
    const result = queue.then(run, run);
    // A failed request must not jam the queue for the ones after it.
    queue = result.catch(() => undefined);
    return result;
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
    // Every task of a list, closed ones and subtasks included, page by page.
    async listTasks(listId) {
      const tasks = [];
      for (let page = 0; page < MAXIMUM_TASK_PAGES; page += 1) {
        const answer = await get(
          `/v2/list/${encodeURIComponent(listId)}/task?include_closed=true&subtasks=true&page=${page}`
        );
        const pageTasks = answer.tasks || [];
        tasks.push(...pageTasks.map(mapTask));
        if (answer.last_page === true || pageTasks.length === 0) {
          break;
        }
      }
      return tasks;
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

export function specUrlFrom(customFields, fieldName = DEFAULT_SPEC_URL_FIELD) {
  const wanted = String(fieldName || DEFAULT_SPEC_URL_FIELD).trim().toLowerCase();
  for (const field of customFields || []) {
    const name = String(field.name || "").trim().toLowerCase();
    if (name === wanted && typeof field.value === "string" && /^https?:\/\//.test(field.value.trim())) {
      return field.value.trim();
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
    description: typeof task.markdown_description === "string" ? task.markdown_description : task.description || "",
    customFields: (task.custom_fields || [])
      .filter((field) => field.value !== undefined && field.value !== null && field.value !== "")
      .map((field) => ({ name: field.name, type: field.type, value: field.value }))
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

// "https://app.clickup.com/t/abc123aa1" → "abc123aa1"; a bare id passes
// through. Custom ids ("CU-1234") and doc links are not task ids.
export function taskIdFromLink(link) {
  const text = String(link || "").trim();
  const fromUrl = text.match(/app\.clickup\.com\/t\/(?:\d+\/)?([0-9a-z]+)/i);
  if (fromUrl) {
    return fromUrl[1];
  }
  if (/^[0-9a-z]{6,12}$/i.test(text)) {
    return text;
  }
  return null;
}
