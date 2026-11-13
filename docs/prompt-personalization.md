# Evidence-gated prompt personalization

Agent Workflow can use a project-local model to propose a compact advisory brief for a base-model task. The local model does not execute the task, alter the original request, grant authority, consume approvals, or change policy.

Each candidate is isolated by workflow task class and the hash of the original requirements. It begins in shadow mode. Paired baseline and candidate observations record quality, verification, safety, latency, and token use. A candidate switches on automatically only after the configured minimum sample count shows a quality improvement without safety or verification regressions and within latency and token budgets.

Promoted briefs are appended to the provider input with an explicit advisory boundary. Receipts expose only the candidate and model hashes, not private prompt text. Changed requirements do not inherit an older brief. A safety failure, a verification regression, or sustained quality degradation immediately rolls the candidate back; rolled-back candidates are no longer selected.

The initial defaults require 20 paired samples, at least a 0.03 mean quality gain, no more than 15% mean latency regression, and no more than 10% mean token regression. Tests may provide smaller thresholds, but production callers should retain or tighten these defaults.
