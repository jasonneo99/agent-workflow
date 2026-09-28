import { projectConfigSchema } from "../../agent-registry/src/schemas.js";

export function applyCurrentAutoApprovalThreshold(
  snapshot: ReturnType<typeof projectConfigSchema.parse>,
  current: ReturnType<typeof projectConfigSchema.parse>,
  environment: NodeJS.ProcessEnv = process.env
): ReturnType<typeof projectConfigSchema.parse> {
  const autopilotSetting = environment.AGENTFLOW_APPROVAL_AUTOPILOT?.trim().toLowerCase();
  const environmentThreshold = environment.AGENTFLOW_APPROVAL_AUTOPILOT_MAX_RISK?.trim().toLowerCase();
  const configuredThreshold = current.actions.auto_approve_max_risk;
  const effectiveThreshold = autopilotSetting === "on" || autopilotSetting === "true" || autopilotSetting === "1"
    ? environmentThreshold === "low" || environmentThreshold === "medium" || environmentThreshold === "high"
      ? environmentThreshold
      : "medium"
    : autopilotSetting === "off" || autopilotSetting === "false" || autopilotSetting === "0"
      ? "none"
      : configuredThreshold;
  return projectConfigSchema.parse({
    ...snapshot,
    actions: { ...snapshot.actions, auto_approve_max_risk: effectiveThreshold }
  });
}
