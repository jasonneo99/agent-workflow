export type FailureOwner = "agent-workflow-runtime" | "product-source" | "project-policy" | "external-native" | "unknown";
export interface FailureOwnership {
  owner: FailureOwner;
  codeFix: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
  evidenceRunId: string;
  repairRoute: "agent-workflow-runtime" | "originating-product-repository" | "originating-project-policy" | "external-evidence-owner" | "manual-triage";
  requiredWorkerCapability: string | null;
}

/** Evidence-only routing classification. It never grants repair, replay or
 * cross-repository write authority. Prefer unknown to guessing ownership. */
export function classifyFailureOwnership(input:{runId:string;failureReason?:string|null;commandLine?:string|null;stderr?:string|null}):FailureOwnership{
 const reason=(input.failureReason??'').trim(),command=(input.commandLine??'').trim(),stderr=(input.stderr??'').trim();
 if(/python(?:3(?:\.\d+)?)? -m py_compile\b/u.test(command)&&command.includes('*')
  &&/(?:No such file or directory|can't open file).*\*\.py/iu.test(stderr))return {owner:'agent-workflow-runtime',codeFix:true,confidence:'high',evidenceRunId:input.runId,
   repairRoute:'agent-workflow-runtime',requiredWorkerCapability:'python-pycompile-glob-v1',reason:'A policy-approved Python compilation wildcard reached the shell-free executor literally; the orchestration runtime owns expansion compatibility.'};
 if(/not allowed by project policy|blocked pattern|command policy|write path|allowed write paths?/iu.test(`${reason}\n${stderr}`))return {owner:'project-policy',codeFix:false,confidence:'high',evidenceRunId:input.runId,
  repairRoute:'originating-project-policy',requiredWorkerCapability:null,reason:'Current project policy, rather than product behavior, refused the requested effect.'};
 if(/physical|connected (?:iphone|device)|signing|credential|native proof|live installation|external dependency/iu.test(`${reason}\n${stderr}`))return {owner:'external-native',codeFix:false,confidence:'medium',evidenceRunId:input.runId,
  repairRoute:'external-evidence-owner',requiredWorkerCapability:null,reason:'The recorded blocker requires external or native evidence that source changes alone cannot establish.'};
 if(/AssertionError|SyntaxError|TypeError|ReferenceError|FAILED \(|tests? failed|compilation failed/iu.test(`${reason}\n${stderr}`))return {owner:'product-source',codeFix:true,confidence:'medium',evidenceRunId:input.runId,
  repairRoute:'originating-product-repository',requiredWorkerCapability:null,reason:'The recorded diagnostic demonstrates a product source or regression failure, subject to canonical-source confirmation.'};
 return {owner:'unknown',codeFix:false,confidence:'low',evidenceRunId:input.runId,repairRoute:'manual-triage',requiredWorkerCapability:null,reason:'Stored evidence does not safely identify the repository that owns the defect.'};
}
