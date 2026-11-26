import assert from "node:assert/strict";
import test from "node:test";
import { compareRoadmapTasks, parseRoadmapMilestones, parseRoadmapPriority, parseRoadmapTasks } from "./lib/roadmap-tasks.js";

test("roadmap parsing reads milestones, checklist tasks, bugs and priorities", () => {
  const lines = [
    "## Milestone Map",
    "1. **Synthetic milestone**",
    "   - Workstreams: parsing, dashboard.",
    "   - Current status: in progress",
    "## Next",
    "- [ ] Bug: synthetic failure",
    "  Priority: high",
    "- [x] Synthetic finished task",
  ];
  const milestones = parseRoadmapMilestones(lines);
  assert.deepEqual(milestones, [{ number: 1, title: "Synthetic milestone", workstreams: ["parsing", "dashboard"], status: "in progress" }]);
  const tasks = parseRoadmapTasks(lines, new Map(milestones.map(m => [m.number, m])));
  assert.deepEqual(tasks.map(task => [task.kind, task.status, task.phase, task.title]), [
    ["bug", "open", "Next", "Bug: synthetic failure"],
    ["task", "done", "Next", "Synthetic finished task"],
  ]);
  assert.equal(parseRoadmapPriority("HIGH"), "high");
  assert.equal(parseRoadmapPriority("urgent"), null);
  assert.equal([...tasks].sort(compareRoadmapTasks).length, 2);
});
