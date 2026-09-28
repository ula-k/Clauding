// Projects view: where a project's phases and deadlines come from.
//
// Teams keep their plan in ClickUp in different places: a "roadmap" task
// whose subtasks are the phases (start → end) and the milestones (one day),
// often in another space than the work itself; or a list named for it
// ("Roadmap", "Timeline", "Releases"…) in the project's own space. So the
// deadline source is a setting (board.deadlineSource):
//
//   { mode: "auto" }                 found here, when exactly one place fits
//   { mode: "task", id, name }       that task's subtasks
//   { mode: "list", id, name }       that list's dated tasks
//   { mode: "manual" }               only the deadlines typed in the app
//   includeManual: true              typed deadlines are shown as well
//
// Finding: ClickUp's own "milestone" task type is searched across the
// workspace; the tasks those milestones hang under are roadmap candidates,
// and one whose name carries the project's name is the one. Lists of the
// project's space whose names match DEFAULT_LIST_PATTERN and hold dated
// tasks are candidates too. Nothing is written anywhere.

export const MILESTONE_TYPE_ID = 1;
export const DEFAULT_LIST_PATTERN = "project management|roadmap|timeline|phase|milestone|release";
export const DEFAULT_TASK_PATTERN = "phase|milestone|freeze|launch|release|qa";
export const DEADLINE_MODES = ["auto", "task", "list", "manual"];

function patternOf(text, fallback) {
  try {
    return new RegExp(String(text || fallback), "i");
  } catch (error) {
    return new RegExp(fallback, "i");
  }
}

function normalizeName(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Does a roadmap task's name carry the project's name ("Website" in
// "Website", "Website 2027")? Whole words only.
export function nameMatchesProject(taskName, projectNames) {
  const name = ` ${normalizeName(taskName)} `;
  return (projectNames || [])
    .map(normalizeName)
    .filter((projectName) => projectName.length >= 3)
    .some((projectName) => name.includes(` ${projectName} `));
}

// Tasks → the items an axis can draw: a phase (start and end on different
// days) or a single date. Tasks with no date are left out and counted.
export function datedItems(tasks) {
  const items = [];
  let undated = 0;
  for (const task of tasks || []) {
    const start = Number.isFinite(task.startDate) ? task.startDate : null;
    const end = Number.isFinite(task.dueDate) ? task.dueDate : null;
    if (start === null && end === null) {
      undated += 1;
      continue;
    }
    const sameDay = start !== null && end !== null && new Date(start).toDateString() === new Date(end).toDateString();
    const isSpan = start !== null && end !== null && !sameDay && end > start;
    items.push({
      id: `clickup-${task.id}`,
      taskId: task.id,
      label: task.name,
      url: task.url || null,
      date: end !== null ? end : start,
      start: isSpan ? start : null,
      kind: isSpan ? "span" : "marker",
      isMilestone: Boolean(task.isMilestone),
      status: task.status || null,
      source: "clickup"
    });
  }
  items.sort((first, second) => (first.start || first.date) - (second.start || second.date));
  return { items, undated };
}

// Milestones from the whole workspace → the tasks they hang under, as
// candidates: { kind: "task", id, name, where, dated, matchesName }.
export function roadmapCandidates(parents, projectNames) {
  return (parents || []).map(({ task, subtasks }) => {
    const { items } = datedItems(subtasks);
    return {
      kind: "task",
      id: task.id,
      name: task.name,
      where: task.listName || null,
      dated: items.length,
      matchesName: nameMatchesProject(task.name, projectNames)
    };
  });
}

// Lists whose names say they hold a plan.
export function planLikeLists(lists, { listPattern = DEFAULT_LIST_PATTERN } = {}) {
  const pattern = patternOf(listPattern, DEFAULT_LIST_PATTERN);
  return (lists || []).filter((list) => pattern.test(list.name || ""));
}

// Lists of the project's space → candidates, when their name says they
// hold a plan and they have dated tasks.
export function listCandidates(lists, { listPattern = DEFAULT_LIST_PATTERN } = {}) {
  const pattern = patternOf(listPattern, DEFAULT_LIST_PATTERN);
  return (lists || [])
    .filter((list) => pattern.test(list.name || ""))
    .map((list) => ({
      kind: "list",
      id: list.id,
      name: list.name,
      where: list.folderName || null,
      dated: datedItems(list.tasks || []).items.length,
      matchesName: false
    }))
    .filter((candidate) => candidate.dated > 0);
}

// The one candidate that is clearly right: a roadmap task named for the
// project with dated subtasks; else the only candidate there is; else none
// (the settings list them and the user picks).
export function chooseDeadlineSource(candidates) {
  const usable = (candidates || []).filter((candidate) => candidate.dated > 0);
  const named = usable.filter((candidate) => candidate.matchesName);
  if (named.length === 1) {
    return named[0];
  }
  if (named.length === 0 && usable.length === 1) {
    return usable[0];
  }
  return null;
}

export function cleanDeadlineSource(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const mode = DEADLINE_MODES.includes(source.mode) ? source.mode : "auto";
  const id = source.id ? String(source.id).slice(0, 64) : null;
  if ((mode === "task" || mode === "list") && !id) {
    return { mode: "auto", id: null, name: null, includeManual: source.includeManual !== false };
  }
  return {
    mode,
    id: mode === "task" || mode === "list" ? id : null,
    name: mode === "task" || mode === "list" ? String(source.name || "").slice(0, 200) || null : null,
    includeManual: source.includeManual !== false
  };
}

// Tasks that look like deadlines inside the project's own lists (a task
// named "Code freeze" with a due date), for the settings' hint.
export function deadlineLikeTasks(tasks, { taskPattern = DEFAULT_TASK_PATTERN } = {}) {
  const pattern = patternOf(taskPattern, DEFAULT_TASK_PATTERN);
  return datedItems((tasks || []).filter((task) => task.isMilestone || pattern.test(task.name || ""))).items;
}
