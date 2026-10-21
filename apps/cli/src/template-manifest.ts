import fs from "node:fs/promises";
import path from "node:path";

type TemplateManifest = Record<string, unknown>;

export async function loadTemplateManifestEntries(templatesRoot: string, templateName: string): Promise<string[]> {
  const manifestPath = path.join(templatesRoot, "template-manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as TemplateManifest;
  const entries = manifest[templateName];
  if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => typeof entry !== "string" || entry.trim() !== entry || !entry)) {
    throw new Error(`Template manifest has no valid entry list for ${templateName}.`);
  }
  const stringEntries = entries as string[];
  const normalized = stringEntries.map((entry) => {
    if (entry.includes("\\") || path.posix.isAbsolute(entry) || path.posix.normalize(entry) !== entry || entry.split("/").some((part) => part === ".." || part === "")) {
      throw new Error(`Template manifest entry escapes ${templateName}: ${entry}`);
    }
    return entry.split("/").join(path.sep);
  });
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}
