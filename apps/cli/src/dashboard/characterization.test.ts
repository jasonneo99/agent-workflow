import assert from "node:assert/strict";
import test from "node:test";
import { compareSamples, extractDashboardRoutes, normalizeResponse } from "./characterization.js";

test("route extraction keeps GET routes with their query params and skips actions", () => {
  const source = [
    'if (requestUrl.pathname === "/runs") {',
    '  const status = requestUrl.searchParams.get("status");',
    "}",
    'if (requestUrl.pathname === "/run" || requestUrl.pathname === "/api/run") {',
    '  const id = requestUrl.searchParams.get("id");',
    "}",
    'if (request.method === "POST" && requestUrl.pathname === "/api/run-worker") {',
    "}",
    'if (requestUrl.pathname === "/api/clear-failed") {',
    "  const form = await readFormBody(request);",
    "}",
  ].join("\n");
  assert.deepEqual(extractDashboardRoutes(source), [
    { path: "/runs", params: ["status"] },
    { path: "/run", params: ["id"] },
    { path: "/api/run", params: ["id"] },
  ]);
});

test("normalization labels seeded values before stripping run-to-run noise", () => {
  const seeded = "11111111-2222-4333-8444-555555555555";
  const body = `<a href="/run?id=${seeded}">11111111</a> other 99999999-2222-4333-8444-555555555555 at 2026-11-26T23:00:01.123Z in 12ms nonce="abc"`;
  assert.equal(normalizeResponse(body, { labels: [[seeded, "<run:completed>"]] }),
    '<a href="/run?id=<run:completed>"><run:completed>:short</a> other <uuid> at <time> in #<duration> nonce="<token>"');
});

test("the hash ignores the order of rows that share a timestamp", async () => {
  const { hashNormalized } = await import("./characterization.js");
  assert.equal(hashNormalized("<li>a</li><li>b</li>"), hashNormalized("<li>b</li><li>a</li>"));
  assert.notEqual(hashNormalized("<li>a</li><li>b</li>"), hashNormalized("<li>a</li><li>c</li>"));
});

test("comparison reports status, type, body and missing changes", () => {
  const base = { contentType: "text/html", hash: "a", bytes: 1 };
  const changes = compareSamples(
    [{ key: "/a", status: 200, ...base }, { key: "/b", status: 200, ...base }, { key: "/c", status: 200, ...base }, { key: "/d", status: 200, ...base }],
    [{ key: "/a", status: 404, ...base }, { key: "/b", status: 200, ...base, hash: "b" }, { key: "/c", status: 200, ...base }],
  );
  assert.deepEqual(changes, [{ key: "/a", change: "status 200 -> 404" }, { key: "/b", change: "body changed (1 -> 1 bytes)" }, { key: "/d", change: "missing" }]);
  assert.deepEqual(compareSamples([{ key: "/b", status: 200, ...base, volatile: true }], [{ key: "/b", status: 200, ...base, hash: "b" }]), []);
});
