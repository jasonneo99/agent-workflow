import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

// Repository-owned test bootstrap, not the worker's cross-project environment.
// Load only the database setting; never import unrelated runtime credentials.
export function loadTestDatabaseEnvironment(root, env = process.env) {
  if (env.TEST_DATABASE_URL) { env.DATABASE_URL = env.TEST_DATABASE_URL; return; }
  if (env.DATABASE_URL) return;
  const projectEnv = path.join(root, ".agent-workflow", ".env");
  const files = [existsSync(projectEnv) ? projectEnv : path.join(root, ".env"), path.join(root, ".agent-workflow", "runtime.env")];
  let database;
  for (const file of files) {
    if (existsSync(file)) database = parse(readFileSync(file)).DATABASE_URL || database;
  }
  if (database) env.DATABASE_URL = database;
}

loadTestDatabaseEnvironment(process.cwd());
