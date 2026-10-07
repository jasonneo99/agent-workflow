import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Hash only an explicitly enrolled scope, never inferred repository contents. */
export async function sourceSubjectHash(root: string, files: string[]): Promise<string> {
  if (!files.length || files.length > 1000 || new Set(files).size !== files.length) throw new Error("Invalid acceptance source scope.");
  const base = await fs.realpath(root);
  const manifest = [];
  let bytes = 0;
  for (const file of [...files].sort()) {
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/u).some((part) => part === ".." || part === "." || !part)) throw new Error("Acceptance source paths must be project-relative.");
    const target = path.resolve(base, file);
    if (!target.startsWith(base + path.sep) || await fs.realpath(target) !== target) throw new Error("Acceptance source symlinks are not allowed.");
    const stat = await fs.stat(target);
    bytes += stat.size;
    if (!stat.isFile() || bytes > 64 * 1024 * 1024) throw new Error("Acceptance source scope exceeds file limits.");
    const content = await fs.readFile(target);
    const after = await fs.stat(target);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino || stat.mode !== after.mode) throw new Error("Acceptance source changed during capture.");
    manifest.push({ path: file, mode: stat.mode & 0o777, hash: createHash("sha256").update(content).digest("hex") });
  }
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}
