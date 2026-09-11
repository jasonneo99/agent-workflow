export type LearningDaemonMode = "observe" | "propose" | "apply-approved";

const modeRank: Record<LearningDaemonMode, number> = {
  observe: 0,
  propose: 1,
  "apply-approved": 2
};

export function restrictLearningDaemonMode(requested: LearningDaemonMode, configured: LearningDaemonMode): LearningDaemonMode {
  return modeRank[requested] <= modeRank[configured] ? requested : configured;
}

export function restrictLearningDaemonLimit(requested: number, configured: number): number {
  return Math.max(1, Math.min(requested, configured));
}
