import assert from "node:assert/strict";
import test from "node:test";
import { defaultServiceEndpoints } from "./config.js";

test("defaultServiceEndpoints uses local developer service ports by default", () => {
  const endpoints = defaultServiceEndpoints({});

  assert.deepEqual(
    endpoints.map((endpoint) => [endpoint.name, endpoint.host, endpoint.port]),
    [
      ["Postgres + pgvector", "127.0.0.1", 15432],
      ["Redis", "127.0.0.1", 16379],
      ["MinIO object storage", "127.0.0.1", 19000]
    ]
  );
});

test("defaultServiceEndpoints derives shared storage hosts from configured urls", () => {
  const endpoints = defaultServiceEndpoints({
    DATABASE_URL: "postgres://agentflow:secret@100.78.183.30:15432/agentflow",
    REDIS_URL: "redis://100.78.183.30:16379",
    OBJECT_STORAGE_ENDPOINT: "http://100.78.183.30:19000"
  });

  assert.deepEqual(
    endpoints.map((endpoint) => [endpoint.name, endpoint.host, endpoint.port]),
    [
      ["Postgres + pgvector", "100.78.183.30", 15432],
      ["Redis", "100.78.183.30", 16379],
      ["MinIO object storage", "100.78.183.30", 19000]
    ]
  );
});

test("defaultServiceEndpoints supports explicit host overrides without urls", () => {
  const endpoints = defaultServiceEndpoints({
    AGENTFLOW_POSTGRES_HOST: "hulk.local",
    AGENTFLOW_POSTGRES_PORT: "25432",
    AGENTFLOW_REDIS_HOST: "hulk.local",
    AGENTFLOW_REDIS_PORT: "26379",
    AGENTFLOW_MINIO_HOST: "hulk.local",
    AGENTFLOW_MINIO_PORT: "29000"
  });

  assert.deepEqual(
    endpoints.map((endpoint) => [endpoint.name, endpoint.host, endpoint.port]),
    [
      ["Postgres + pgvector", "hulk.local", 25432],
      ["Redis", "hulk.local", 26379],
      ["MinIO object storage", "hulk.local", 29000]
    ]
  );
});
