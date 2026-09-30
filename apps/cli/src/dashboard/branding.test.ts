import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.ts", import.meta.url), "utf8");

test("dashboard serves and renders the Agent Workflow brand assets", () => {
  assert.match(source, /\/assets\/agent-workflow-logo\.png/);
  assert.match(source, /\/assets\/agent-workflow-mark\.png/);
  assert.match(source, /\/assets\/agent-workflow-favicon\.png/);
  assert.match(source, /class="nav-brand-link"/);
  assert.match(source, /aria-label="Agent Workflow home"/);
  assert.match(styles, /\.nav-brand-link img/);
});

test("committed brand assets are available to packaged documentation", () => {
  const brandingDir = new URL("../../../../docs/assets/branding/", import.meta.url);
  for (const name of ["agent-workflow-logo-v1.png", "agent-workflow-mark-v1.png", "agent-workflow-favicon-v1.png"]) {
    assert.equal(existsSync(new URL(name, brandingDir)), true, `${name} should exist`);
  }
});
