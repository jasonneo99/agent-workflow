import { parseDashboardRunScope, parseDashboardRunStatusFilter } from "./http.js";
import { stringValue } from "../../lib/builders-shared.js";
import { parseDashboardRunLimit } from "../../numeric-options.js";
import path from "node:path";
import type { DashboardGraphPreset, DashboardGraphPresetFilters, DashboardWorkflowStageRun, FocusedStageDeltaSummary, FocusedStageOutcomeSummary } from "../../commands/daemon-types.js";

export function dashboardGraphPresetsPath(projectDir: string): string {
  return path.join(projectDir, ".agent-workflow", "graph-presets.json");
}

export function graphPresetHref(preset: DashboardGraphPreset): string {
  return workflowGraphDashboardHref(preset.filters.workflow, preset.filters.project, preset.filters.policyProfile, {
    view: preset.filters.view,
    orientation: preset.filters.orientation,
    category: preset.filters.category,
    approval: preset.filters.approval,
    policyStatus: preset.filters.policyStatus,
    runLimit: preset.filters.runLimit,
    runStatus: preset.filters.runStatus,
    runScope: preset.filters.runScope,
    capture: false,
    stage: preset.filters.stage
  });
}

export function normalizeDashboardGraphPresetFilters(filters: Record<string, unknown>): DashboardGraphPresetFilters {
  const view = stringValue(filters.view);
  const orientation = stringValue(filters.orientation);
  return {
    workflow: stringValue(filters.workflow)?.trim() || "build-feature",
    project: stringValue(filters.project)?.trim() || "templates/project",
    policyProfile: stringValue(filters.policyProfile)?.trim() || "local",
    view: view === "mind-map" || view === "network" ? view : "graph",
    orientation: orientation === "radial" ? "radial" : "horizontal",
    category: stringValue(filters.category)?.trim() || "",
    approval: stringValue(filters.approval)?.trim() || "all",
    policyStatus: stringValue(filters.policyStatus)?.trim() || "all",
    runStatus: parseDashboardRunStatusFilter(stringValue(filters.runStatus) ?? "all"),
    runLimit: String(parseDashboardRunLimit(stringValue(filters.runLimit) ?? "50", 50)),
    runScope: parseDashboardRunScope(stringValue(filters.runScope) ?? "project"),
    stage: stringValue(filters.stage)?.trim() || ""
  };
}

export function percentRate(count: number, total: number): number | null {
  if (!total) return null;
  return Math.round((count / total) * 1000) / 10;
}

export function rateDelta(after: number | null, before: number | null): number | null {
  if (after === null || before === null) return null;
  return Math.round((after - before) * 10) / 10;
}

export function summarizeFocusedStageDelta(baselineRows: DashboardWorkflowStageRun[], verificationRows: DashboardWorkflowStageRun[]): FocusedStageDeltaSummary {
  const baseline = summarizeFocusedStageOutcomes(baselineRows);
  const verification = summarizeFocusedStageOutcomes(verificationRows);
  const completedDelta = rateDelta(verification.completedRate, baseline.completedRate);
  const failedDelta = rateDelta(verification.failedRate, baseline.failedRate);
  const activeDelta = rateDelta(verification.activeRate, baseline.activeRate);
  let label = "Need verification";
  if (verification.total > 0 && completedDelta !== null && failedDelta !== null) {
    if (failedDelta < 0 || completedDelta > 0) {
      label = "Improved";
    } else if (failedDelta > 0 || completedDelta < 0) {
      label = "Regressed";
    } else {
      label = "No change";
    }
  }
  return { baseline, verification, completedDelta, failedDelta, activeDelta, label };
}

export function summarizeFocusedStageOutcomes(rows: DashboardWorkflowStageRun[]): FocusedStageOutcomeSummary {
  const total = rows.length;
  const completed = rows.filter((row) => row.taskStatus === "completed").length;
  const failed = rows.filter((row) => row.taskStatus === "failed").length;
  const active = rows.filter((row) => row.taskStatus === "queued" || row.taskStatus === "running").length;
  const cancelled = rows.filter((row) => row.taskStatus === "cancelled").length;
  return {
    total,
    completed,
    failed,
    active,
    cancelled,
    completedRate: percentRate(completed, total),
    failedRate: percentRate(failed, total),
    activeRate: percentRate(active, total)
  };
}

export function workflowGraphDashboardHref(
  workflowId: string,
  project: string,
  policyProfile: string,
  options: { view: string; orientation?: "horizontal" | "radial"; category: string; approval: string; policyStatus: string; runLimit: string; runStatus: string; runScope?: "project" | "all-projects"; capture: boolean; stage?: string }
): string {
  const query = new URLSearchParams({
    workflow: workflowId,
    project,
    policyProfile,
    view: options.view
  });
  if (options.view === "network" && options.orientation === "radial") query.set("orientation", "radial");
  if (options.category) query.set("category", options.category);
  if (options.approval !== "all") query.set("approval", options.approval);
  if (options.policyStatus !== "all") query.set("policyStatus", options.policyStatus);
  if (options.runLimit !== "50") query.set("runLimit", options.runLimit);
  if (options.runStatus !== "all") query.set("runStatus", options.runStatus);
  if (options.runScope === "all-projects") query.set("runScope", "all-projects");
  if (options.stage) query.set("stage", options.stage);
  if (options.capture) query.set("capture", "1");
  return `/workflow-graph?${query.toString()}`;
}
