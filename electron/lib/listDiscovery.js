// Projects view: which ClickUp list is the build list and which one plans
// the specs, when the user gave a folder or a space instead of one list.
//
// The rule is the one a single list uses too: build tasks "depend on" their
// planning task. So among the lists looked at, the build list is the one
// whose tasks depend on tasks of another list, and that other list is the
// planning list. When the dependencies point outside the lists looked at
// (the planning list lives in another folder), the build list is still the
// one with the most dependencies and the planning list is found later from
// one of them. When nothing depends on anything, the answer is "ambiguous"
// with the lists to choose from — the user picks, nothing is guessed.

// lists: [{ id, name, folderName, tasks: [{ id, dependsOn: [] }] }]
// → { buildListId, planningListId, ambiguous, candidates }
export function chooseProjectLists(lists) {
  const candidates = (lists || []).map((list) => ({
    id: String(list.id),
    name: list.name || "",
    folderName: list.folderName || null,
    taskCount: (list.tasks || []).length
  }));
  const listOfTask = new Map();
  for (const list of lists || []) {
    for (const task of list.tasks || []) {
      listOfTask.set(String(task.id), String(list.id));
    }
  }
  let best = null;
  const outside = new Map();
  for (const list of lists || []) {
    const pointsAt = new Map();
    for (const task of list.tasks || []) {
      for (const dependencyId of task.dependsOn || []) {
        const target = listOfTask.get(String(dependencyId));
        if (!target) {
          outside.set(String(list.id), (outside.get(String(list.id)) || 0) + 1);
        } else if (target !== String(list.id)) {
          pointsAt.set(target, (pointsAt.get(target) || 0) + 1);
        }
      }
    }
    for (const [target, count] of pointsAt) {
      if (!best || count > best.count) {
        best = { buildListId: String(list.id), planningListId: target, count };
      }
    }
  }
  if (best) {
    return { buildListId: best.buildListId, planningListId: best.planningListId, ambiguous: false, candidates };
  }
  const mostOutside = [...outside.entries()].sort((first, second) => second[1] - first[1])[0];
  if (mostOutside) {
    return { buildListId: mostOutside[0], planningListId: null, ambiguous: false, candidates };
  }
  if (candidates.length === 1) {
    return { buildListId: candidates[0].id, planningListId: null, ambiguous: false, candidates };
  }
  return { buildListId: null, planningListId: null, ambiguous: candidates.length > 0, candidates };
}
