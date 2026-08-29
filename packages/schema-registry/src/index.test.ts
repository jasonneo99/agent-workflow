import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSchemaSummary, buildVsCodeSettings } from "./index.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("registered schema files exist and contain json schema ids", async () => {
  const schemas = buildSchemaSummary(rootDir);
  assert.equal(schemas.length, 5);

  for (const schema of schemas) {
    const raw = await fs.readFile(schema.path, "utf8");
    const parsed = JSON.parse(raw) as { $schema?: string; $id?: string; title?: string };
    assert.match(parsed.$schema ?? "", /json-schema/);
    assert.match(parsed.$id ?? "", new RegExp(`${schema.id === "schedules" ? "schedules" : schema.id}\\.schema\\.json$`));
    assert.equal(parsed.title, schema.title);
  }
});

test("vscode settings map schemas to agent workflow yaml files", () => {
  const settings = buildVsCodeSettings(rootDir);
  const schemas = settings["yaml.schemas"] as Record<string, string[]>;
  const globs = Object.values(schemas).flat();

  assert.ok(globs.includes(".agent-workflow/project.yaml"));
  assert.ok(globs.includes(".agent-workflow/schedules.yaml"));
  assert.ok(globs.includes(".agent-workflow/bundle-state.json"));
  assert.ok(globs.includes(".agent-workflow/agents/**/*.yaml"));
  assert.ok(globs.includes("workflows/**/*.yaml"));
});
