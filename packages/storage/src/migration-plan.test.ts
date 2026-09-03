import assert from "node:assert/strict";
import test from "node:test";
import { buildStorageMigrationPlan, storageMigrationScript } from "./migration-plan.js";

test("storage migration plan infers a shared target host and redacts secrets", async () => {
  const plan = await buildStorageMigrationPlan({
    sourceEnv: {
      DATABASE_URL: "postgres://agentflow:local-secret@127.0.0.1:15432/agentflow",
      REDIS_URL: "redis://127.0.0.1:16379",
      OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:19000",
      OBJECT_STORAGE_BUCKET: "agentflow-artifacts"
    },
    targetHost: "hulk.local",
    targetEnv: {}
  });

  assert.match(plan.target.databaseUrl, /hulk\.local:15432/);
  assert.match(plan.target.redisUrl, /hulk\.local:16379/);
  assert.equal(plan.target.objectStorageEndpoint, "http://hulk.local:19000/");
  assert.equal(plan.target.objectStorageBucket, "agentflow-artifacts");
  assert.doesNotMatch(JSON.stringify(plan), /local-secret/);
});

test("storage migration script requires explicit execution opt-in", () => {
  const script = storageMigrationScript();
  assert.match(script, /AGENTFLOW_EXECUTE_STORAGE_MIGRATION/);
  assert.match(script, /TARGET_REDIS_URL/);
  assert.match(script, /pg_dump/);
  assert.match(script, /pg_restore/);
  assert.match(script, /mc mirror/);
});
