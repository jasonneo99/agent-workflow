export type AgentWorkflowClientCapabilityContract = {
  kind: "agentflow_client_capabilities";
  schemaVersion: 1;
  runtimeVersion: string;
  compatibility: { minimumClientSchemaVersion: 1; maximumClientSchemaVersion: 1 };
  capabilities: Record<string, { supported: boolean; semantics: string }>;
};

export function buildClientCapabilityContract(runtimeVersion: string): AgentWorkflowClientCapabilityContract {
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(runtimeVersion)) throw new Error("A semantic runtime version is required.");
  return {
    kind: "agentflow_client_capabilities",
    schemaVersion: 1,
    runtimeVersion,
    compatibility: { minimumClientSchemaVersion: 1, maximumClientSchemaVersion: 1 },
    capabilities: {
      "orchestration.one-goal": { supported: true, semantics: "Agent Workflow owns decomposition, execution, retries, approvals, validation, and terminal state." },
      "progress.server-sent-events": { supported: true, semantics: "Clients may render bounded progress but do not infer completion." },
      "promotion.review": { supported: true, semantics: "Approve, defer, and reject decisions are receipted and reversible." },
      "approval.remote-mutation": { supported: false, semantics: "Remote mutation remains disabled unless governed server policy explicitly enables it." },
      "workflow.client-side-execution": { supported: false, semantics: "Clients submit intent and render evidence; they do not duplicate workflow stages." }
    }
  };
}
