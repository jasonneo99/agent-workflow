import assert from "node:assert/strict";
import test from "node:test";
import { collectObjectReferences, normalizeObjectArtifactKey, parseMcFindKeys } from "./object-artifact-parsing.js";

test("parses JSON and plain mc listings with stable deduplication", () => {
  const output = [
    '{"key":"agentflow/bucket/z.json"}',
    "agentflow/bucket/a.json",
    '{"url":"s3://host/bucket/a.json"}',
    ""
  ].join("\r\n");
  assert.deepEqual(parseMcFindKeys(output, "agentflow", "bucket"), ["a.json", "z.json"]);
});

test("object listing parsing treats bucket names as literals", () => {
  assert.deepEqual(parseMcFindKeys("alias/bucket.+/nested/file.json", "alias", "bucket.+"), ["nested/file.json"]);
});

test("collects URI and recognized-key references with paths and a depth bound", () => {
  const value = { items: [{ storageKey: "plain/key.json" }, "s3://bucket/uri.json"], ignored: "plain text" };
  assert.deepEqual(collectObjectReferences(value), [
    { path: "content.items[0].storageKey", value: "plain/key.json" },
    { path: "content.items[1]", value: "s3://bucket/uri.json" }
  ]);
  let nested: unknown = "s3://bucket/too-deep.json";
  for (let index = 0; index < 10; index += 1) nested = { nested };
  assert.deepEqual(collectObjectReferences(nested), []);
});

test("normalizes object URIs, bucket prefixes, and malformed URI fallbacks", () => {
  assert.equal(normalizeObjectArtifactKey(" s3://bucket/path/item.json ", "bucket"), "path/item.json");
  assert.equal(normalizeObjectArtifactKey("object://other/path/item.json", "bucket"), "path/item.json");
  assert.equal(normalizeObjectArtifactKey("bucket/path/item.json", "bucket"), "path/item.json");
  assert.equal(normalizeObjectArtifactKey("s3://bucket/%", "bucket"), "%");
});
