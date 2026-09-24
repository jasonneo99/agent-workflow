import fs from "node:fs/promises";
import path from "node:path";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function detectPackageManager(projectDir: string, packageJson: Record<string, unknown> | null): Promise<string | undefined> {
  const packageManager = stringValue(packageJson?.packageManager);
  if (packageManager) {
    return packageManager.split("@")[0];
  }
  if (await exists(path.join(projectDir, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await exists(path.join(projectDir, "yarn.lock"))) {
    return "yarn";
  }
  if (await exists(path.join(projectDir, "bun.lockb")) || await exists(path.join(projectDir, "bun.lock"))) {
    return "bun";
  }
  if (await exists(path.join(projectDir, "package-lock.json"))) {
    return "npm";
  }
  return packageJson ? "npm" : undefined;
}

export function commandPrefixForPackageManager(packageManager: string | undefined): string {
  if (packageManager === "pnpm") {
    return "pnpm";
  }
  if (packageManager === "yarn") {
    return "yarn";
  }
  if (packageManager === "bun") {
    return "bun";
  }
  return "npm run";
}

export async function detectMarkers(projectDir: string): Promise<string[]> {
  const markerChecks: Array<[string, string]> = [
    ["package.json", "package-json"],
    ["tsconfig.json", "typescript"],
    ["next.config.js", "next"],
    ["next.config.mjs", "next"],
    ["vite.config.ts", "vite"],
    ["vite.config.js", "vite"],
    ["tailwind.config.ts", "tailwind"],
    ["tailwind.config.js", "tailwind"],
    ["components.json", "shadcn"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["manage.py", "django"],
    ["composer.json", "php"],
    ["wp-config.php", "wordpress"],
    ["index.html", "static-site"],
    ["Dockerfile", "docker"],
    ["docker-compose.yml", "docker-compose"],
    ["docker-compose.yaml", "docker-compose"]
  ];
  const markers: string[] = [];
  for (const [file, marker] of markerChecks) {
    if (await exists(path.join(projectDir, file)) && !markers.includes(marker)) {
      markers.push(marker);
    }
  }
  return markers;
}

export function detectFrameworks(dependencies: Record<string, unknown>, markers: string[]): string[] {
  const frameworks = new Set<string>();
  if (dependencies.next || markers.includes("next")) frameworks.add("next");
  if (dependencies.react || dependencies["@vitejs/plugin-react"]) frameworks.add("react");
  if (dependencies.vue || dependencies["@vitejs/plugin-vue"]) frameworks.add("vue");
  if (dependencies.svelte || dependencies["@sveltejs/kit"]) frameworks.add("svelte");
  if (dependencies.astro) frameworks.add("astro");
  if (dependencies.express) frameworks.add("express");
  if (dependencies.fastify) frameworks.add("fastify");
  if (markers.includes("vite")) frameworks.add("vite");
  if (markers.includes("tailwind")) frameworks.add("tailwind");
  if (markers.includes("shadcn")) frameworks.add("shadcn");
  if (markers.includes("django")) frameworks.add("django");
  if (markers.includes("wordpress")) frameworks.add("wordpress");
  if (markers.includes("static-site")) frameworks.add("static-site");
  if (markers.includes("docker") || markers.includes("docker-compose")) frameworks.add("docker");
  return [...frameworks];
}

export function detectLanguages(packageJson: Record<string, unknown> | null, markers: string[]): string[] {
  const languages = new Set<string>();
  if (packageJson) languages.add("javascript");
  if (markers.includes("typescript")) languages.add("typescript");
  if (markers.includes("python")) languages.add("python");
  if (markers.includes("php") || markers.includes("wordpress")) languages.add("php");
  if (markers.includes("static-site")) languages.add("html");
  return [...languages];
}
