import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";
import { agentCardSchema } from "./schemas.js";

const root = new URL("../../../", import.meta.url);

test("UX agents integrate platform standards into normal guidance", () => {
  for (const file of ["agents/product/ux-reviewer-mira.yaml", "agents/development/frontend-engineer.yaml"]) {
    const card = agentCardSchema.parse(YAML.parse(readFileSync(new URL(file, root), "utf8")));
    assert.ok(card.context_budget.preferred_sources.includes("docs/ux-standards.md"));
    assert.match(card.prompt, /Apple HIG|Apple Human Interface Guidelines/u);
    assert.match(card.prompt, /Material Design/u);
    assert.match(card.prompt, /Fluent/u);
    assert.match(card.prompt, /WCAG/u);
  }
});

test("standards registry keeps authoritative sources and evidence semantics explicit", () => {
  const guidance = readFileSync(new URL("docs/ux-standards.md", root), "utf8");
  assert.match(guidance, /developer\.apple\.com\/design\/human-interface-guidelines/u);
  assert.match(guidance, /w3\.org\/TR\/WCAG22/u);
  assert.match(guidance, /m3\.material\.io/u);
  assert.match(guidance, /fluent2\.microsoft\.design/u);
  assert.match(guidance, /requirement[\s\S]+recommendation[\s\S]+polish/u);
  assert.match(guidance, /verification needed/u);
});
