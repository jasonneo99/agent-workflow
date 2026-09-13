export const supervisedDaemonLanes = ["evidence-collector", "workflow-optimizer", "action-executor", "runtime-maintenance", "repository-steward", "release-ci-guardian", "security-sentinel", "backup-recovery-verifier"];

export function supervisedDaemonLaneStatus(learningEnabled) {
  return supervisedDaemonLanes.map((id) => ({ id, process: "learning-daemon", status: learningEnabled ? "supervised" : "disabled" }));
}
