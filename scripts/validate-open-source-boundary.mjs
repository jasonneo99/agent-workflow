import fs from "node:fs";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const allowedUserNames = new Set(["example", "me", "person", "runner", "user", "you"]);
const violations = [];
const privateDeploymentTerms = ["loki", "heimdall", "hulk", "jarvis", "fleet-config", "makealeft"];

function add(file, label, value) {
  violations.push(`${file}: ${label} (${value})`);
}

for (const file of files) {
  if (file === "scripts/validate-open-source-boundary.mjs") continue;
  if (!fs.existsSync(file)) continue;
  const normalizedFile = file.toLowerCase();
  for (const term of privateDeploymentTerms) {
    if (normalizedFile.includes(term)) add(file, "private deployment identifier in path", term);
  }
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  const markedSyntheticFixture = /boundary-synthetic-fixtures/u.test(text) && /(?:^|\/)\w[^/]*\.test\.[cm]?[jt]sx?$/u.test(file);

  for (const term of privateDeploymentTerms) {
    if (new RegExp(`\\b${term}\\b`, "iu").test(text)) add(file, "private deployment identifier", term);
  }
  for (const match of text.matchAll(/\b[A-Za-z0-9-]+\.ts\.net\b/giu)) add(file, "private tailnet domain", match[0]);

  for (const match of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) {
    if (!allowedUserNames.has(match[1].toLowerCase())) add(file, "machine-specific user path", match[0]);
  }
  for (const match of text.matchAll(/\b100(?:\.\d{1,3}){3}\b/g)) add(file, "private-network address", match[0]);
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi)) {
    const address = match[0].toLowerCase();
    const domain = match[1].toLowerCase();
    if (address !== "git@github.com" && !/^example\.(?:com|local|test)$/u.test(domain)) add(file, "email address", match[0]);
  }

  const credentialPatterns = [
    ["OpenAI-style credential", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
    ["private key material", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g]
  ];
  for (const [label, pattern] of credentialPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (!markedSyntheticFixture) add(file, label, match[0].slice(0, 24));
    }
  }

  if (/\bjasonmiller\b/iu.test(text) || /\bJason Miller\b/u.test(text)) add(file, "personal identifier", "maintainer-local identity");
}

if (violations.length) {
  console.error("Open-source boundary validation failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  console.error("Generalize, scrub, or move this material to a private companion repository.");
  process.exit(1);
}

console.log(`Open-source boundary validated across ${files.length} tracked files.`);
