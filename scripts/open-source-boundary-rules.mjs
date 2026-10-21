import path from "node:path";

export const privateDeploymentTerms = [
  "loki",
  "heimdall",
  "hulk",
  "jarvis",
  "fleet-config",
  "makealeft",
  "tellara",
  "truckoutfitters"
];

const allowedUserNames = new Set(["example", "me", "person", "runner", "user", "you"]);
const allowedBinaryExtensions = new Set([
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".otf",
  ".pdf",
  ".png",
  ".ttf",
  ".webp",
  ".woff",
  ".woff2"
]);
const allowedBinaryPaths = new Set(["plugins/agent-workflow/runtime-bundle.tgz"]);
const allowedTemplateRoots = new Set(["project", "project-simple", "provider-smoke"]);
const forbiddenTemplateRuntime = /^templates\/[^/]+\/\.agent-workflow\/(?:context-gateway|evals|exports|learning|migrations|model-improvement|offline|plans|reports|runs|runtime|tuning)(?:\/|$)/u;

export function packagePathViolations(file) {
  const violations = [];
  if (!file.startsWith("templates/")) return violations;
  const root = file.split("/")[1] ?? "";
  if (!allowedTemplateRoots.has(root) && file !== "templates/template-manifest.json") {
    violations.push(`private or undeclared template root (${root || file})`);
  }
  if (forbiddenTemplateRuntime.test(file)) {
    violations.push("template runtime state is not publishable");
  }
  if (/^templates\/[^/]+\/\.agent-workflow\/evaluations\/.*\.(?:json|md)$/u.test(file)) {
    violations.push("template evaluation result is not publishable");
  }
  return violations;
}

export function packageProvenanceViolations(packageFiles, trackedFiles) {
  const tracked = trackedFiles instanceof Set ? trackedFiles : new Set(trackedFiles);
  const violations = [];
  for (const file of packageFiles) {
    if (!tracked.has(file) && !file.startsWith("dist/")) {
      violations.push(`${file}: package entry is neither tracked source nor generated dist output`);
    }
    for (const reason of packagePathViolations(file)) violations.push(`${file}: ${reason}`);
  }
  return violations;
}

export function scanBoundaryFile(file, buffer, options = {}) {
  const violations = [];
  const add = (label, value) => violations.push(`${file}: ${label} (${value})`);
  const normalizedFile = file.toLowerCase();
  const packageEntry = options.packageEntry === true;

  for (const term of privateDeploymentTerms) {
    if (normalizedFile.includes(term)) add("private deployment identifier in path", term);
  }

  const isBinary = buffer.includes(0);
  if (isBinary) {
    const extension = path.extname(file).toLowerCase();
    if (!allowedBinaryExtensions.has(extension) && !allowedBinaryPaths.has(file)) add("unreviewed binary file", extension || "no extension");
  }

  const text = buffer.toString(isBinary ? "latin1" : "utf8");
  const markedSyntheticFixture = /boundary-synthetic-fixtures/u.test(text) && /(?:^|\/)\w[^/]*\.test\.[cm]?[jt]sx?$/u.test(file);

  for (const term of privateDeploymentTerms) {
    if (new RegExp(`\\b${term}\\b`, "iu").test(text)) add("private deployment identifier", term);
  }
  for (const match of text.matchAll(/\b[A-Za-z0-9-]+\.ts\.net\b/giu)) add("private tailnet domain", match[0]);
  for (const match of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) {
    if (!allowedUserNames.has(match[1].toLowerCase())) add("machine-specific user path", match[0]);
  }
  for (const match of text.matchAll(/\b100(?:\.\d{1,3}){3}\b/g)) add("private-network address", match[0]);
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi)) {
    const address = match[0].toLowerCase();
    const domain = match[1].toLowerCase();
    if (address !== "git@github.com" && !/^example\.(?:com|local|test)$/u.test(domain)) add("email address", match[0]);
  }

  const credentialPatterns = [
    ["OpenAI-style credential", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
    ["private key material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g]
  ];
  for (const [label, pattern] of credentialPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (!markedSyntheticFixture) add(label, match[0].slice(0, 24));
    }
  }

  if (/\bjasonmiller\b/iu.test(text) || /\bJason Miller\b/u.test(text)) add("personal identifier", "maintainer-local identity");
  if (packageEntry && /(?:^|\/)\.env(?:\.|$)/u.test(file) && file !== ".env.example") add("private environment file", file);
  return violations;
}
