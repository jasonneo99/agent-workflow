#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
if (status.status !== 0) {
  process.stderr.write(status.stderr);
  process.exit(status.status ?? 1);
}
if (status.stdout.trim()) {
  console.error("Publishing requires a clean Git checkout so every package input has reviewed provenance.");
  process.exit(1);
}
console.log("Publish checkout is clean; package provenance can be verified.");
