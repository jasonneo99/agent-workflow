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
  assert.match(script, /Refusing to migrate/);
  assert.match(script, /TARGET_REDIS_URL/);
  assert.match(script, /pg_dump/);
  assert.match(script, /pg_restore/);
  assert.match(script, /mc mirror/);
});

test("storage migration plan can use the shared storage host env fallback", async () => {
  const plan = await buildStorageMigrationPlan({
    sourceEnv: {
      AGENTFLOW_SHARED_STORAGE_HOST: "100.78.183.30",
      DATABASE_URL: "postgres://agentflow:local-secret@127.0.0.1:15432/agentflow",
      REDIS_URL: "redis://127.0.0.1:16379",
      OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:19000",
      OBJECT_STORAGE_BUCKET: "agentflow-artifacts"
    },
    targetEnv: {}
  });

  assert.match(plan.target.databaseUrl, /100\.78\.183\.30:15432/);
  assert.match(plan.target.redisUrl, /100\.78\.183\.30:16379/);
  assert.equal(plan.target.objectStorageEndpoint, "http://100.78.183.30:19000/");
});

test("storage migration plan blocks same source and target endpoints", async () => {
  const plan = await buildStorageMigrationPlan({
    sourceEnv: {
      DATABASE_URL: "postgres://agentflow:local-secret@127.0.0.1:15432/agentflow",
      REDIS_URL: "redis://127.0.0.1:16379",
      OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:19000",
      OBJECT_STORAGE_BUCKET: "agentflow-artifacts"
    },
    targetHost: "127.0.0.1",
    targetEnv: {}
  });

  assert.equal(plan.status, "blocked");
  assert.match(plan.warnings.join("\n"), /same endpoint/);
});
