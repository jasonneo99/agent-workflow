import assert from "node:assert/strict";
import test from "node:test";
import { clearEgressLog, logEgress, parseEgressUrl, readEgressLog, summarizeEgress } from "./egress-log.js";

test("parseEgressUrl strips query params and extracts host", () => {
  const { host, endpoint } = parseEgressUrl("https://api.meta.ai/v1/chat/completions?foo=bar");
  assert.equal(host, "api.meta.ai");
  assert.equal(endpoint, "/v1/chat/completions");
});

test("parseEgressUrl handles invalid URLs", () => {
  const { host } = parseEgressUrl("not-a-url");
  assert.equal(host, "unknown");
});

test("logEgress records entries with timestamps", () => {
  clearEgressLog();
  const entry = logEgress({
    providerId: "muse",
    host: "api.meta.ai",
    endpoint: "/v1/chat/completions",
    method: "POST",
    promptTokens: 100,
    completionTokens: 50,
    durationMs: 1234,
  });
  assert.ok(entry.timestamp);
  assert.equal(entry.providerId, "muse");
  const entries = readEgressLog();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].promptTokens, 100);
});

test("summarizeEgress aggregates by provider and host", () => {
  clearEgressLog();
  logEgress({ providerId: "muse", host: "api.meta.ai", endpoint: "/", method: "POST", durationMs: 100, promptTokens: 10, completionTokens: 5 });
  logEgress({ providerId: "muse", host: "api.meta.ai", endpoint: "/", method: "POST", durationMs: 200, promptTokens: 20, completionTokens: 10 });
  logEgress({ providerId: "anthropic", host: "api.anthropic.com", endpoint: "/", method: "POST", durationMs: 300, error: "timeout" });
  const summary = summarizeEgress();
  assert.equal(summary.length, 2);
  const muse = summary.find((s) => s.providerId === "muse");
  assert.equal(muse?.calls, 2);
  assert.equal(muse?.promptTokens, 30);
  assert.equal(muse?.errors, 0);
  const anthropic = summary.find((s) => s.providerId === "anthropic");
  assert.equal(anthropic?.errors, 1);
  clearEgressLog();
});

test("logEgress caps at 1000 entries", () => {
  clearEgressLog();
  for (let i = 0; i < 1005; i++) {
    logEgress({ providerId: "test", host: "example.com", endpoint: "/", method: "GET", durationMs: 1 });
  }
  assert.equal(readEgressLog(2000).length, 1000);
  clearEgressLog();
});
