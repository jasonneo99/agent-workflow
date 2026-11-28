/** A safe default run environment for a newly initialized project.
 *
 * init-project writes one only when the stack has a supported behavioral test
 * contract: Node's built-in runner (`node --test` behind `npm test`), pytest or
 * unittest. The profile is native: it uses the toolchain already installed on
 * this host's exact platform, inside the existing command sandbox, and installs
 * nothing. The command allowlist it pairs with holds only test, build,
 * typecheck and lint commands plus the readiness probe and Agent Workflow's
 * environment and repair-checkpoint capabilities; deploys, publishing, package
 * installs and git push stay outside it. Every other
 * stack gets no profile and a message saying what to declare instead. */

import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

import { REPAIR_COMMIT_COMMAND } from "../../../../packages/run-environments/src/repair-checkpoint.js";
import { ENVIRONMENT_COMMAND } from "../../../../packages/run-environments/src/schema.js";

/** Agent Workflow's own capability entries that source-changing workflows
 * require: run environments, and local repair checkpoint commits (git push
 * stays blocked). They are not project shell commands. */
const WORKFLOW_CAPABILITIES = [ENVIRONMENT_COMMAND, REPAIR_COMMIT_COMMAND];

export interface DefaultEnvironment {
  stack: "node" | "python";
  profileName: string;
  environments: {
    default_profile: string;
    profiles: Record<string, Record<string, unknown>>;
  };
  allowedCommands: string[];
  testCommand: string;
}

export type DefaultEnvironmentResult =
  | { ok: true; environment: DefaultEnvironment }
  | { ok: false; reason: string };

const UNSUPPORTED_HINT = "Add execution.environments to .agent-workflow/project.yaml yourself (see docs/run-environments.md).";

/** This host as an environment platform, e.g. darwin/arm64 or linux/amd64. */
export function hostEnvironmentPlatform(platform: string = process.platform, arch: string = process.arch): string | null {
  const os = ["darwin", "linux", "win32"].includes(platform) ? platform : null;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  return os && cpu ? `${os}/${cpu}` : null;
}

async function readText(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); } catch { return null; }
}

async function isFile(file: string): Promise<boolean> {
  try { return (await fs.lstat(file)).isFile(); } catch { return false; }
}

async function isDirectory(file: string): Promise<boolean> {
  try { return (await fs.lstat(file)).isDirectory(); } catch { return false; }
}

/** Whether the project's read policy lets an explicitly named file enter the
 * environment. Explicit files outside it would fail planning; files inside a
 * named directory are filtered by the same policy when the snapshot is taken. */
export type ReadAllowed = (relativePath: string) => boolean;

/** Existing directories, and existing files the read policy allows, in order. */
async function existing(root: string, candidates: string[], readable: ReadAllowed): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of candidates) {
    const stat = await fs.lstat(path.join(root, candidate)).catch(() => null);
    if (stat && !stat.isSymbolicLink() && (stat.isDirectory() || (stat.isFile() && readable(candidate)))) found.push(candidate);
  }
  return found;
}

function nativeProfile(platform: string, input: { sourcePaths: string[]; dependencyPaths: string[]; readiness: string[]; testCommand: string; format: "node-test" | "pytest" | "unittest" }) {
  return {
    kind: "native",
    platform,
    source_paths: input.sourcePaths,
    dependency_paths: input.dependencyPaths,
    readiness: [{ argv: input.readiness }],
    verification: [{ commands: [input.testCommand], format: input.format, minimum_tests: 1 }]
  };
}

async function detectNode(root: string, platform: string, readable: ReadAllowed): Promise<DefaultEnvironmentResult | null> {
  const manifest = await readText(path.join(root, "package.json"));
  if (manifest === null) return null;
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(manifest) as { scripts?: unknown };
    if (parsed.scripts && typeof parsed.scripts === "object") scripts = parsed.scripts as Record<string, unknown>;
  } catch {
    return { ok: false, reason: `package.json is not valid JSON, so no default environment profile was written. ${UNSUPPORTED_HINT}` };
  }
  const test = typeof scripts.test === "string" ? scripts.test : "";
  if (!/\bnode\b[^&|;]*\s--test\b/u.test(test)) {
    return { ok: false, reason: `package.json has no "test" script that runs node --test, so no default environment profile was written. Supported default test runners are node --test, pytest and unittest. ${UNSUPPORTED_HINT}` };
  }
  const testCommand = "npm test";
  const extra = ["build", "typecheck", "lint"].filter(name => typeof scripts[name] === "string").map(name => `npm run ${name}`);
  const sourcePaths = await existing(root, ["package.json", "src", "lib", "app", "bin", "test", "tests", "__tests__", "index.js", "index.mjs", "index.cjs", "index.ts", "tsconfig.json"], readable);
  const dependencyPaths = await existing(root, ["package-lock.json", "npm-shrinkwrap.json"], readable);
  if (!sourcePaths.length) return { ok: false, reason: `No Node source or test paths that the project's read policy allows were found, so no default environment profile was written. ${UNSUPPORTED_HINT}` };
  const profileName = "node-tests";
  return { ok: true, environment: {
    stack: "node", profileName, testCommand,
    environments: { default_profile: profileName, profiles: { [profileName]: nativeProfile(platform, { sourcePaths, dependencyPaths, readiness: ["node", "--version"], testCommand, format: "node-test" }) } },
    allowedCommands: [...WORKFLOW_CAPABILITIES, "node --version", testCommand, ...extra]
  } };
}

async function detectPython(root: string, platform: string, readable: ReadAllowed): Promise<DefaultEnvironmentResult | null> {
  const pyproject = await readText(path.join(root, "pyproject.toml")) ?? "";
  const requirements = (await Promise.all(["requirements.txt", "requirements-dev.txt", "requirements-test.txt"].map(file => readText(path.join(root, file))))).join("\n");
  const testDirectories = await existing(root, ["tests", "test"], () => true);
  const hasProjectFiles = Boolean(pyproject) || Boolean(requirements.trim()) || await isFile(path.join(root, "setup.py")) || await isFile(path.join(root, "setup.cfg"));
  let hasTestModules = false;
  for (const directory of testDirectories) {
    if (!await isDirectory(path.join(root, directory))) continue;
    const entries = await fs.readdir(path.join(root, directory)).catch(() => [] as string[]);
    if (entries.some(entry => /^test.*\.py$/u.test(entry))) hasTestModules = true;
  }
  if (!hasProjectFiles && !hasTestModules) return null;
  const pytest = /\[tool\.pytest/u.test(pyproject) || /^\s*pytest\b/mu.test(requirements) || /["']pytest\b/u.test(pyproject)
    || await isFile(path.join(root, "pytest.ini")) || await isFile(path.join(root, "conftest.py"))
    || (await Promise.all(testDirectories.map(directory => isFile(path.join(root, directory, "conftest.py"))))).some(Boolean);
  if (!pytest && !hasTestModules) {
    return { ok: false, reason: `No pytest configuration or tests/test_*.py modules were found, so no default environment profile was written. ${UNSUPPORTED_HINT}` };
  }
  const testCommand = pytest ? "python3 -m pytest" : "python3 -m unittest discover";
  const extra: string[] = [];
  if (/\[tool\.mypy\]/u.test(pyproject) || await isFile(path.join(root, "mypy.ini"))) extra.push("python3 -m mypy .");
  if (/\[tool\.ruff/u.test(pyproject) || await isFile(path.join(root, "ruff.toml"))) extra.push("python3 -m ruff check .");
  const entries = await fs.readdir(root).catch(() => [] as string[]);
  const packages: string[] = [];
  for (const entry of entries.sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry) || ["tests", "test", "src"].includes(entry)) continue;
    if (await isFile(path.join(root, entry, "__init__.py"))) packages.push(entry);
  }
  const sourcePaths = await existing(root, ["pyproject.toml", "setup.py", "setup.cfg", "src", ...packages, "tests", "test", "conftest.py", "pytest.ini"], readable);
  const dependencyPaths = await existing(root, ["requirements.txt", "requirements-dev.txt", "requirements-test.txt", "poetry.lock", "uv.lock"], readable);
  if (!sourcePaths.length) return { ok: false, reason: `No Python source or test paths that the project's read policy allows were found, so no default environment profile was written. ${UNSUPPORTED_HINT}` };
  const profileName = "python-tests";
  return { ok: true, environment: {
    stack: "python", profileName, testCommand,
    environments: { default_profile: profileName, profiles: { [profileName]: nativeProfile(platform, { sourcePaths, dependencyPaths, readiness: ["python3", "--version"], testCommand, format: pytest ? "pytest" : "unittest" }) } },
    allowedCommands: [...WORKFLOW_CAPABILITIES, "python3 --version", testCommand, ...extra]
  } };
}

/** Detect a supported stack and build its default native profile. */
export async function detectDefaultEnvironment(projectDir: string, options: { platform?: string | null; readable?: ReadAllowed } = {}): Promise<DefaultEnvironmentResult> {
  const platform = options.platform === undefined ? hostEnvironmentPlatform() : options.platform;
  const readable = options.readable ?? (() => true);
  if (!platform) return { ok: false, reason: `This host's platform (${process.platform}/${process.arch}) has no native environment target, so no default environment profile was written. ${UNSUPPORTED_HINT}` };
  const root = path.resolve(projectDir);
  const detected = await detectNode(root, platform, readable) ?? await detectPython(root, platform, readable);
  return detected ?? { ok: false, reason: `No Node (package.json) or Python project was detected, so no default environment profile was written. ${UNSUPPORTED_HINT}` };
}

/** Merge the default profile into a just-initialized project.yaml: it sets
 * execution.environments and replaces actions.allowed_commands with the safe
 * list. Blocked commands and every other setting are kept. */
export async function writeDefaultEnvironment(projectDir: string, environment: DefaultEnvironment): Promise<void> {
  const configPath = path.join(projectDir, ".agent-workflow", "project.yaml");
  const raw = (YAML.parse(await fs.readFile(configPath, "utf8")) ?? {}) as Record<string, unknown>;
  const object = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
  const execution = object(raw.execution);
  if (execution.environments) throw Error("project.yaml already declares execution.environments; it was left unchanged.");
  execution.environments = environment.environments;
  raw.execution = execution;
  const actions = object(raw.actions);
  actions.allowed_commands = environment.allowedCommands;
  raw.actions = actions;
  await fs.writeFile(configPath, YAML.stringify(raw), "utf8");
}
