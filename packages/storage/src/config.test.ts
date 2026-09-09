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
    DATABASE_URL: "postgres://agentflow:secret@192.0.2.10:15432/agentflow",
    REDIS_URL: "redis://192.0.2.10:16379",
    OBJECT_STORAGE_ENDPOINT: "http://192.0.2.10:19000"
  });

  assert.deepEqual(
    endpoints.map((endpoint) => [endpoint.name, endpoint.host, endpoint.port]),
    [
      ["Postgres + pgvector", "192.0.2.10", 15432],
      ["Redis", "192.0.2.10", 16379],
      ["MinIO object storage", "192.0.2.10", 19000]
    ]
  );
});

test("defaultServiceEndpoints supports explicit host overrides without urls", () => {
  const endpoints = defaultServiceEndpoints({
    AGENTFLOW_POSTGRES_HOST: "shared-host.example",
    AGENTFLOW_POSTGRES_PORT: "25432",
    AGENTFLOW_REDIS_HOST: "shared-host.example",
    AGENTFLOW_REDIS_PORT: "26379",
    AGENTFLOW_MINIO_HOST: "shared-host.example",
    AGENTFLOW_MINIO_PORT: "29000"
  });

  assert.deepEqual(
    endpoints.map((endpoint) => [endpoint.name, endpoint.host, endpoint.port]),
    [
      ["Postgres + pgvector", "shared-host.example", 25432],
      ["Redis", "shared-host.example", 26379],
      ["MinIO object storage", "shared-host.example", 29000]
    ]
  );
});

test("defaultServiceEndpoints supports a shared storage host fallback", () => {
  const endpoints = defaultServiceEndpoints({
    AGENTFLOW_SHARED_STORAGE_HOST: "192.0.2.10"
  });

  assert.deepEqual(
    endpoints.map((endpoint) => [endpoint.name, endpoint.host, endpoint.port]),
    [
      ["Postgres + pgvector", "192.0.2.10", 15432],
      ["Redis", "192.0.2.10", 16379],
      ["MinIO object storage", "192.0.2.10", 19000]
    ]
  );
});
