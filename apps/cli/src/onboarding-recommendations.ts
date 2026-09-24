export function recommendCommands(scripts: Record<string, unknown>, commandPrefix: string, markers: string[]): string[] {
  const commands = new Set<string>();
  for (const script of ["test", "typecheck", "lint", "build", "check", "verify"]) {
    if (scripts[script]) commands.add(commandPrefix === "npm run" ? `npm run ${script}` : `${commandPrefix} ${script}`);
  }
  if (markers.includes("python")) commands.add("python -m pytest");
  if (markers.includes("php")) commands.add("composer test");
  return commands.size ? [...commands] : ["npm test", "npm run typecheck", "npm run lint"];
}

export function recommendContextIncludes(markers: string[], frameworks: string[], languages: string[]): string[] {
  const includes = new Set(["AGENTS.md", ".agent-workflow/**", "README.md", "docs/**"]);
  if (languages.includes("javascript") || languages.includes("typescript")) {
    ["package.json", "src/**", "app/**", "pages/**", "components/**", "lib/**", "test/**", "tests/**"].forEach((item) => includes.add(item));
  }
  if (languages.includes("python")) ["pyproject.toml", "requirements.txt", "**/*.py"].forEach((item) => includes.add(item));
  if (languages.includes("php") || frameworks.includes("wordpress")) ["composer.json", "wp-content/**", "**/*.php"].forEach((item) => includes.add(item));
  if (frameworks.includes("static-site")) ["index.html", "site/**", "assets/**"].forEach((item) => includes.add(item));
  if (markers.includes("docker") || markers.includes("docker-compose")) ["Dockerfile", "docker-compose.yml", "docker-compose.yaml"].forEach((item) => includes.add(item));
  return [...includes];
}

export function recommendContextExcludes(frameworks: string[], languages: string[]): string[] {
  const excludes = new Set([
    "node_modules/**", ".git/**", "dist/**", "build/**", "coverage/**", ".next/**", ".turbo/**", ".cache/**",
    ".agent-workflow/schedule-state.json", "**/*.jpg", "**/*.jpeg", "**/*.png", "**/*.webp", "**/*.gif", "**/*.woff", "**/*.woff2", "**/*.ttf"
  ]);
  if (languages.includes("python")) [".venv/**", "venv/**", "__pycache__/**"].forEach((item) => excludes.add(item));
  if (frameworks.includes("wordpress")) excludes.add("wp-content/uploads/**");
  return [...excludes];
}

export function recommendWritePaths(frameworks: string[], languages: string[]): string[] {
  const paths = new Set([".agent-workflow/**", "AGENTS.md", "README.md", "docs/**"]);
  if (languages.includes("javascript") || languages.includes("typescript")) ["src/**", "app/**", "pages/**", "components/**", "lib/**", "test/**", "tests/**", "package.json"].forEach((item) => paths.add(item));
  if (languages.includes("python")) ["**/*.py", "pyproject.toml", "requirements.txt", "tests/**"].forEach((item) => paths.add(item));
  if (languages.includes("php") || frameworks.includes("wordpress")) ["**/*.php", "wp-content/themes/**", "wp-content/plugins/**", "composer.json"].forEach((item) => paths.add(item));
  if (frameworks.includes("static-site")) ["index.html", "site/**", "assets/**"].forEach((item) => paths.add(item));
  return [...paths];
}

export function recommendAgents(frameworks: string[], languages: string[], markers: string[]): string[] {
  const agents = new Set(["technical-architect", "implementation-agent", "test-engineer", "docs-maintainer"]);
  if (frameworks.some((framework) => ["react", "next", "vite", "vue", "svelte", "astro", "tailwind", "shadcn", "static-site"].includes(framework))) {
    agents.add("frontend-engineer");
    agents.add("ux-reviewer");
  }
  if (frameworks.some((framework) => ["express", "fastify", "django"].includes(framework)) || languages.includes("php")) agents.add("backend-engineer");
  if (markers.includes("docker") || markers.includes("docker-compose")) agents.add("ci-debugger");
  agents.add("security-reviewer");
  return [...agents];
}

export function recommendWorkflows(frameworks: string[], _languages: string[], _markers: string[]): string[] {
  const workflows = new Set(["build-feature", "review-pr", "debug-failure", "maintain-context"]);
  if (frameworks.some((framework) => ["react", "next", "vite", "vue", "svelte", "astro", "static-site", "wordpress"].includes(framework))) workflows.add("production-readiness");
  return [...workflows];
}
