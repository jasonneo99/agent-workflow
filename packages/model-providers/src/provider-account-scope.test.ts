import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { providerAvailabilityScopeKey as scope } from "./provider-account-scope.js";

const adapters: Record<string, string> = {
  openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY", muse: "MUSE_API_KEY", gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY", byo: "BYO_MODEL_API_KEY",
  local: "LOCAL_MODEL_API_KEY", kiro: "KIRO_API_KEY"
};

for (const [provider, name] of Object.entries(adapters)) {
  test(`${provider}: shared credentials cross hosts, distinct credentials isolate`, () => {
    const first = scope(provider, { env: { [name]: "synthetic-credential-alpha" }, hostIdentity: "synthetic-host-a" });
    assert.equal(first, scope(provider, { env: { [name]: "synthetic-credential-alpha" }, hostIdentity: "synthetic-host-b" }));
    assert.notEqual(first, scope(provider, { env: { [name]: "synthetic-credential-beta" }, hostIdentity: "synthetic-host-a" }));
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.ok(!first.includes("synthetic-credential-alpha"));
    assert.ok(!first.includes("synthetic-host-a"));
  });
}

test("explicit scope preserves the existing formula across credential rotations", () => {
  const expected = createHash("sha256").update(JSON.stringify(["openai", "synthetic-account"])).digest("hex");
  for (const credential of ["synthetic-old", "synthetic-new"]) {
    assert.equal(scope("openai", { accountScope: "synthetic-account", env: { OPENAI_API_KEY: credential, AGENTFLOW_PROVIDER_ACCOUNT_SCOPE: "ignored" }, hostIdentity: "synthetic-host" }), expected);
    assert.equal(scope("openai", { env: { OPENAI_API_KEY: credential, AGENTFLOW_PROVIDER_ACCOUNT_SCOPE: "synthetic-account" } }), expected);
  }
  assert.equal(scope("openai", { accountScope: "", env: {} }), createHash("sha256").update(JSON.stringify(["openai", ""])).digest("hex"));
});

test("empty environment scope falls through to credential inference", () => {
  assert.equal(scope("openai", { env: { AGENTFLOW_PROVIDER_ACCOUNT_SCOPE: "", OPENAI_API_KEY: "synthetic-key" }, hostIdentity: "a" }), scope("openai", { env: { OPENAI_API_KEY: "synthetic-key" }, hostIdentity: "b" }));
});

test("provider identity separates explicit, credential and host scopes", () => {
  for (const options of [
    { accountScope: "synthetic-account", env: {} },
    { env: { OPENAI_API_KEY: "synthetic-key", ANTHROPIC_API_KEY: "synthetic-key" } },
    { env: {}, hostIdentity: "synthetic-host" }
  ]) assert.notEqual(scope("openai", options), scope("anthropic", options));
});

test("Gemini and compatible adapter fallback precedence matches configuration", () => {
  const primary = scope("gemini", { env: { GEMINI_API_KEY: "synthetic-primary" } });
  assert.equal(primary, scope("gemini", { env: { GEMINI_API_KEY: "synthetic-primary", GOOGLE_API_KEY: "synthetic-secondary", OPENAI_COMPATIBLE_API_KEY: "synthetic-third" } }));
  assert.equal(scope("gemini", { env: { GOOGLE_API_KEY: "synthetic-secondary" } }), scope("gemini", { env: { GEMINI_API_KEY: "", GOOGLE_API_KEY: "synthetic-secondary", OPENAI_COMPATIBLE_API_KEY: "synthetic-third" } }));
  for (const provider of ["gemini", "deepseek", "muse", "groq", "openrouter", "byo", "local"]) {
    assert.equal(scope(provider, { env: { OPENAI_COMPATIBLE_API_KEY: "synthetic-fallback" }, hostIdentity: "a" }), scope(provider, { env: { OPENAI_COMPATIBLE_API_KEY: "synthetic-fallback" }, hostIdentity: "b" }));
  }
});

test("unknown accounts use deterministic opaque host/principal fallback", () => {
  for (const provider of ["unknown", "codex-cli", "kiro", "local", "bedrock", "openai"]) {
    const options = { env: {}, hostIdentity: "synthetic-host/principal-a" };
    const key = scope(provider, options);
    assert.equal(key, scope(provider, options));
    assert.notEqual(key, scope(provider, { env: {}, hostIdentity: "synthetic-host/principal-b" }));
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.ok(!key.includes(options.hostIdentity));
  }
  assert.equal(scope("unknown", { env: {} }), scope("unknown", { env: {} }));
  assert.equal(scope("unknown", { env: { OPENAI_API_KEY: "synthetic-unrelated" }, hostIdentity: "a" }), scope("unknown", { env: {}, hostIdentity: "a" }));
});

test("Bedrock uses complete environment credentials and leaves unresolved profiles host scoped", () => {
  const env = { AWS_ACCESS_KEY_ID: "synthetic-access", AWS_SECRET_ACCESS_KEY: "synthetic-secret", AWS_SESSION_TOKEN: "synthetic-session" };
  const key = scope("bedrock", { env, hostIdentity: "a" });
  assert.equal(key, scope("bedrock", { env, hostIdentity: "b" }));
  assert.notEqual(key, scope("bedrock", { env: { ...env, AWS_SECRET_ACCESS_KEY: "synthetic-other" }, hostIdentity: "a" }));
  for (const unresolved of [{ AWS_PROFILE: "synthetic-profile", ...env }, { AWS_ACCESS_KEY_ID: "synthetic-access" }]) {
    assert.notEqual(scope("bedrock", { env: unresolved, hostIdentity: "a" }), scope("bedrock", { env: unresolved, hostIdentity: "b" }));
  }
});

test("inferred scope domains cannot collide with explicit scope strings", () => {
  const inferred = scope("openai", { env: { OPENAI_API_KEY: "synthetic-key" }, hostIdentity: "synthetic-host" });
  assert.notEqual(inferred, scope("openai", { accountScope: "synthetic-key", env: {} }));
  assert.notEqual(scope("openai", { env: {}, hostIdentity: "synthetic-key" }), inferred);
});
