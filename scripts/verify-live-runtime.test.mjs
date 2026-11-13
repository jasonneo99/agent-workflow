import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./verify-live-runtime.mjs", import.meta.url), "utf8");

test("live verifier binds source, process identity, APIs and responsive layout", () => {
  assert.match(source, /source-loaded:/u);
  assert.match(source, /runtimeRole/u);
  assert.match(source, /dashboard/u);
  assert.match(source, /lsof/u);
  assert.match(source, /minute-history-contract/u);
  assert.match(source, /responsive-layout:/u);
  assert.match(source, /documentElement\.scrollWidth>document\.documentElement\.clientWidth/u);
  assert.match(source, /acceptanceClaimed: false/u);
  assert.match(source, /routeTimings/u);
  assert.match(source, /previousRouteTimings/u);
  assert.match(source, /route-latency:/u);
});

test("live verifier stays on loopback and writes a private bounded report", () => {
  assert.match(source, /127\.0\.0\.1/u);
  assert.match(source, /limited to a loopback dashboard/u);
  assert.match(source, /live-runtime-verification\.json/u);
  assert.match(source, /mode: 0o600/u);
  assert.doesNotMatch(source, /process\.env\)/u);
});
