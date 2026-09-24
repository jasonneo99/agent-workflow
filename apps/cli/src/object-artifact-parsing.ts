import { normalizeLookup } from "./reference-resolution.js";

const objectReferenceKeyNames = new Set([
  "objectkey",
  "objectkeys",
  "objectpath",
  "storagekey",
  "storagepath",
  "s3key",
  "miniokey",
  "bucketkey"
]);

export function parseMcFindKeys(output: string, alias: string, bucket: string): string[] {
  const prefix = `${alias}/${bucket}/`;
  const keys = new Set<string>();
  for (const line of output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    let candidate = line;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      candidate = String(parsed.key ?? parsed.name ?? parsed.url ?? parsed.file ?? "");
    } catch {
      candidate = line;
    }
    const normalized = candidate.replace(/^file:\/\//, "").replace(prefix, "").replace(new RegExp(`^.*?/${escapeRegExp(bucket)}/`), "");
    if (normalized && normalized !== bucket) keys.add(normalized);
  }
  return [...keys].sort();
}

export function collectObjectReferences(value: unknown, pathPrefix = "content", depth = 0): Array<{ path: string; value: string }> {
  if (depth > 8) return [];
  if (typeof value === "string") return looksLikeObjectReference(value) ? [{ path: pathPrefix, value }] : [];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectObjectReferences(item, `${pathPrefix}[${index}]`, depth + 1));
  const refs: Array<{ path: string; value: string }> = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nestedPath = `${pathPrefix}.${key}`;
    if (typeof nested === "string" && objectReferenceKeyNames.has(normalizeLookup(key))) {
      refs.push({ path: nestedPath, value: nested });
      continue;
    }
    refs.push(...collectObjectReferences(nested, nestedPath, depth + 1));
  }
  return refs;
}

export function normalizeObjectArtifactKey(value: string, bucket: string): string {
  const trimmed = value.trim();
  if (/^(s3|r2|minio|object):\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const pathname = url.pathname.replace(/^\/+/, "");
      if (url.hostname === bucket) return pathname;
      return pathname || url.hostname;
    } catch {
      return trimmed.replace(/^(s3|r2|minio|object):\/\//i, "").replace(new RegExp(`^${escapeRegExp(bucket)}/`), "");
    }
  }
  return trimmed.replace(new RegExp(`^${escapeRegExp(bucket)}/`), "").replace(/^\/+/, "");
}

function looksLikeObjectReference(value: string): boolean {
  return /^(s3|r2|minio|object):\/\//i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
