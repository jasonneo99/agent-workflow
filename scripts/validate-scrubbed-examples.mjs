import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const examplesDir = path.join(root, "docs", "examples");
const jsonPath = path.join(examplesDir, "scrubbed-run.json");
const markdownPath = path.join(examplesDir, "scrubbed-run.md");

const jsonText = fs.readFileSync(jsonPath, "utf8");
const markdown = fs.readFileSync(markdownPath, "utf8");
const document = JSON.parse(jsonText);
const combined = `${jsonText}\n${markdown}`;

const forbiddenPatterns = [
  /\/Users\/[A-Za-z0-9._-]+/,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /\bsk-proj-[A-Za-z0-9_-]{12,}\b/,
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /Compiled Agent Workflow Brief/,
  /password\s*=/i,
  /api[_-]?key\s*=/i,
  /tenantId/i,
  /customerId/i
];

for (const pattern of forbiddenPatterns) {
  if (pattern.test(combined)) {
    throw new Error(`Scrubbed example contains forbidden pattern: ${pattern}`);
  }
}

if (document.redacted !== true) {
  throw new Error("scrubbed-run.json must be marked redacted.");
}

if (document.run?.task !== "[REDACTED_TASK]") {
  throw new Error("scrubbed-run.json must redact the run task.");
}

if (document.run?.projectRootUri !== "[PROJECT_ROOT]") {
  throw new Error("scrubbed-run.json must redact the project root.");
}

if (!markdown.includes("- Redaction: scrubbed for sharing")) {
  throw new Error("scrubbed-run.md must advertise scrubbed sharing mode.");
}

const compiledBrief = document.artifacts?.find((artifact) => artifact.kind === "compiled_brief");
if (!compiledBrief?.content?.redacted) {
  throw new Error("compiled_brief artifact must be redacted.");
}

const unsafeArtifactKeys = new Set([
  "summary",
  "findings",
  "nextAction",
  "workflowTask",
  "stdout",
  "stderr"
]);

for (const artifact of document.artifacts ?? []) {
  for (const key of unsafeArtifactKeys) {
    if (artifact.content?.[key] && artifact.content[key] !== "[REDACTED]") {
      throw new Error(`Artifact ${artifact.id ?? artifact.uri} must redact ${key}.`);
    }
  }
}

console.log("Scrubbed examples validated.");
