import path from "node:path";

/** Dependency mirrors are evidence inputs, never automatic product-repair roots.
 * Do not guess a replacement by basename: the operator must select a registered
 * owning project, where fresh policy/intent/approval checks apply.
 */
export function automaticRepairProjectAllowed(projectRoot: string): boolean {
  if (!path.isAbsolute(projectRoot)) return false;
  const segments = path.resolve(projectRoot).split(path.sep);
  return !segments.some((segment) => ["vendor", "node_modules"].includes(segment.toLowerCase()));
}
