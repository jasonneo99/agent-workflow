import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluationSlot } from "./execution.js";

for (const state of ["locked", "active", "success", "failure"]) {
  test(`evaluation slot: ${state}`, async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    let ran = false;
    const query = async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: sql.includes("pg_try") ? [{ acquired: state !== "locked" }] : sql.includes("SELECT w.id") && state === "active" ? [{ id: "existing" }] : [] };
    };
    const result = evaluationSlot(query, "synthetic-project", "smoke", async () => {
      ran = true;
      if (state === "failure") throw new Error("synthetic failure");
      return 42;
    });
    if (state === "failure") await assert.rejects(result, /synthetic failure/);
    else assert.deepEqual(await result, state === "success" ? { skipped: false, value: 42 } : { skipped: true });
    assert.equal(ran, state === "success" || state === "failure");
    assert.equal(calls.some(c => c.sql.includes("pg_advisory_unlock")), state !== "locked");
    if (state !== "locked") assert.deepEqual(calls[1].values, ["synthetic-project", "smoke"]);
  });
}
